# Paid Production Scaling: 3,000+ Clips/Month at $80-114/Month

## Overview

This guide covers scaling MiniOp from free tier to production-grade at 3,000+ clips/month. The architecture replaces Colab with persistent GPU workers on affordable cloud compute, upgrades Supabase to Pro, keeps R2 for storage (cheapest at scale), and uses Cloudflare Workers for job orchestration. Total cost target: $80-114/month.

## Architecture

```
User → Vercel Pro (frontend) → Cloudflare Workers (API + job dispatch)
    ↓                                    ↓
Supabase Pro (DB + auth)        GPU Worker(s) on RunPod/Lambda
    ↓                                    ↓
Cloudflare R2 (storage) ←←←←←←←←←←←←←←←↓
```

## Cost Breakdown

| Component | Service | Monthly Cost |
|-----------|---------|-------------|
| Frontend | Vercel Pro | $20 ($20/month per member, 1 seat) |
| Database + Auth | Supabase Pro | $25 |
| GPU Compute | RunPod Persistent Pod (RTX 3090) | ~$53 (8 hrs/day) |
| Storage | Cloudflare R2 | $0-5 |
| API Gateway | Cloudflare Workers (Paid) | $5 |
| DNS + CDN | Cloudflare Free | $0 |
| **Total** | | **$103-108** |

## Component Upgrades

### 1. GPU Compute: RunPod Serverless

RunPod serverless charges ~$0.00044/sec for A10G GPUs. A 30-second clip takes ~60-90 seconds to process. At 3,000 clips/month:

- Processing time: 3,000 × 90s = 270,000 seconds = 75 hours
- Cost: 270,000 × $0.00044 = ~$119/month (too high)

**Better approach: RunPod Community Cloud with persistent pod**

A single RTX 3090 pod at $0.22/hr running 8 hours/day = ~$53/month. This handles 3,000+ clips easily.

**Alternative: Lambda Labs or Vast.ai**

- Vast.ai RTX 3090: ~$0.15/hr → $36/month for 8hrs/day
- Lambda Labs A10G: ~$0.12/hr → $29/month for 8hrs/day

**Worker script (runs on GPU pod):**

