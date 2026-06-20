# MiniOp System Architecture Overview

## What MiniOp Does

MiniOp is an open-source video repurposing platform that takes long-form video and produces short, viral-ready clips — similar to Opus Clip. It analyzes video content using AI models to identify engaging moments, ranks them by virality potential, and outputs clips with captions, reframing, and metadata. The system processes video through a multi-stage pipeline: transcription → scene analysis → highlight extraction → caption generation → rendering.

## Free Tier Architecture (~200–500 clips/month)

The free tier runs on a zero-cost serverless-first stack. The bottleneck is GPU compute, which is sourced from Google Colab (~4-12 hrs/session, variable availability) and Kaggle (30 hrs/week guaranteed). Everything else is free-tier cloud:

| Layer | Service | Free Limit | Role |
|-------|---------|------------|------|
| Frontend | Vercel | 100 GB bandwidth | Next.js app |
| API Gateway | Supabase Edge Functions | 500K invocations | Auth, routing, rate limiting, job dispatch |
| Database | Supabase | 500 MB | PostgreSQL + auth |
| Object Storage | Cloudflare R2 | 10 GB | Video/audio/blob storage |
| GPU Compute | Google Colab | ~4-12 hrs/session | Whisper, LLM analysis |
| GPU Compute | Kaggle | 30 hrs/week | Whisper, LLM analysis |

### Request Flow (Free Tier)

```
User uploads URL/file
  → Vercel frontend sends to Supabase Edge Function
  → Edge Function validates, creates job in Supabase
  → Colab/Kaggle notebook polls Edge Function for jobs
  → Downloads source video to R2
  → Notebook runs Whisper transcription + LLM analysis
  → Results written back to Supabase (metadata) and R2 (clips)
  → Frontend polls / subscribes via Supabase Realtime
  → User sees clips appear in dashboard
```

### Notebook-Based GPU Workers

The free tier has no persistent GPU servers. Instead, Python notebooks run on Colab/Kaggle with a polling pattern:

```python
# worker_notebook.py — runs inside Google Colab or Kaggle
import requests
import time
import torch
from faster_whisper import WhisperModel

WORKER_ID = "colab-worker-01"
API_BASE = "https://your-worker.your-subdomain.workers.dev"
POLL_INTERVAL = 15  # seconds

model = WhisperModel("base", device="cuda" if torch.cuda.is_available() else "cpu")

def poll_for_jobs():
    while True:
        resp = requests.post(f"{API_BASE}/api/worker/poll", json={
            "worker_id": WORKER_ID,
            "capabilities": ["whisper", "scene_detect"]
        })
        if resp.status_code == 200 and resp.json().get("job"):
            job = resp.json()["job"]
            process_job(job)
        time.sleep(POLL_INTERVAL)

def process_job(job):
    video_url = job["source_url"]
    # Download, transcribe, analyze...
    transcription = transcribe(video_url)
    highlights = analyze_highlights(transcription, job["video_id"])
    # Report results back
    requests.post(f"{API_BASE}/api/worker/complete", json={
        "job_id": job["id"],
        "worker_id": WORKER_ID,
        "transcription": transcription,
        "highlights": highlights
    })

poll_for_jobs()
```

On the free tier, a Supabase Edge Function manages the queue:

```typescript
// supabase/functions/worker-poll/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  const { worker_id, capabilities } = await req.json();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  const { data: job } = await supabase
    .from("jobs")
    .update({ status: "processing", worker_id, updated_at: new Date().toISOString() })
    .eq("status", "pending")
    .in("required_capability", capabilities)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .select()
    .single();

  if (!job) {
    return new Response(JSON.stringify({ job: null }));
  }

  return new Response(JSON.stringify({ job }));
});
```

At scale, Cloudflare Workers replace Edge Functions for the API gateway (see Scaled Production section below).

### Supabase Schema (Core Tables)

