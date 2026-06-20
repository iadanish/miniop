# MiniOp Data Flow Architecture

## Overview

MiniOp processes video through a five-stage pipeline. Each stage produces artifacts stored in Cloudflare R2 (blobs) or Supabase (structured data). The pipeline is fully asynchronous — jobs are queued in PostgreSQL and polled by GPU workers.

```
Upload → Transcribe → Analyze → Rank/Select → Render → Deliver
  R2       R2+DB        DB         DB          R2       R2+CDN
```

## Stage 1: Ingestion

### URL-Based Ingestion

When a user pastes a YouTube/TikTok/etc. URL, the API Gateway creates a download job. The GPU worker (which has unrestricted bandwidth) performs the actual download — the serverless API never touches the video bytes.

```typescript
// API Gateway: create job for URL download
async function createIngestJob(userId: string, sourceUrl: string, projectId: string) {
  const video = await supabase.from("videos").insert({
    project_id: projectId,
    source_url: sourceUrl,
    status: "queued"
  }).select().single();

  await supabase.from("jobs").insert({
    video_id: video.data.id,
    job_type: "download",
    status: "pending",
    priority: 1,
    required_capability: "download",
    payload: JSON.stringify({ source_url: sourceUrl })
  });

  return video.data;
}
```

### File Upload Ingestion

For direct file uploads, the frontend obtains a presigned R2 URL and uploads directly — the video bytes never pass through our servers.

```
Browser ──(presigned PUT)──▶ Cloudflare R2
   │                              │
   │  (on complete)              │ (storage key)
   ▼                              ▼
Frontend API ──(create video record)──▶ Supabase
   │
   ▼
Frontend API ──(create job)──▶ Supabase jobs table
```

### Upload Chunking for Large Files

Videos over 100 MB use multipart upload to R2:

```typescript
// frontend/lib/upload-multipart.ts
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand } from "@aws-sdk/client-s3";

const PART_SIZE = 10 * 1024 * 1024; // 10 MB chunks

export async function multipartUpload(file: File, key: string, onProgress: (pct: number) => void) {
  const s3 = getR2Client();

  const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    ContentType: file.type,
  }));

  const parts: { PartNumber: number; ETag: string }[] = [];
  const totalParts = Math.ceil(file.size / PART_SIZE);

  for (let i = 0; i < totalParts; i++) {
    const start = i * PART_SIZE;
    const end = Math.min(start + PART_SIZE, file.size);
    const chunk = file.slice(start, end);

    const { ETag } = await s3.send(new UploadPartCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      PartNumber: i + 1,
      UploadId,
      Body: chunk,
    }));

    parts.push({ PartNumber: i + 1, ETag: ETag! });
    onProgress(((i + 1) / totalParts) * 100);
  }

  await s3.send(new CompleteMultipartUploadCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    UploadId,
    MultipartUpload: { Parts: parts },
  }));
}
```

## Stage 2: Transcription

The GPU worker downloads the source video from R2 (via presigned URL) and runs Whisper.

### Data Flow

```
GPU Worker
  │
  ├─ GET presigned R2 URL ──▶ R2 (download source video)
  │
  ├─ Whisper transcription (GPU)
  │    Input: video file (audio track extracted via ffmpeg)
  │    Output: segments[] with { start, end, text, words[] }
  │
  ├─ POST results ──▶ API Gateway
  │    Body: { job_id, transcription: { language, duration, segments[] } }
  │
  └─ API Gateway stores:
       ├─ videos.status = "transcribed"
       ├─ videos.duration_seconds = N
       └─ jobs.result = transcription JSON
```

### Transcription Data Schema

The transcription result stored in `jobs.result` (JSONB column):

```json
{
  "language": "en",
  "language_probability": 0.98,
  "duration": 1847.3,
  "segments": [
    {
      "start": 0.0,
      "end": 4.2,
      "text": "Welcome back to the channel everybody",
      "words": [
        { "word": "Welcome", "start": 0.0, "end": 0.4, "probability": 0.99 },
        { "word": "back", "start": 0.5, "end": 0.8, "probability": 0.97 }
      ]
    }
  ]
}
```

