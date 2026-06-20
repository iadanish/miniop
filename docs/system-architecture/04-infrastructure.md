# MiniOp Infrastructure Setup

## Infrastructure Philosophy

MiniOp's infrastructure is designed around a single constraint: **minimize cost while remaining functional**. The free tier runs entirely on free-tier cloud services with GPU compute sourced from Google Colab and Kaggle notebooks. The scaled tier replaces only the GPU bottleneck with paid compute — everything else stays on free tiers as long as possible.

## Free Tier Infrastructure

### Cloudflare Account Setup

```bash
# Install Wrangler CLI
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Create the Worker project
wrangler init minio-api
cd minio-api

# Create R2 bucket
wrangler r2 bucket create minio-storage

# Create KV namespace for rate limiting
wrangler kv:namespace create RATE_LIMIT_KV
# Output: { binding = "RATE_LIMIT_KV", id = "xxxxxxxxxxxx" }
```

### Cloudflare Worker Configuration

```toml
# wrangler.toml
name = "minio-api"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[vars]
SUPABASE_URL = "https://your-project.supabase.co"
SUPABASE_SERVICE_KEY = "your-service-key"

[[r2_buckets]]
binding = "R2"
bucket_name = "minio-storage"

[[kv_namespaces]]
binding = "RATE_LIMIT_KV"
id = "your-kv-namespace-id"
```

### Supabase Project Setup

```bash
# Install Supabase CLI
npm install -g supabase

# Initialize project
supabase init

# Link to your Supabase project
supabase link --project-ref your-project-ref

# Push database schema
supabase db push

# Generate TypeScript types for frontend
supabase gen types typescript --local > frontend/types/supabase.ts
```

### Supabase Database Initialization

```sql
-- supabase/migrations/001_initial_schema.sql

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Projects table
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Videos table
CREATE TABLE videos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_url TEXT,
  storage_key TEXT,
  filename TEXT,
  duration_seconds INT,
  file_size_bytes BIGINT,
  status TEXT DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'queued', 'downloading', 'transcribing', 'analyzing', 'done', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Clips table
CREATE TABLE clips (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  start_time FLOAT NOT NULL,
  end_time FLOAT NOT NULL,
  title TEXT,
  transcript TEXT,
  virality_score FLOAT,
  clip_type TEXT,
  storage_key TEXT,
  thumbnail_key TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'rendering', 'done', 'failed')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Jobs table (queue)
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK (job_type IN ('download', 'transcribe', 'analyze', 'render')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed', 'permanently_failed')),
  priority INT DEFAULT 0,
  required_capability TEXT,
  worker_id TEXT,
  retry_count INT DEFAULT 0,
  max_retries INT DEFAULT 3,
  payload JSONB DEFAULT '{}',
  result JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Transcription cache
CREATE TABLE transcription_cache (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_hash TEXT NOT NULL,
  model_name TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(content_hash, model_name)
);

-- Indexes
CREATE INDEX idx_videos_project ON videos(project_id);
CREATE INDEX idx_videos_status ON videos(status);
CREATE INDEX idx_clips_video ON clips(video_id);
CREATE INDEX idx_clips_score ON clips(virality_score DESC);
CREATE INDEX idx_jobs_status_priority ON jobs(status, priority DESC, created_at ASC);
CREATE INDEX idx_jobs_worker ON jobs(worker_id);
CREATE INDEX idx_transcription_cache_lookup ON transcription_cache(content_hash, model_name);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER videos_updated_at BEFORE UPDATE ON videos FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

### Vercel Frontend Deployment

```bash
# Clone and setup
git clone https://github.com/your-org/minio.git
cd minio/frontend

# Install dependencies
npm install

# Environment variables
cat > .env.local << EOF
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_BUCKET_NAME=minio-storage
API_WORKER_URL=https://minio-api.your-subdomain.workers.dev
EOF

# Deploy to Vercel
npm i -g vercel
vercel deploy --prod
```

### Google Colab Worker Setup

The GPU worker runs as a Colab notebook. Open `worker-notebook.ipynb` in Google Colab with a T4 GPU runtime.

```python
# Cell 1: Install dependencies
!pip install faster-whisper requests torch torchvision

