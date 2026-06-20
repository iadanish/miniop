# MiniOp Microservices Design

## Service Decomposition

MiniOp is decomposed into six services, each deployable and scalable independently. The free tier runs most of these on serverless platforms (zero idle cost), while the scaled tier replaces GPU-bound services with persistent workers.

| Service | Runtime | Free Tier Host | Scaled Host |
|---------|---------|---------------|-------------|
| Frontend | Next.js 14 | Vercel | Vercel |
| API Gateway | Cloudflare Worker | Cloudflare (free) | Cloudflare (paid) |
| Transcription Service | Python + Whisper | Colab/Kaggle notebook | RunPod Serverless |
| Analysis Service | Python + LLM | Colab/Kaggle notebook | RunPod Serverless |
| Rendering Service | Python + FFmpeg | Colab/Kaggle notebook | RunPod Serverless |
| Database & Auth | PostgreSQL + GoTrue | Supabase (free) | Supabase Pro |

## Service 1: Frontend (Next.js)

The frontend is a Next.js 14 App Router application handling authentication, project management, video upload, clip review, and export.

### Key Endpoints and Pages

```
/app
  /dashboard        — Project list, usage stats
  /project/[id]     — Video list, clip gallery
  /upload           — URL input, file upload with progress
  /clips/[videoId]  — Clip editor: trim, reframe, edit captions
  /export/[clipId]  — Download, share link, social publishing
/api
  /upload/presign   — Generate R2 presigned upload URL
  /clips/[id]/render — Trigger clip rendering
  /export/[id]      — Generate export with selected format
```

### Upload Flow Implementation

```typescript
// frontend/app/api/upload/presign/route.ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

export async function POST(req: Request) {
  const { filename, contentType } = await req.json();
  const key = `uploads/${crypto.randomUUID()}/${filename}`;

  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });

  const presignedUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });

  return Response.json({ uploadUrl: presignedUrl, key });
}
```

The frontend uses `tus` for resumable uploads of large video files:

```typescript
// frontend/components/VideoUpload.tsx
"use client";
import * as tus from "tus-js-client";

export function VideoUpload({ projectId }: { projectId: string }) {
  const handleUpload = (file: File) => {
    const upload = new tus.Upload(file, {
      endpoint: "/api/upload/tus",
      retryDelays: [0, 3000, 5000, 10000],
      metadata: { filename: file.name, filetype: file.type, projectId },
      onProgress: (bytesUploaded, bytesTotal) => {
        const pct = ((bytesUploaded / bytesTotal) * 100).toFixed(1);
        console.log(`${pct}% (${bytesUploaded}/${bytesTotal})`);
      },
      onSuccess: () => {
        console.log("Upload complete:", upload.url);
        // Trigger processing job via API
      },
    });
    upload.findPreviousUploads().then((prev) => {
      if (prev.length) upload.resumeFromPrevUpload(prev[0]);
      upload.start();
    });
  };

  return <input type="file" accept="video/*" onChange={(e) => e.target.files?.[0] && handleUpload(e.target.files[0])} />;
}
```

## Service 2: API Gateway (Cloudflare Worker)

The API Gateway is a single Cloudflare Worker that handles authentication, request validation, rate limiting, and routing to Supabase. It does NOT process video — it only manages the job queue and serves metadata.

### Routing Structure

```typescript
// worker-api/src/index.ts
import { Router } from "itty-router";

const router = Router();

// Auth middleware
router.all("/api/*", async (request, env) => {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return new Response("Unauthorized", { status: 401 });
  const user = await verifySupabaseToken(token, env);
  if (!user) return new Response("Unauthorized", { status: 401 });
  request.user = user;
});

// Rate limiting (100 requests/minute on free tier)
router.all("/api/*", async (request, env) => {
  const key = `ratelimit:${request.user.id}`;
  const current = await env.KV.get(key);
  if (current && parseInt(current) > 100) {
    return new Response("Rate limit exceeded", { status: 429 });
  }
  await env.KV.put(key, String((parseInt(current || "0") + 1)), { expirationTtl: 60 });
});

// Video endpoints
router.post("/api/videos", createVideo);
router.get("/api/videos/:id", getVideo);
router.get("/api/videos/:id/clips", getVideoClips);

// Job management
router.post("/api/jobs", createJob);
router.get("/api/jobs/:id", getJobStatus);

// Worker management (for GPU workers)
router.post("/api/worker/poll", workerPoll);
router.post("/api/worker/complete", workerComplete);

// Webhook for Supabase Realtime
router.post("/api/webhooks/realtime", handleRealtimeWebhook);

export default { fetch: router.handle };
```