### Transcription Caching

Transcriptions are expensive (GPU time) and deterministic (same video + same model = same output). We cache by content hash:

```python
# GPU worker: check cache before processing
import hashlib

def get_content_hash(video_url: str) -> str:
    """Hash the first and last 1MB of the video for cache lookup."""
    resp = requests.get(video_url, headers={"Range": "bytes=0-1048575"})
    first_mb = resp.content
    resp = requests.get(video_url, headers={"Range": "bytes=-1048575"})
    last_mb = resp.content
    return hashlib.sha256(first_mb + last_mb).hexdigest()[:32]

def transcribe_with_cache(video_url: str, model_name: str):
    content_hash = get_content_hash(video_url)
    cache_key = f"{content_hash}:{model_name}"

    # Check Supabase cache table
    cached = requests.get(f"{API_BASE}/api/cache/{cache_key}").json()
    if cached.get("result"):
        return cached["result"]  # Cache hit — zero GPU cost

    result = transcribe_video(video_url)
    requests.post(f"{API_BASE}/api/cache/{cache_key}", json={"result": result})
    return result
```

## Stage 3: Analysis

The Analysis Service takes transcription segments and identifies the best clip candidates. This stage runs two complementary analysis pipelines on the GPU worker: (1) text/semantic analysis using Mistral 7B (free tier) or GPT-3.5-turbo (scaled tier), and (2) visual analysis using CLIP to score visual-text alignment. Both signals feed into the virality scorer.

### Data Flow

```
GPU Worker (after transcription)
  │
  ├─ Load transcription segments from job result
  │
  ├─ Segment chunking: split into overlapping windows (30-60 seconds each)
  │    Windows overlap by 5 seconds to avoid cutting mid-sentence
  │
  ├─ For each window:
  │    ├─ Extract text content
  │    ├─ Score virality (LLM call)
  │    ├─ Generate title
  │    └─ Suggest optimal clip boundaries (adjust to sentence boundaries)
  │
  ├─ Rank all candidates by virality_score
  │
  └─ POST top 10 candidates ──▶ API Gateway
       Body: { job_id, highlights: [{ start, end, title, score, clip_type }] }
```

### Windowing Algorithm

```python
# services/analysis/windowing.py
def create_windows(segments: list[dict], window_sec: float = 45, overlap_sec: float = 5) -> list[dict]:
    """Create overlapping time windows aligned to segment boundaries."""
    if not segments:
        return []

    total_duration = segments[-1]["end"]
    windows = []
    current_start = 0.0

    while current_start < total_duration:
        window_end = current_start + window_sec

        # Find segments that fall within this window
        window_segments = [
            seg for seg in segments
            if seg["end"] > current_start and seg["start"] < window_end
        ]

        if window_segments:
            # Snap window boundaries to nearest sentence end
            actual_start = find_nearest_sentence_end(segments, current_start, direction="forward")
            actual_end = find_nearest_sentence_end(segments, window_end, direction="backward")

            windows.append({
                "start": actual_start,
                "end": actual_end,
                "segments": window_segments,
                "text": " ".join(s["text"].strip() for s in window_segments)
            })

        current_start += window_sec - overlap_sec

    return windows

def find_nearest_sentence_end(segments, target_time, direction="forward", max_search=5.0):
    """Find the closest sentence boundary to target_time."""
    for seg in segments:
        text = seg["text"].strip()
        if direction == "forward" and seg["start"] >= target_time:
            if text.endswith(('.', '!', '?', '。', '！', '？')):
                return seg["end"]
        elif direction == "backward" and seg["end"] <= target_time:
            if text.endswith(('.', '!', '?', '。', '！', '？')):
                return seg["end"]
    return target_time  # Fallback: use original time
```

### Virality Scoring Prompt