# Cell 2: Configure worker
import os
WORKER_ID = os.environ.get("WORKER_ID", "colab-worker-01")
API_BASE = os.environ.get("API_BASE", "https://minio-api.your-subdomain.workers.dev")
WORKER_SECRET = os.environ.get("WORKER_SECRET", "your-worker-secret")
POLL_INTERVAL = 15  # seconds
MODEL_SIZE = "base"  # Use "large-v3" if you have enough VRAM

# Cell 3: Load model
import torch
from faster_whisper import WhisperModel

device = "cuda" if torch.cuda.is_available() else "cpu"
compute_type = "float16" if device == "cuda" else "int8"
model = WhisperModel(MODEL_SIZE, device=device, compute_type=compute_type)
print(f"Model loaded on {device} ({compute_type})")

# Cell 4: Worker loop
import requests
import time
import tempfile
import subprocess
import json

def poll_for_jobs():
    print(f"Worker {WORKER_ID} polling {API_BASE}...")
    while True:
        try:
            resp = requests.post(
                f"{API_BASE}/api/worker/poll",
                json={"worker_id": WORKER_ID, "capabilities": ["download", "transcribe", "analyze"]},
                headers={"Authorization": f"Bearer {WORKER_SECRET}"},
                timeout=30
            )
            if resp.status_code == 200:
                data = resp.json()
                if data.get("job"):
                    print(f"Got job: {data['job']['id']} ({data['job']['job_type']})")
                    process_job(data["job"])
                else:
                    print("No jobs available, waiting...")
            else:
                print(f"Poll error: {resp.status_code} {resp.text}")
        except Exception as e:
            print(f"Poll exception: {e}")
        time.sleep(POLL_INTERVAL)

def process_job(job):
    try:
        if job["job_type"] == "download":
            result = download_video(job)
        elif job["job_type"] == "transcribe":
            result = transcribe_video(job)
        elif job["job_type"] == "analyze":
            result = analyze_video(job)
        else:
            raise ValueError(f"Unknown job type: {job['job_type']}")

        requests.post(
            f"{API_BASE}/api/worker/complete",
            json={"job_id": job["id"], "worker_id": WORKER_ID, "result": result},
            headers={"Authorization": f"Bearer {WORKER_SECRET}"}
        )
        print(f"Job {job['id']} completed")
    except Exception as e:
        requests.post(
            f"{API_BASE}/api/worker/fail",
            json={"job_id": job["id"], "worker_id": WORKER_ID, "error": str(e)},
            headers={"Authorization": f"Bearer {WORKER_SECRET}"}
        )
        print(f"Job {job['id']} failed: {e}")

poll_for_jobs()
```

### Kaggle Worker Setup

Kaggle notebooks have 30 hours/week of GPU time (P100 or T4). The setup is identical to Colab but with Kaggle-specific environment variables:

```python
# Kaggle-specific configuration
import os

# Kaggle provides a persistent /kaggle/working directory
WORK_DIR = "/kaggle/working"
MODEL_CACHE = f"{WORK_DIR}/model_cache"

# Kaggle has pre-installed PyTorch — just install faster-whisper
!pip install faster-whisper requests

# The rest of the worker code is identical to the Colab version
```

## Scaled Production Infrastructure ($80–114/month)

### RunPod Serverless Setup

RunPod replaces Colab/Kaggle with always-on serverless GPU endpoints. Cold start ~5s, pay per second of GPU time.

```bash
# Install RunPod CLI
pip install runpod

# Create serverless endpoint
# Go to https://www.runpod.io/console/serverless
# Create new endpoint with:
#   - GPU: NVIDIA RTX A4000 ($0.17/hr) or RTX A5000 ($0.22/hr)
#   - Min workers: 0 (scale to zero when idle)
#   - Max workers: 3
#   - Idle timeout: 60 seconds
#   - FlashBoot: enabled (faster cold starts)
```

### RunPod Handler with Multi-Task Support

```python
# runpod_handler.py — deploy as Docker image to RunPod
import runpod
import subprocess
import tempfile
import json
from faster_whisper import WhisperModel

# Models loaded at cold start (survives across requests)
whisper_model = None

def load_models():
    global whisper_model
    whisper_model = WhisperModel("large-v3", device="cuda", compute_type="float16")

load_models()

def handler(job):
    input_data = job["input"]
    task = input_data.get("task")

    if task == "transcribe":
        return handle_transcribe(input_data)
    elif task == "analyze":
        return handle_analyze(input_data)
    elif task == "render":
        return handle_render(input_data)
    else:
        return {"error": f"Unknown task: {task}"}