```sql
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  source_url TEXT,
  storage_key TEXT,
  duration_seconds INT,
  status TEXT DEFAULT 'uploaded', -- uploaded | processing | done | failed
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE clips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
  start_time FLOAT NOT NULL,
  end_time FLOAT NOT NULL,
  transcript TEXT,
  virality_score FLOAT,
  title TEXT,
  storage_key TEXT,
  status TEXT DEFAULT 'pending', -- pending | rendering | done
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id),
  job_type TEXT NOT NULL, -- transcribe | analyze | render
  status TEXT DEFAULT 'pending', -- pending | processing | done | failed
  priority INT DEFAULT 0,
  worker_id TEXT,
  required_capability TEXT,
  payload JSONB,
  result JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

## Scaled Production Architecture (3000+ clips/month, $80–114/month)

The scaled architecture replaces notebook-based compute with always-on GPU workers while keeping the free-tier services for non-GPU workloads.

| Layer | Service | Cost/month | Role |
|-------|---------|------------|------|
| Frontend | Vercel Pro | $0 (free tier sufficient) | Next.js app |
| API Gateway | Cloudflare Workers (paid) | $5 | Auth, routing, rate limiting |
| Database | Supabase Pro | $25 | PostgreSQL + auth + realtime |
| Object Storage | Cloudflare R2 | $0 (under 10 GB) | Video/blob storage |
| GPU Compute | RunPod Persistent Pod | ~$53 | Whisper, LLM, rendering (RTX 3090, 8 hrs/day) |
| Job Queue | Supabase + pg_cron | $0 (included in Pro) | Async job dispatch |
| CDN | Cloudflare CDN | $0 (free tier) | Clip delivery |

### Key Architectural Changes at Scale

1. **Replace notebook polling with RunPod serverless**: GPU tasks become HTTP calls to RunPod endpoints with <5s cold start and automatic scaling. No more manually starting Colab notebooks.

2. **Batch processing**: Instead of one job per video, batch multiple transcription tasks into a single GPU invocation to maximize throughput per dollar.

3. **Caching layer**: Transcriptions and analysis results are cached in Supabase — re-processing a video costs zero GPU time.

```typescript
// scaled-api/src/services/gpu-dispatch.ts
export async function dispatchToRunPod(job: Job): Promise<string> {
  const response = await fetch("https://api.runpod.ai/v2/YOUR_ENDPOINT/run", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RUNPOD_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      input: {
        video_url: job.source_url,
        task: job.job_type, // "transcribe" | "analyze" | "render"
        model: "whisper-large-v3",
        config: {
          language: "auto",
          word_timestamps: true,
          vad_filter: true
        }
      }
    })
  });

  const { id } = await response.json();
  return id; // RunPod job ID — poll status separately
}
```

### Scaling Decision Matrix

| Metric | Free Tier Action | Scaled Action |
|--------|-----------------|---------------|
| >500 clips/month | Upgrade to paid Supabase | Already paid |
| Colab GPU quota hit | Switch to Kaggle | Use RunPod |
| >10 GB R2 storage | Add Cloudflare R2 paid ($0.01/GB/mo) | Same |
| >100K Worker req/day | Add Cloudflare Workers Paid ($0.50/million) | Same |
| Need faster turnaround | Parallel notebook workers | RunPod auto-scaling |

## Component Interaction Diagram

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Vercel      │────▶│  Cloudflare      │────▶│  Supabase    │
│  (Next.js)   │     │  Workers (API)    │     │  (Database)  │
└─────────────┘     └────────┬─────────┘     └──────┬───────┘
                             │                       │
                    ┌────────▼─────────┐     ┌──────▼───────┐
                    │  Cloudflare R2   │     │  GPU Worker   │
                    │  (Storage)       │     │  (Colab/      │
                    │                  │     │   Kaggle/     │
                    │                  │     │   RunPod)     │
                    └──────────────────┘     └──────────────┘
```

## Key Design Decisions

1. **Colab/Kaggle as GPU source**: Free GPU compute is unreliable but workable with a polling pattern. The worker notebook is a single Python file that anyone can run in a browser tab.

2. **Supabase Edge Functions for free tier, Cloudflare Workers for production**: Edge Functions are free up to 500K invocations and keep the free tier within a single platform (Supabase). At scale, Cloudflare Workers offer lower cold start times, cheaper per-request pricing, and better geographic distribution.

3. **Supabase over Firebase**: PostgreSQL gives us full SQL, pgvector for future semantic search on transcripts, and Supabase Realtime replaces a separate WebSocket server.

4. **R2 over S3**: Zero egress fees matter for video files. A 500 MB source video downloaded 10 times costs $0.90 on S3 — R2 charges $0.

5. **Job queue in PostgreSQL**: No Redis, no RabbitMQ. A simple `jobs` table with `status` and `pg_cron` polling is sufficient for the throughput we need and eliminates another service to manage.

## Getting Started

```bash
git clone https://github.com/your-org/minio.git
cd minio
cp .env.example .env
# Fill in Supabase URL, R2 credentials, Cloudflare Worker secrets

# Deploy the API worker
cd worker-api
npm install
npx wrangler deploy

# Deploy the frontend
cd ../frontend
npm install
vercel deploy

# Start a GPU worker (open in Colab)
# Upload worker-notebook.ipynb to Google Colab and run all cells
```
