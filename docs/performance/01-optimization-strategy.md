# Optimization Strategy

This document defines the performance optimization strategy for MiniOp across two deployment profiles: **Free Tier** (single server, sub-100 concurrent users) and **Scaled Production** (multi-node, thousands of concurrent uploads and processing jobs).

---

## 1. Performance Budget

Before optimizing anything, define the budget. MiniOp's core loop is: **upload → transcribe → detect highlights → clip → export**. Users expect results in under 60 seconds for a 10-minute source video.

| Metric | Free Tier Target | Scaled Target |
|---|---|---|
| Upload complete → job queued | < 2s | < 1s |
| Transcription (10 min video) | < 45s (Whisper small) | < 15s (Whisper large-v3, GPU) |
| Highlight detection | < 5s | < 2s |
| Clip export (3 clips, 1080p) | < 30s | < 12s |
| End-to-end (upload → download ready) | < 90s | < 30s |
| P95 API response time | < 500ms | < 150ms |
| Concurrent processing jobs | 5 | 200+ |

These numbers drive every architectural decision below.

---

## 2. Free Tier: Single-Server Optimization

The free tier runs on one machine — typically a VPS with 4 vCPUs and 8 GB RAM. The bottleneck is always CPU-bound video processing.

### 2.1 Process Isolation via Worker Pools

Never run FFmpeg in the request thread. Use a bounded worker pool:

```python
# worker_pool.py
import asyncio
from concurrent.futures import ProcessPoolExecutor

# Bounded to 3 workers on free tier — leaves 1 core for the API server
video_pool = ProcessPoolExecutor(max_workers=3)

async def process_clip(input_path: str, output_path: str, start: float, duration: float):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        video_pool,
        _run_ffmpeg_extract,
        input_path, output_path, start, duration
    )

def _run_ffmpeg_extract(input_path, output_path, start, duration):
    import subprocess
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(start),
        "-i", input_path,
        "-t", str(duration),
        "-c:v", "libx264", "-preset", "fast",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        output_path
    ]
    subprocess.run(cmd, check=True, capture_output=True)
```

The key constraint: **3 concurrent FFmpeg processes on a 4-core machine**. Going above this causes context switching overhead that makes everything slower, not faster.

### 2.2 Database: Supabase PostgreSQL

Free tier uses Supabase PostgreSQL. This provides managed backups, built-in connection pooling, and zero maintenance overhead. Use the Supabase client library for connection management:

```typescript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
```

For local development, SQLite with WAL mode is an acceptable fallback to avoid requiring a Supabase project during development:

```sql
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA synchronous=NORMAL;
PRAGMA cache_size=-64000;  -- 64MB cache
```

### 2.3 Job Queue: PostgreSQL Table with pg_cron

The free tier uses a PostgreSQL `jobs` table polled by `pg_cron` — no Redis, no external queue service. This eliminates an extra dependency and stays within the Supabase free tier limits.

```sql
-- Job dispatch: pg_cron calls a function every 15 seconds
SELECT cron.schedule('poll-jobs', '*/15 * * * * *', $$
  UPDATE jobs SET status = 'processing', worker_id = 'edge-worker-01', updated_at = now()
  WHERE id = (
    SELECT id FROM jobs
    WHERE status = 'pending'
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$);
```

Workers poll the table or receive jobs via Supabase Edge Functions. This approach handles up to ~500 clips/month comfortably. See `system-architecture/01-overview.md` for the full free-tier request flow.

### 2.4 Lazy Transcription

Don't transcribe the entire file upfront. Use FFmpeg to extract the audio track first (fast, ~2s for a 10-minute file), then transcribe only that:

```bash
ffmpeg -i input.mp4 -vn -acodec pcm_s16le -ar 16000 -ac 1 /tmp/audio.wav
```

This avoids feeding the video decoder during transcription and reduces memory usage by ~70%.

### 2.5 Temp File Management

Video processing generates enormous temp files. Implement a cleanup sweep:

```python
import os
import time

TEMP_DIR = "/tmp/miniop"
MAX_AGE_SECONDS = 3600  # 1 hour

def cleanup_temp_files():
    now = time.time()
    for f in os.listdir(TEMP_DIR):
        path = os.path.join(TEMP_DIR, f)
        if os.path.isfile(path) and (now - os.path.getmtime(path)) > MAX_AGE_SECONDS:
            os.remove(path)
```

Run this on a cron or as a background task every 15 minutes.

---

## 3. Scaled Production: Multi-Node Architecture

At scale, the single-server model breaks. You need horizontal scaling with proper queue management.

### 3.1 Job Queue: Redis with BullMQ (Scaled Production)

At scale, the PostgreSQL polling approach hits throughput limits. Replace it with a Redis-backed job queue using BullMQ for sub-second dispatch and horizontal worker scaling:

```typescript
// queue.ts
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

const connection = new Redis({
  host: process.env.REDIS_HOST,
  maxRetriesPerRequest: null,
});

export const clipQueue = new Queue('clip-processing', { connection });

export const clipWorker = new Worker('clip-processing', async (job) => {
  const { inputPath, outputPath, startTime, duration } = job.data;
  await processClipWithFFmpeg(inputPath, outputPath, startTime, duration);
}, {
  connection,
  concurrency: 4,  // per worker process
  limiter: {
    max: 10,
    duration: 1000,  // max 10 jobs/sec per worker to prevent disk I/O saturation
  },
});
```