def handle_transcribe(input_data):
    video_url = input_data["video_url"]

    # Download to /tmp (RunPod provides ephemeral storage)
    subprocess.run(["wget", "-q", "-O", "/tmp/input.mp4", video_url], check=True)

    # Extract audio (faster than processing video)
    subprocess.run([
        "ffmpeg", "-i", "/tmp/input.mp4",
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        "/tmp/audio.wav"
    ], check=True, capture_output=True)

    segments, info = whisper_model.transcribe(
        "/tmp/audio.wav",
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
    )

    result = {
        "language": info.language,
        "duration": info.duration,
        "segments": [
            {"start": s.start, "end": s.end, "text": s.text.strip()}
            for s in segments
        ]
    }

    # Cleanup
    subprocess.run(["rm", "-f", "/tmp/input.mp4", "/tmp/audio.wav"])

    return result

def handle_render(input_data):
    video_url = input_data["video_url"]
    start = input_data["start_time"]
    end = input_data["end_time"]
    segments = input_data.get("segments", [])
    aspect = input_data.get("aspect_ratio", "9:16")

    subprocess.run(["wget", "-q", "-O", "/tmp/input.mp4", video_url], check=True)

    duration = end - start

    # Generate ASS subtitles
    ass_content = generate_ass(segments, start, end)
    with open("/tmp/captions.ass", "w") as f:
        f.write(ass_content)

    # Render with FFmpeg
    vf = f"crop=ih*9/16:ih:iw/2-ih*9/16/2:0,subtitles=/tmp/captions.ass" if aspect == "9:16" else f"subtitles=/tmp/captions.ass"

    subprocess.run([
        "ffmpeg", "-y",
        "-ss", str(start), "-i", "/tmp/input.mp4", "-t", str(duration),
        "-vf", vf,
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "/tmp/output.mp4"
    ], check=True, capture_output=True)

    # Read output and encode as base64 (RunPod returns JSON, not files)
    import base64
    with open("/tmp/output.mp4", "rb") as f:
        video_b64 = base64.b64encode(f.read()).decode()

    return {"video_base64": video_b64, "duration": duration}

runpod.serverless.start({"handler": handler})
```

### RunPod Dockerfile

```dockerfile
FROM runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04