### Rate Limiting with Cloudflare KV

```typescript
// worker-api/src/middleware/rateLimit.ts
export async function rateLimit(request: Request, env: Env): Promise<Response | null> {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = `rl:${request.user?.id || ip}`;
  const window = 60; // seconds
  const limit = request.user?.tier === "pro" ? 1000 : 100;

  const current = await env.RATE_LIMIT_KV.get(key, { type: "json" }) as { count: number; reset: number } | null;
  const now = Math.floor(Date.now() / 1000);

  if (!current || now > current.reset) {
    await env.RATE_LIMIT_KV.put(key, JSON.stringify({ count: 1, reset: now + window }), { expirationTtl: window + 10 });
    return null; // allowed
  }

  if (current.count >= limit) {
    return new Response(JSON.stringify({ error: "Rate limit exceeded", retryAfter: current.reset - now }), {
      status: 429,
      headers: { "Retry-After": String(current.reset - now) }
    });
  }

  await env.RATE_LIMIT_KV.put(key, JSON.stringify({ count: current.count + 1, reset: current.reset }), { expirationTtl: window + 10 });
  return null; // allowed
}
```

## Service 3: Transcription Service

Runs Whisper (faster-whisper) to produce timestamped transcriptions. This is the heaviest GPU consumer.

### Free Tier: Colab/Kaggle Notebook

```python
# services/transcription/notebook_worker.py
import requests
import tempfile
import subprocess
from faster_whisper import WhisperModel

API_BASE = "https://your-worker.workers.dev"
WORKER_ID = "transcription-colab-01"

model = WhisperModel("base", device="cuda", compute_type="float16")

def transcribe_video(video_url: str, job_id: str):
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
        subprocess.run(["wget", "-O", tmp.name, video_url], check=True)
        segments, info = model.transcribe(
            tmp.name,
            beam_size=5,
            word_timestamps=True,
            vad_filter=True,
            language=None  # auto-detect
        )
        result = {
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
            "segments": [
                {
                    "start": seg.start,
                    "end": seg.end,
                    "text": seg.text,
                    "words": [
                        {"word": w.word, "start": w.start, "end": w.end, "probability": w.probability}
                        for w in (seg.words or [])
                    ]
                }
                for seg in segments
            ]
        }
        return result
```

### Scaled: RunPod Serverless

```python
# services/transcription/runpod_handler.py
import runpod
from faster_whisper import WhisperModel

model = WhisperModel("large-v3", device="cuda", compute_type="float16")

def handler(job):
    input_data = job["input"]
    video_url = input_data["video_url"]
    config = input_data.get("config", {})

    # Download video (RunPod has /tmp storage)
    import subprocess
    subprocess.run(["wget", "-O", "/tmp/input.mp4", video_url], check=True)

    segments, info = model.transcribe(
        "/tmp/input.mp4",
        beam_size=5,
        word_timestamps=True,
        vad_filter=config.get("vad_filter", True),
        language=config.get("language", None)
    )

    return {
        "language": info.language,
        "duration": info.duration,
        "segments": [{"start": s.start, "end": s.end, "text": s.text} for s in segments]
    }

runpod.serverless.start({"handler": handler})
```

## Service 4: Analysis Service

Uses complementary AI models to analyze transcription segments and visual content. Mistral 7B (free tier) or GPT-3.5-turbo (scaled tier) handles text/semantic analysis for virality scoring, title generation, and clip boundary suggestion. CLIP handles visual analysis to score visual-text alignment and visual dynamics. Both signals feed into the final virality score.