Deploy multiple worker instances. Each worker node should have local SSD storage for temp files — network-attached storage adds 200-500ms per FFmpeg read operation.

### 3.2 GPU Acceleration for Transcription

At scale, Whisper runs on GPU nodes. Use the `faster-whisper` library with CTranslate2:

```python
from faster_whisper import WhisperModel

model = WhisperModel("large-v3", device="cuda", compute_type="float16")

segments, info = model.transcribe(
    "/tmp/audio.wav",
    beam_size=5,
    language="en",
    vad_filter=True,  # skip silence — cuts processing time by 30-40%
    vad_parameters=dict(
        min_silence_duration_ms=500,
        speech_pad_ms=200,
    )
)
```

A single A10G GPU handles ~8 concurrent transcription jobs. Cost on AWS: ~$1.00/hr for a `g5.xlarge`. This is cheaper than CPU-based transcription at moderate scale (roughly 50+ transcription jobs per hour).

### 3.3 Horizontal Scaling with Load Balancing

Use Nginx as a reverse proxy with least-connections balancing for API nodes:

```nginx
upstream miniop_api {
    least_conn;
    server 10.0.1.10:3000 weight=1;
    server 10.0.1.11:3000 weight=1;
    server 10.0.1.12:3000 weight=1;
}

server {
    listen 443 ssl http2;
    server_name api.miniop.example.com;

    client_max_body_size 2G;  # video uploads

    location /api/ {
        proxy_pass http://miniop_api;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;  # long timeout for upload endpoints
    }

    location /ws/ {
        proxy_pass http://miniop_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### 3.4 Database: PostgreSQL with Connection Pooling

The scaled production tier uses Supabase PostgreSQL with PgBouncer for connection pooling (Supabase includes PgBouncer built-in, but self-managed PgBouncer is also an option):

```yaml
# pgbouncer.ini
[miniop]
pool_mode = transaction
max_client_conn = 1000
default_pool_size = 25
```

Application connection config:

```typescript
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST,
  port: 6432,  // PgBouncer port
  database: 'miniop',
  max: 25,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
```

---

## 4. Monitoring: Know Before You Break

You cannot optimize what you do not measure. Instrument early.

### 4.1 Prometheus Metrics

Expose key metrics from your API server:

```typescript
import { Registry, Counter, Histogram, Gauge } from 'prom-client';

const registry = new Registry();

const clipDuration = new Histogram({
  name: 'miniop_clip_processing_seconds',
  help: 'Time to process a single clip',
  buckets: [5, 10, 15, 20, 30, 45, 60],
  registers: [registry],
});

const activeJobs = new Gauge({
  name: 'miniop_active_jobs',
  help: 'Currently processing jobs',
  registers: [registry],
});

const uploadSize = new Histogram({
  name: 'miniop_upload_size_bytes',
  help: 'Upload file sizes',
  buckets: [1e6, 5e6, 10e6, 50e6, 100e6, 500e6, 1e9],
  registers: [registry],
});
```

### 4.2 Alerting Rules

Critical alerts that trigger before users notice:

```yaml
# prometheus/alerts.yml
groups:
  - name: miniop
    rules:
      - alert: HighProcessingLatency
        expr: histogram_quantile(0.95, rate(miniop_clip_processing_seconds_bucket[5m])) > 60
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Clip processing P95 exceeds 60s"

      - alert: QueueBacklog
        expr: miniop_active_jobs > 50
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Job queue backlog exceeding 50 — scale workers"
```

---

## 5. Optimization Decision Matrix

| Bottleneck | Free Tier Fix | Scaled Fix |
|---|---|---|
| Transcription slow | Use Whisper `tiny` or `small` model | GPU nodes with `large-v3` |
| Clip export slow | `-preset fast` on FFmpeg | `-preset medium` on GPU nodes (better quality at same speed) |
| Disk I/O saturated | Local SSD, cleanup cron | NVMe instance storage per worker |
| API latency high | Reduce middleware, gzip responses | Horizontal API scaling, CDN caching |
| Memory pressure | Limit concurrent jobs to 3 | Per-worker memory limits, auto-scaling group |
| Upload failures | Chunked uploads, resumable protocol | Same, plus Cloudflare Stream for direct uploads |

---

## 6. Key Principles

1. **Measure first.** Every optimization targets a specific metric. Never optimize without a baseline.
2. **Free tier is I/O-bound.** The bottleneck is disk and CPU. Reduce FFmpeg complexity before throwing hardware at it.
3. **Scale tier is coordination-bound.** The bottleneck is job scheduling and data transfer between nodes. Use Redis, local SSDs, and minimize network hops.
4. **Profile under load.** A 2-second improvement on a cold cache means nothing if your P95 is 45 seconds. Always test at 2x your expected concurrent load.
5. **Cache aggressively at the edges.** Once a clip is exported, it should be served from CDN, not re-generated. See `02-cdn-edge-caching.md`.