RUN apt-get update && apt-get install -y ffmpeg wget && rm -rf /var/lib/apt/lists/*

RUN pip install faster-whisper runpod

COPY runpod_handler.py /workspace/runpod_handler.py

# Pre-download model during build (avoids download at cold start)
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('large-v3', device='cpu')"

CMD ["python", "-u", "/workspace/runpod_handler.py"]
```

Deploy to RunPod:

```bash
# Build and push Docker image
docker build -t your-registry/minio-worker:latest .
docker push your-registry/minio-worker:latest

# Update RunPod endpoint to use this image
```

### Supabase Pro Configuration

```bash
# Upgrade to Supabase Pro ($25/month) for:
# - 8 GB database (vs 500 MB free)
# - Point-in-time recovery
# - No pause after 7 days of inactivity
# - 250 concurrent Realtime connections

# Enable pg_cron for scheduled jobs
# In Supabase SQL Editor:
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Clean up expired presigned URLs every hour
SELECT cron.schedule('cleanup-expired', '0 * * * *', $$
  UPDATE jobs SET status = 'permanently_failed', error_message = 'Expired'
  WHERE status = 'pending' AND created_at < now() - interval '24 hours'
$$);

-- Generate usage stats daily
SELECT cron.schedule('daily-stats', '0 0 * * *', $$
  INSERT INTO usage_stats (date, total_clips, total_videos, active_users)
  SELECT
    CURRENT_DATE,
    (SELECT count(*) FROM clips WHERE created_at >= CURRENT_DATE),
    (SELECT count(*) FROM videos WHERE created_at >= CURRENT_DATE),
    (SELECT count(DISTINCT user_id) FROM projects WHERE updated_at >= CURRENT_DATE)
$$);
```

## Monitoring and Observability

### Supabase Dashboard Queries

```sql
-- Active jobs by type and status
SELECT job_type, status, count(*), avg(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_duration_seconds
FROM jobs
WHERE created_at > now() - interval '24 hours'
GROUP BY job_type, status
ORDER BY job_type, status;

-- GPU utilization estimate (based on job completion rate)
SELECT
  date_trunc('hour', updated_at) as hour,
  count(*) as jobs_completed,
  sum(EXTRACT(EPOCH FROM (updated_at - created_at))) as total_gpu_seconds
FROM jobs
WHERE status = 'done' AND updated_at > now() - interval '24 hours'
GROUP BY hour
ORDER BY hour;

-- Storage usage
SELECT
  (SELECT pg_size_pretty(pg_total_relation_size('videos'))) as videos_table_size,
  (SELECT pg_size_pretty(pg_total_relation_size('clips'))) as clips_table_size,
  (SELECT pg_size_pretty(pg_total_relation_size('jobs'))) as jobs_table_size,
  (SELECT pg_size_pretty(pg_total_relation_size('transcription_cache'))) as cache_table_size;
```

### Cloudflare Worker Analytics

```bash
# View Worker analytics
wrangler tail minio-api --format pretty

# Check R2 storage usage
wrangler r2 bucket info minio-storage
```

### Cost Monitoring Script

```python
# scripts/check_costs.py
"""Run weekly to estimate costs against budget."""
import requests
import os

def check_costs():
    # RunPod: check current month spend
    rp_key = os.environ["RUNPOD_API_KEY"]
    rp_resp = requests.get("https://api.runpod.ai/graphql", headers={"Authorization": rp_key}, json={
        "query": "{ myself { serverless { endpoints { id name executions { cost } } } } }"
    })
    rp_data = rp_resp.json()
    rp_cost = sum(e["cost"] for ep in rp_data["data"]["myself"]["serverless"]["endpoints"] for e in ep["executions"])
    print(f"RunPod this month: ${rp_cost:.2f}")

    # Supabase: check database size
    sb_url = os.environ["SUPABASE_URL"]
    sb_key = os.environ["SUPABASE_SERVICE_KEY"]
    # Supabase doesn't have a billing API — estimate from table sizes
    print("Supabase: Check dashboard for usage")

    # Cloudflare R2: check storage
    print("Cloudflare R2: Check dashboard for storage")

    print(f"\nTotal estimated: ${rp_cost + 25:.2f}/month")  # $25 Supabase Pro

if __name__ == "__main__":
    check_costs()
```

## Local Development Setup

```bash
# Clone repository
git clone https://github.com/your-org/minio.git
cd minio

# Start local Supabase (requires Docker)
supabase start
# Outputs:
#   API URL: http://localhost:54321
#   DB URL: postgresql://postgres:postgres@localhost:54322/postgres
#   Studio URL: http://localhost:54323

# Start local Cloudflare Worker (using Wrangler dev)
cd worker-api
wrangler dev
# Runs at http://localhost:8787

# Start frontend
cd ../frontend
npm run dev
# Runs at http://localhost:3000

# Test GPU worker locally (requires CUDA GPU or CPU fallback)
cd ../services
pip install -r requirements.txt
python -m transcription.worker --local --api-base http://localhost:8787
```

### Environment Variables Summary

```bash
# .env.example

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Cloudflare
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-access-key-id
R2_SECRET_ACCESS_KEY=your-secret-access-key
R2_BUCKET_NAME=minio-storage

# Worker
WORKER_SECRET=your-worker-secret-for-mutual-auth

# RunPod (scaled tier only)
RUNPOD_API_KEY=your-runpod-api-key
RUNPOD_ENDPOINT_ID=your-endpoint-id

# OpenAI (scaled tier only)
OPENAI_API_KEY=sk-...
```

## Deployment Checklist

### Free Tier Launch

- [ ] Create Supabase project (free tier)
- [ ] Run database migrations
- [ ] Create Cloudflare account
- [ ] Create R2 bucket
- [ ] Deploy Cloudflare Worker
- [ ] Deploy Vercel frontend
- [ ] Set up Colab notebook worker
- [ ] Set up Kaggle notebook worker
- [ ] Test end-to-end: URL → clips
- [ ] Set R2 lifecycle rules (delete source uploads after 30 days per retention policy)

### Scaled Production Launch

- [ ] Upgrade Supabase to Pro
- [ ] Deploy RunPod serverless endpoint
- [ ] Build and push worker Docker image
- [ ] Update API Gateway to dispatch to RunPod (toggle environment variable)
- [ ] Set up cost monitoring script
- [ ] Configure RunPod spending limit ($60/month cap)
- [ ] Test failover: kill RunPod worker, verify retry logic
- [ ] Enable pg_cron cleanup jobs