```python
# worker/process_worker.py
import os
import time
import json
import signal
import logging
from pathlib import Path
from dataclasses import dataclass
from typing import Optional

import ffmpeg
import yt_dlp
import boto3
import requests
from supabase import create_client, Client

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("minio-worker")

@dataclass
class Config:
    supabase_url: str = os.environ["SUPABASE_URL"]
    supabase_key: str = os.environ["SUPABASE_SERVICE_KEY"]
    r2_endpoint: str = os.environ["R2_ENDPOINT"]
    r2_access_key: str = os.environ["R2_ACCESS_KEY"]
    r2_secret_key: str = os.environ["R2_SECRET_KEY"]
    r2_bucket: str = os.environ["R2_BUCKET"]
    worker_id: str = os.environ.get("WORKER_ID", "worker-1")
    poll_interval: int = int(os.environ.get("POLL_INTERVAL", "10"))
    max_concurrent: int = int(os.environ.get("MAX_CONCURRENT", "3"))

config = Config()
supabase: Client = create_client(config.supabase_url, config.supabase_key)
s3 = boto3.client("s3",
    endpoint_url=config.r2_endpoint,
    aws_access_key_id=config.r2_access_key,
    aws_secret_access_key=config.r2_secret_key,
)

class GracefulShutdown:
    running = True
    def __init__(self):
        signal.signal(signal.SIGTERM, self._handler)
        signal.signal(signal.SIGINT, self._handler)
    def _handler(self, *_):
        logger.info("Shutdown signal received")
        self.running = False

shutdown = GracefulShutdown()

def download_source(url: str, output_path: str) -> str:
    ydl_opts = {
        "format": "best[height<=1080]",
        "outtmpl": output_path,
        "quiet": True,
        "no_warnings": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])
    return output_path

def process_clip(
    source_path: str, start: float, end: float, output_path: str
) -> str:
    (
        ffmpeg
        .input(source_path, ss=start, to=end)
        .output(
            output_path,
            vcodec="libx264",
            acodec="aac",
            preset="medium",
            crf=23,
            movflags="+faststart",
        )
        .overwrite_output()
        .run(quiet=True)
    )
    return output_path

def generate_thumbnail(video_path: str, output_path: str, at_sec: float = 1.0):
    (
        ffmpeg
        .input(video_path, ss=at_sec)
        .output(output_path, vframes=1, s="1280x720")
        .overwrite_output()
        .run(quiet=True)
    )
    return output_path

def upload_to_r2(local_path: str, key: str, content_type: str = "video/mp4"):
    s3.upload_file(
        local_path, config.r2_bucket, key,
        ExtraArgs={"ContentType": content_type},
    )
    return f"{config.r2_endpoint}/{config.r2_bucket}/{key}"

def claim_job() -> Optional[dict]:
    """Atomically claim the next queued job using FOR UPDATE SKIP LOCKED."""
    result = supabase.rpc("claim_next_job", {"worker_id": config.worker_id}).execute()
    return result.data[0] if result.data else None

def complete_job(job_id: str, clip_data: dict):
    supabase.table("processing_queue").update({
        "status": "completed",
        "completed_at": "now()",
    }).eq("id", job_id).execute()

    supabase.table("clips").insert({
        "project_id": clip_data["project_id"],
        "title": clip_data.get("title", "Untitled"),
        "start_time": clip_data["start_time"],
        "end_time": clip_data["end_time"],
        "r2_key": clip_data["r2_key"],
        "thumbnail_url": clip_data["thumbnail_url"],
        "status": "ready",
    }).execute()

def fail_job(job_id: str, error: str):
    supabase.table("processing_queue").update({
        "status": "failed",
        "error_message": error,
    }).eq("id", job_id).execute()

def process_job(job: dict) -> bool:
    job_id = job["id"]
    payload = job["payload"]
    project_id = job["project_id"]

    tmp_dir = Path(f"/tmp/minio/{job_id}")
    tmp_dir.mkdir(parents=True, exist_ok=True)

    try:
        source_path = str(tmp_dir / "source.mp4")
        clip_path = str(tmp_dir / "clip.mp4")
        thumb_path = str(tmp_dir / "thumb.jpg")

        logger.info(f"Processing job {job_id}: {payload.get('title', 'no title')}")

        download_source(payload["source_url"], source_path)
        process_clip(source_path, payload["start_time"], payload["end_time"], clip_path)
        generate_thumbnail(clip_path, thumb_path, at_sec=1.0)

        clip_key = f"clips/{project_id}/{job_id}.mp4"
        thumb_key = f"thumbs/{project_id}/{job_id}.jpg"

        upload_to_r2(clip_path, clip_key, "video/mp4")
        upload_to_r2(thumb_path, thumb_key, "image/jpeg")

        complete_job(job_id, {
            "project_id": project_id,
            "title": payload.get("title"),
            "start_time": payload["start_time"],
            "end_time": payload["end_time"],
            "r2_key": clip_key,
            "thumbnail_url": f"{config.r2_endpoint}/{config.r2_bucket}/{thumb_key}",
        })

        logger.info(f"Job {job_id} completed")
        return True

    except Exception as e:
        logger.error(f"Job {job_id} failed: {e}")
        fail_job(job_id, str(e))
        return False

    finally:
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)

def main():
    logger.info(f"Worker {config.worker_id} starting")
    consecutive_idle = 0

    while shutdown.running:
        job = claim_job()
        if job:
            consecutive_idle = 0
            process_job(job)
        else:
            consecutive_idle += 1
            sleep_time = min(config.poll_interval * (1 + consecutive_idle // 10), 60)
            time.sleep(sleep_time)

    logger.info("Worker shutting down")

if __name__ == "__main__":
    main()
```

**Supabase function for atomic job claiming:**

```sql
-- Run in Supabase SQL Editor
CREATE OR REPLACE FUNCTION claim_next_job(worker_id TEXT)
RETURNS SETOF processing_queue AS $$
BEGIN
  RETURN QUERY
  UPDATE processing_queue
  SET status = 'processing',
      started_at = now(),
      attempts = attempts + 1
  WHERE id = (
    SELECT id FROM processing_queue
    WHERE status = 'queued' AND attempts < max_attempts
    ORDER BY priority DESC, created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
END;
$$ LANGUAGE plpgsql;
```