```python
VIRALITY_PROMPT = """You are a viral content analyst for short-form video (TikTok, YouTube Shorts, Instagram Reels).

Analyze this transcript window and rate its potential as a standalone short clip.

Transcript:
{transcript}

Return a JSON object with:
- virality_score: float 0.0-1.0
  - 1.0: Extremely viral (strong hook, emotional, controversial, surprising)
  - 0.7+: Good clip (clear value, engaging, shareable)
  - 0.4-0.7: Decent (interesting but needs strong editing)
  - <0.4: Poor (boring, no hook, requires context)
- hook_strength: float 0.0-1.0 (how strong is the first 3 seconds)
- emotional_valence: "positive" | "negative" | "neutral" | "mixed"
- suggested_title: string (max 60 chars, clickbait-style)
- clip_type: "story" | "tip" | "reaction" | "question" | "controversy" | "humor" | "educational"
- suggested_trim_start: float (seconds into window, skip slow intros)
- suggested_trim_end: float (seconds from end, cut trailing silence)

Return ONLY valid JSON."""
```

## Stage 4: Clip Selection and Refinement

The API Gateway receives analysis results and creates clip records. The user sees ranked clips in their dashboard.

### Automatic Clip Boundary Refinement

```python
# services/analysis/boundary_refinement.py
def refine_boundaries(highlight: dict, segments: list[dict]) -> dict:
    """Adjust clip start/end to natural speech boundaries."""
    start = highlight["start"] + highlight.get("suggested_trim_start", 0)
    end = highlight["end"] - highlight.get("suggested_trim_end", 0)

    # Find the segment containing the start time
    for seg in segments:
        if seg["start"] <= start <= seg["end"]:
            # Start at the beginning of this sentence, not mid-word
            start = seg["start"]
            break

    # Find the segment containing the end time
    for seg in reversed(segments):
        if seg["start"] <= end <= seg["end"]:
            # End at the end of this sentence
            end = seg["end"]
            break

    # Ensure minimum duration of 15 seconds
    if end - start < 15:
        # Extend backward
        for seg in segments:
            if seg["start"] < start:
                start = seg["start"]
                if end - start >= 15:
                    break

    return {**highlight, "start": start, "end": end}
```

### User Interaction: Clip Review

The frontend receives clips via Supabase Realtime and presents them for review:

```typescript
// frontend/app/project/[id]/page.tsx
export default function ProjectPage({ params }: { params: { id: string } }) {
  const videos = useVideos(params.id);

  return (
    <div>
      {videos.map((video) => (
        <VideoCard key={video.id} video={video} />
      ))}
    </div>
  );
}

function VideoCard({ video }: { video: Video }) {
  const clips = useVideoUpdates(video.id); // Realtime subscription

  return (
    <div>
      <h3>{video.source_url}</h3>
      <div className="grid grid-cols-3 gap-4">
        {clips
          .sort((a, b) => b.virality_score - a.virality_score)
          .map((clip) => (
            <ClipPreview key={clip.id} clip={clip} />
          ))}
      </div>
    </div>
  );
}

function ClipPreview({ clip }: { clip: Clip }) {
  const renderClip = async () => {
    await fetch(`/api/clips/${clip.id}/render`, { method: "POST" });
  };

  return (
    <div className="border rounded p-2">
      <p className="text-sm font-bold">{clip.title}</p>
      <p className="text-xs text-gray-500">
        Score: {(clip.virality_score * 100).toFixed(0)}% | {clip.clip_type}
      </p>
      <p className="text-xs">{formatTime(clip.start_time)} - {formatTime(clip.end_time)}</p>
      <button onClick={renderClip} className="mt-2 bg-blue-500 text-white px-3 py-1 rounded text-sm">
        Render Clip
      </button>
    </div>
  );
}
```

## Stage 5: Rendering and Delivery

### Rendering Data Flow

```
User clicks "Render Clip"
  │
  ▼
Frontend POST /api/clips/:id/render
  │
  ▼
API Gateway creates render job in Supabase
  │
  ▼
GPU Worker picks up render job
  ├─ Downloads source video from R2 (presigned URL)
  ├─ Downloads transcription data from job result
  ├─ Runs FFmpeg: trim + crop + burn captions
  ├─ Uploads rendered clip to R2: clips/{video_id}/{clip_id}.mp4
  └─ Reports completion to API Gateway
  │
  ▼
API Gateway updates clip record:
  ├─ clips.status = "done"
  └─ clips.storage_key = "clips/{video_id}/{clip_id}.mp4"
  │
  ▼
Supabase Realtime pushes update to frontend
  │
  ▼
User sees clip ready for download/share
```