### Prompt Engineering for Virality Scoring

```python
# services/analysis/virality.py
import requests

def score_segments(transcript_segments: list[dict], video_metadata: dict) -> list[dict]:
    # Batch segments into chunks that fit context window
    chunks = batch_segments(transcript_segments, max_tokens=3000)

    scored = []
    for chunk in chunks:
        prompt = f"""Analyze these video transcript segments for viral potential.

Video topic: {video_metadata.get('title', 'Unknown')}
Platform: TikTok/YouTube Shorts/Instagram Reels

For each segment, return:
- virality_score: 0.0-1.0 (hook strength, emotional impact, completeness, shareability)
- suggested_title: Short catchy title for the clip
- clip_type: one of [story, tip, reaction, question, controversy, humor]

Segments:
{format_segments(chunk)}

Return JSON array only."""

        response = call_llm(prompt, model="mistral-7b-instruct")  # or gpt-3.5-turbo on scaled tier
        scored.extend(parse_llm_response(response))

    # Sort by virality and select top clips
    scored.sort(key=lambda x: x["virality_score"], reverse=True)
    return scored[:10]  # Top 10 clips
```

### LLM Routing by Tier

```python
# services/analysis/llm_router.py
def call_llm(prompt: str, model: str = "auto") -> str:
    if model == "auto":
        model = select_model_by_tier()

    if model == "mistral-7b-instruct":
        # Free tier: run locally on Colab GPU alongside Whisper
        return call_local_mistral(prompt)
    elif model == "gpt-3.5-turbo":
        # Scaled tier: OpenAI API ($0.001/1K tokens)
        return call_openai(prompt, model="gpt-3.5-turbo")
    elif model == "gpt-4o-mini":
        # High quality: OpenAI API
        return call_openai(prompt, model="gpt-4o-mini")

def call_local_mistral(prompt: str) -> str:
    # Uses the same GPU as Whisper — loaded after transcription completes
    from transformers import AutoTokenizer, AutoModelForCausalLM
    tokenizer = AutoTokenizer.from_pretrained("mistralai/Mistral-7B-Instruct-v0.2")
    model = AutoModelForCausalLM.from_pretrained("mistralai/Mistral-7B-Instruct-v0.2", device_map="auto")
    inputs = tokenizer(prompt, return_tensors="pt").to("cuda")
    outputs = model.generate(**inputs, max_new_tokens=1024)
    return tokenizer.decode(outputs[0], skip_special_tokens=True)
```

## Service 5: Rendering Service

Takes clip start/end timestamps and produces the final video file with captions burned in, vertical reframing, and optional background music.

### FFmpeg-Based Rendering Pipeline

```python
# services/renderer/clip_renderer.py
import subprocess
import json
from pathlib import Path

def render_clip(
    source_video: str,
    start_time: float,
    end_time: float,
    transcript_segments: list[dict],
    output_path: str,
    aspect_ratio: str = "9:16",  # Vertical for shorts
    caption_style: str = "tiktok"
) -> str:
    duration = end_time - start_time

    # Build ASS subtitle file from transcript
    ass_path = generate_ass_subtitles(
        transcript_segments,
        start_time=start_time,
        end_time=end_time,
        style=caption_style
    )

    # FFmpeg filter chain: crop to vertical + burn subtitles
    if aspect_ratio == "9:16":
        vf_filters = [
            f"crop=ih*9/16:ih:iw/2-ih*9/16/2:0",  # Center crop to 9:16
            f"subtitles={ass_path}:force_style='FontSize=22,PrimaryColour=&H00FFFFFF'"
        ]
    else:
        vf_filters = [
            f"subtitles={ass_path}:force_style='FontSize=20,PrimaryColour=&H00FFFFFF'"
        ]

    cmd = [
        "ffmpeg", "-y",
        "-ss", str(start_time),
        "-i", source_video,
        "-t", str(duration),
        "-vf", ",".join(vf_filters),
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        output_path
    ]

    subprocess.run(cmd, check=True, capture_output=True)
    return output_path

def generate_ass_subtitles(segments, start_time, end_time, style="tiktok"):
    """Generate ASS subtitle file with word-level highlighting."""
    lines = []
    lines.append("[Script Info]")
    lines.append("Title: MiniOp Captions")
    lines.append("ScriptType: v4.00+")
    lines.append("[V4+ Styles]")
    lines.append("Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,Bold,Italic,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding")
    lines.append("Style: Default,Arial,48,&H00FFFFFF,&H000000FF,-1,0,1,3,0,2,10,10,30,1")
    lines.append("[Events]")
    lines.append("Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text")

    for seg in segments:
        if seg["end"] < start_time or seg["start"] > end_time:
            continue
        s = max(seg["start"] - start_time, 0)
        e = min(seg["end"] - start_time, end_time - start_time)
        text = seg["text"].strip()
        lines.append(f"Dialogue: 0,{format_ass_time(s)},{format_ass_time(e)},Default,,0,0,0,,{text}")

    ass_path = "/tmp/captions.ass"
    Path(ass_path).write_text("\n".join(lines))
    return ass_path
```