**Dockerfile for worker:**

```dockerfile
FROM python:3.11-slim

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY worker/ .

CMD ["python", "-u", "process_worker.py"]
```

**requirements.txt:**

```
ffmpeg-python==0.12.0
yt-dlp==2024.1.0
boto3==1.34.0
supabase==2.3.0
requests==2.31.0
```

**Deploy to RunPod:**

1. Push Docker image to Docker Hub or RunPod registry
2. Create a Pod template in RunPod dashboard
3. Set environment variables from Config class
4. Use spot instances for ~40% savings (accept occasional interruptions)

```bash
# Build and push
docker build -t yourusername/minio-worker:latest .
docker push yourusername/minio-worker:latest
```

### 2. API Gateway: Cloudflare Workers ($5/month)

Replace Supabase Edge Functions with Cloudflare Workers for the job submission API. Workers are faster, cheaper at scale, and give you more control.

```typescript
// workers/src/index.ts
interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  R2_BUCKET: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // POST /api/jobs - Submit clip job
    if (url.pathname === "/api/jobs" && request.method === "POST") {
      const body = await request.json();
      const { project_id, source_url, start_time, end_time, title } = body;

      if (!project_id || !source_url || start_time === undefined || end_time === undefined) {
        return new Response(JSON.stringify({ error: "Missing required fields" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Insert job into Supabase queue
      const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/processing_queue`, {
        method: "POST",
        headers: {
          "apikey": env.SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=representation",
        },
        body: JSON.stringify({
          project_id,
          payload: { source_url, start_time, end_time, title },
          priority: 0,
        }),
      });

      const [job] = await resp.json();

      return new Response(JSON.stringify({ job_id: job.id, status: "queued" }), {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /api/jobs/:id - Check job status
    if (url.pathname.startsWith("/api/jobs/") && request.method === "GET") {
      const jobId = url.pathname.split("/").pop();

      const resp = await fetch(
        `${env.SUPABASE_URL}/rest/v1/processing_queue?id=eq.${jobId}&select=*`,
        {
          headers: {
            "apikey": env.SUPABASE_SERVICE_KEY,
            "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          },
        }
      );

      const jobs = await resp.json();
      if (!jobs.length) {
        return new Response(JSON.stringify({ error: "Job not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify(jobs[0]), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /api/clips/:projectId - Get clips for project
    if (url.pathname.startsWith("/api/clips/") && request.method === "GET") {
      const projectId = url.pathname.split("/").pop();

      const resp = await fetch(
        `${env.SUPABASE_URL}/rest/v1/clips?project_id=eq.${projectId}&order=score.desc`,
        {
          headers: {
            "apikey": env.SUPABASE_SERVICE_KEY,
            "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          },
        }
      );

      const clips = await resp.json();

      return new Response(JSON.stringify(clips), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
```

**wrangler.toml:**

```toml
name = "minio-api"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[vars]
SUPABASE_URL = "https://your-project.supabase.co"

# Use secrets for sensitive values
# wrangler secret put SUPABASE_SERVICE_KEY
```

```bash
cd workers
npm install
wrangler secret put SUPABASE_SERVICE_KEY
wrangler deploy
```

### 3. Database: Supabase Pro ($25/month)

Supabase Pro gives you 8GB database, 250GB bandwidth, and better connection pooling. The main upgrade is enabling the `pgvector` extension for future semantic search on clips.

```sql
-- Enable extensions
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to clips for semantic search
ALTER TABLE clips ADD COLUMN embedding vector(384);

-- Add index for similarity search
CREATE INDEX ON clips USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Optimized query function for clip search
CREATE OR REPLACE FUNCTION search_clips(
  query_embedding vector(384),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 20
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  score FLOAT,
  similarity FLOAT
)
AS $$
BEGIN
  RETURN QUERY
  SELECT
    clips.id,
    clips.title,
    clips.score,
    1 - (clips.embedding <=> query_embedding) AS similarity
  FROM clips
  WHERE 1 - (clips.embedding <=> query_embedding) > match_threshold
  ORDER BY clips.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- Connection pooling settings (via Supabase dashboard)
-- Transaction mode: suitable for serverless
-- Pool size: 15 (Supabase Pro default)
-- Statement timeout: 10s
```

**Upgrade path from Free to Pro:**

1. Go to Supabase Dashboard → Settings → Billing
2. Upgrade to Pro ($25/month)
3. Database migrates automatically, no downtime
4. Enable connection pooling in Transaction mode for serverless compatibility

### 4. Frontend: Vercel Pro ($20/month per member)

Vercel Pro removes the 100GB bandwidth limit and adds:
- 1TB bandwidth
- Serverless function execution up to 60 seconds
- Preview deployments
- Web Analytics

**Next.js API route for clip serving (uses R2 presigned URLs):**

```typescript
// app/api/clips/[clipId]/stream/route.ts
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextRequest, NextResponse } from "next/server";

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

export async function GET(
  request: NextRequest,
  { params }: { params: { clipId: string } }
) {
  const { clipId } = params;

  // Get clip metadata from Supabase
  const resp = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/clips?id=eq.${clipId}&select=r2_key`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY!}`,
      },
    }
  );

  const [clip] = await resp.json();
  if (!clip) {
    return NextResponse.json({ error: "Clip not found" }, { status: 404 });
  }

  // Generate presigned URL (1 hour expiry)
  const command = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME!,
    Key: clip.r2_key,
  });

  const presignedUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });

  // Redirect to R2 presigned URL
  return NextResponse.redirect(presignedUrl);
}
```

### 5. R2 Storage at Scale

At 3,000 clips/month with average 10MB per clip:

- Monthly storage addition: ~30GB
- R2 pricing: $0.015/GB/month
- After 6 months: ~180GB = $2.70/month
- After 12 months: ~360GB = $5.40/month

**Lifecycle rules to manage storage:**

```json
// Apply via Wrangler or Cloudflare dashboard
{
  "rules": [
    {
      "id": "archive-old-clips",
      "enabled": true,
      "path": "clips/*",
      "conditions": {
        "type": "age",
        "value": 90
      },
      "actions": {
        "type": "transition",
        "storageClass": "InfrequentAccess"
      }
    },
    {
      "id": "delete-ancient-clips",
      "enabled": true,
      "path": "clips/*",
      "conditions": {
        "type": "age",
        "value": 365
      },
      "actions": {
        "type": "delete"
      }
    }
  ]
}
```

## Monitoring and Observability

### Health Check Endpoint

Add to Cloudflare Workers:

```typescript
// GET /api/health
if (url.pathname === "/api/health" && request.method === "GET") {
  const checks: Record<string, string> = {};

  // Check Supabase
  try {
    const dbResp = await fetch(`${env.SUPABASE_URL}/rest/v1/`, {
      headers: { "apikey": env.SUPABASE_SERVICE_KEY },
    });
    checks.database = dbResp.ok ? "ok" : "degraded";
  } catch {
    checks.database = "down";
  }

  // Check queue depth
  const queueResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/processing_queue?status=eq.queued&select=id`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Prefer": "count=exact",
      },
    }
  );
  const queueHeaders = queueResp.headers.get("content-range");
  checks.queue_depth = queueHeaders?.split("/")[1] || "unknown";

  return new Response(JSON.stringify({ status: "ok", checks }), {
    headers: { "Content-Type": "application/json" },
  });
}
```

### Uptime Monitoring

Use Cloudflare's built-in health checks or a free service like UptimeRobot:

```
Health check URL: https://minio-api.your-domain.workers.dev/api/health
Interval: 5 minutes
Alert via: Email or Slack webhook
```

## Performance Benchmarks

Expected performance at this tier:

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Clip processing time | < 2 minutes | Worker logs |
| API response time (p95) | < 200ms | Cloudflare analytics |
| Time to first clip | < 5 minutes | User-reported |
| Concurrent users | 10-20 | Supabase dashboard |
| Monthly throughput | 3,000+ clips | Database count |

## Scaling Beyond $100/month

When you outgrow this tier:

- **GPU**: Add a second worker pod ($30-50 more)
- **Database**: Supabase Pro → Team ($599/month) or self-host Postgres
- **Storage**: R2 pricing stays linear, no sudden jumps
- **Frontend**: Vercel Pro handles up to 1TB, then Enterprise

See [03-migration-path.md](./03-migration-path.md) for step-by-step migration procedures.