### Delivery: Presigned Download URLs

Clips are served via R2 presigned URLs (no bandwidth charges):

```typescript
// API Gateway: generate download URL
async function getClipDownloadUrl(clipId: string, userId: string): Promise<string> {
  const clip = await supabase.from("clips").select("storage_key").eq("id", clipId).single();

  if (!clip.data?.storage_key) throw new Error("Clip not rendered yet");

  const command = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: clip.data.storage_key,
  });

  return getSignedUrl(getR2Client(), command, { expiresIn: 3600 });
}
```

### Delivery: Direct Streaming via Cloudflare CDN

For embedded playback, clips are served through Cloudflare's CDN with cache headers:

```typescript
// Cloudflare Worker: serve clip with CDN caching
router.get("/clips/:id/stream", async (request, env) => {
  const clipId = request.params.id;
  const clip = await env.DB.prepare("SELECT storage_key FROM clips WHERE id = ?").bind(clipId).first();

  if (!clip?.storage_key) return new Response("Not found", { status: 404 });

  const object = await env.R2.get(clip.storage_key);
  if (!object) return new Response("Not found", { status: 404 });

  return new Response(object.body, {
    headers: {
      "Content-Type": "video/mp4",
      "Cache-Control": "public, max-age=86400", // Cache for 24 hours
      "Accept-Ranges": "bytes",
    },
  });
});
```

## Data Volume Estimates

### Per-Video Data Sizes

| Artifact | Storage | Location | Retention |
|----------|---------|----------|-----------|
| Source video | 200 MB – 2 GB | R2 | 30 days (free), 90 days (pro) |
| Transcription JSON | 50–500 KB | Supabase (jobs.result) | Permanent |
| Analysis results | 5–20 KB | Supabase (jobs.result) | Permanent |
| Rendered clip (1080p) | 10–50 MB | R2 | 30 days (free), 90 days (pro) |
| Rendered clip (720p) | 5–25 MB | R2 | 30 days (free), 90 days (pro) |

### Monthly Storage Projection (Free Tier)

```
200 clips/month average:
  Source videos: 200 × 500 MB = 100 GB (after cleanup: ~10 GB active)
  Transcriptions: 200 × 200 KB = 40 MB
  Rendered clips: 200 × 20 MB = 4 GB
  Total R2 active storage: ~14 GB (slightly over free tier — need lifecycle rules)
```

### R2 Lifecycle Rules

```json
{
  "rules": [
    {
      "id": "delete-old-uploads",
      "enabled": true,
      "path": "uploads/*",
      "actions": { "type": "Delete" },
      "conditions": {
        "maxAgeDays": 7
      }
    },
    {
      "id": "archive-old-clips",
      "enabled": true,
      "path": "clips/*",
      "actions": { "type": "Transition", "storageClass": "InfrequentAccess" },
      "conditions": {
        "maxAgeDays": 30
      }
    }
  ]
}
```

## Data Consistency and Error Handling

### Job State Machine

```
pending → processing → done
    │         │
    │         ▼
    │      failed (retry up to 3 times)
    │         │
    │         ▼
    └──── retrying → processing
              │
              ▼
           permanently_failed
```

### Retry Logic in GPU Worker

```python
# services/common/retry.py
def process_job_with_retry(job: dict, processor: callable, max_retries: int = 3):
    attempt = job.get("retry_count", 0)
    try:
        result = processor(job)
        report_success(job["id"], result)
    except Exception as e:
        if attempt < max_retries:
            report_retry(job["id"], attempt + 1, str(e))
        else:
            report_permanent_failure(job["id"], str(e))
```

### Dead Letter Queue

Permanently failed jobs are moved to a dead letter view for manual inspection:

```sql
CREATE VIEW dead_letter_queue AS
SELECT j.*, v.source_url, v.storage_key as video_key
FROM jobs j
JOIN videos v ON j.video_id = v.id
WHERE j.status = 'permanently_failed'
ORDER BY j.updated_at DESC;
```