## Service 6: Database & Auth (Supabase)

Supabase provides PostgreSQL, GoTrue authentication, Row Level Security, and Realtime subscriptions.

### Row Level Security Policies

```sql
-- Users can only see their own projects
CREATE POLICY "Users see own projects" ON projects
  FOR ALL USING (auth.uid() = user_id);

-- Users can only see videos in their projects
CREATE POLICY "Users see own videos" ON videos
  FOR ALL USING (
    project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  );

-- Users can only see clips from their videos
CREATE POLICY "Users see own clips" ON clips
  FOR ALL USING (
    video_id IN (
      SELECT v.id FROM videos v
      JOIN projects p ON v.project_id = p.id
      WHERE p.user_id = auth.uid()
    )
  );

-- Workers can read/update jobs assigned to them
CREATE POLICY "Workers manage assigned jobs" ON jobs
  FOR ALL USING (worker_id = current_setting('app.worker_id', true));
```

### Realtime Subscriptions (Frontend)

```typescript
// frontend/hooks/useVideoUpdates.ts
import { createClient } from "@supabase/supabase-js";
import { useEffect, useState } from "react";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

export function useVideoUpdates(videoId: string) {
  const [clips, setClips] = useState<any[]>([]);

  useEffect(() => {
    // Initial fetch
    supabase.from("clips").select("*").eq("video_id", videoId).then(({ data }) => {
      if (data) setClips(data);
    });

    // Subscribe to changes
    const channel = supabase
      .channel(`clips:${videoId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "clips", filter: `video_id=eq.${videoId}` }, (payload) => {
        if (payload.eventType === "INSERT") {
          setClips((prev) => [...prev, payload.new]);
        } else if (payload.eventType === "UPDATE") {
          setClips((prev) => prev.map((c) => (c.id === payload.new.id ? payload.new : c)));
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [videoId]);

  return clips;
}
```

## Inter-Service Communication

Services communicate through three patterns:

1. **Synchronous HTTP**: Frontend → API Gateway → Supabase (for reads/queries)
2. **Job Queue**: API Gateway → Supabase `jobs` table → GPU Workers poll (for async processing)
3. **Realtime Push**: Supabase → Frontend via WebSocket (for status updates)

There are no service-to-service HTTP calls during processing. The GPU worker reads a job, processes it, and writes results back — pure queue-based decoupling.

## Free Tier vs Scaled: Service-Level Differences

| Service | Free Tier | Scaled ($50–100/mo) |
|---------|-----------|---------------------|
| Transcription | Colab notebook, `base` model | RunPod, `large-v3` model |
| Analysis | Local Mistral 7B on Colab | GPT-3.5-turbo API ($0.001/1K tokens) |
| Rendering | Colab FFmpeg, CPU-limited | RunPod FFmpeg with GPU-accelerated encoding |
| API Gateway | 100K req/day, basic rate limiting | Unlimited, advanced rate limiting |
| Database | 500 MB, no read replicas | 8 GB, point-in-time recovery |

The services themselves don't change — only their deployment targets and model sizes scale up.
