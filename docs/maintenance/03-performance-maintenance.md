# Performance Maintenance Guide

This document covers performance monitoring, profiling, optimization, and scaling for MiniOp's clip generation pipeline. It addresses both single-machine free-tier deployments and horizontally-scaled production clusters.

---

## 1. Performance Baseline

### 1.1 Establishing Baselines

Before optimizing, measure current performance. Run the benchmark suite:

```bash
# API response time baseline
node scripts/benchmark-api.js --duration 60 --concurrency 10

# Clip generation throughput
node scripts/benchmark-worker.js --videos 5 --output /tmp/benchmark-results.json
```

Record these key metrics:

| Metric | Free Tier Target | Production Target |
|--------|-----------------|-------------------|
| API p50 latency | < 200ms | < 100ms |
| API p99 latency | < 1s | < 500ms |
| Clip generation (10min video) | < 4 min | < 2 min |
| Concurrent clip jobs | 1 | 10+ |
| Database query p95 | < 50ms | < 20ms |
| Memory usage (idle) | < 512MB | < 2GB per instance |

### 1.2 Monitoring Stack

**Free Tier** - lightweight monitoring with system tools:

```bash
# Real-time resource monitoring
htop

# Disk I/O
iotop -a

# Database query logging
# In postgresql.conf:
log_min_duration_statement = 200  # Log queries > 200ms
```

**Production** - full observability:

```yaml
# docker-compose.monitoring.yml
services:
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3001:3000"
    volumes:
      - ./monitoring/dashboards:/var/lib/grafana/dashboards

  node-exporter:
    image: prom/node-exporter:latest
    pid: host
```

Add Prometheus metrics to MiniOp API:

```javascript
// src/middleware/metrics.ts
import { Registry, Counter, Histogram } from 'prom-client';

const register = new Registry();

export const clipJobsTotal = new Counter({
  name: 'miniop_clip_jobs_total',
  help: 'Total clip jobs processed',
  labelNames: ['status', 'resolution'],
  registers: [register],
});

export const clipDurationHistogram = new Histogram({
  name: 'miniop_clip_duration_seconds',
  help: 'Time to generate a clip',
  buckets: [10, 30, 60, 120, 180, 300],
  registers: [register],
});

export const apiRequestDuration = new Histogram({
  name: 'miniop_api_request_duration_seconds',
  help: 'API request duration',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

export { register };
```

---

## 2. Database Performance

### 2.1 Query Optimization

Identify slow queries:

```sql
-- PostgreSQL: find slow queries
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 20;
```

Common slow queries in MiniOp and their fixes:

```sql
-- BEFORE: Full table scan on clip_jobs
SELECT * FROM clip_jobs WHERE user_id = $1 ORDER BY created_at DESC;

-- AFTER: Add composite index
CREATE INDEX CONCURRENTLY idx_clip_jobs_user_created
ON clip_jobs (user_id, created_at DESC);

-- BEFORE: COUNT(*) on large table for dashboard
SELECT COUNT(*) FROM clip_jobs WHERE status = 'completed';

-- AFTER: Use approximate count or cached counter
SELECT reltuples::bigint AS estimate
FROM pg_class WHERE relname = 'clip_jobs';

-- Or maintain a materialized count:
CREATE TABLE clip_stats (
    metric VARCHAR(50) PRIMARY KEY,
    value BIGINT,
    updated_at TIMESTAMPTZ
);
```

### 2.2 Connection Pooling

For production, use PgBouncer to manage connections:

```ini
# /etc/pgbouncer/pgbouncer.ini
[databases]
miniop = host=127.0.0.1 port=5432 dbname=miniop

[pgbouncer]
listen_port = 6432
listen_addr = 0.0.0.0
auth_type = md5
pool_mode = transaction
max_client_conn = 200
default_pool_size = 20
min_pool_size = 5
```

Update MiniOp connection string:

```bash
# .env
DATABASE_URL=postgresql://miniop:pass@localhost:6432/miniop
```

### 2.3 Redis Performance

Monitor Redis memory and latency:

```bash
# Memory usage
redis-cli info memory | grep used_memory_human

# Slow log
redis-cli slowlog get 10

# Key count by prefix
redis-cli --scan --pattern "bull:*" | wc -l
```

Optimize BullMQ job options:

```javascript
// src/workers/clip-worker.ts
const clipQueue = new Queue('clip-generation', {
  connection: redisConfig,
  defaultJobOptions: {
    removeOnComplete: { age: 3600, count: 100 },  // Keep last 100, max 1hr
    removeOnFail: { age: 86400 },                  // Keep failures 24hr
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  },
});
```

---

## 3. FFmpeg Performance

FFmpeg is the CPU/GPU bottleneck in clip generation. Optimize encoding parameters:

### 3.1 CPU Encoding Optimization

```bash
# Default (slow)
ffmpeg -i input.mp4 -c:v libx264 -crf 23 output.mp4

# Optimized for speed (clip previews)
ffmpeg -i input.mp4 \
  -c:v libx264 \
  -preset fast \
  -crf 28 \
  -tune fastdecode \
  -movflags +faststart \
  -threads 0 \
  output.mp4
```

### 3.2 GPU Acceleration (Production)

```bash
# NVIDIA NVENC
ffmpeg -i input.mp4 \
  -c:v h264_nvenc \
  -preset p4 \
  -tune hq \
  -b:v 5M \
  -maxrate 8M \
  -bufsize 10M \
  output.mp4

# Verify GPU is available
nvidia-smi
ffmpeg -hwaccels
```

### 3.3 Parallel Clip Extraction

Process multiple clips from the same source video simultaneously:

```python
# worker/clip_extractor.py
import subprocess
from concurrent.futures import ThreadPoolExecutor

def extract_clip(source: str, start: float, duration: float, output: str):
    cmd = [
        'ffmpeg', '-y',
        '-ss', str(start),
        '-i', source,
        '-t', str(duration),
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '28',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        '-threads', '2',
        output
    ]
    subprocess.run(cmd, check=True, capture_output=True)

def extract_clips_parallel(source: str, clips: list[dict], max_workers: int = 4):
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = []
        for clip in clips:
            futures.append(
                executor.submit(extract_clip, source, clip['start'],
                              clip['duration'], clip['output'])
            )
        for f in futures:
            f.result()  # Raise on failure
```

---

## 4. API Performance

### 4.1 Response Caching

Cache frequently accessed endpoints:

```javascript
// src/middleware/cache.ts
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

export function cacheMiddleware(ttlSeconds: number) {
  return async (req, res, next) => {
    const key = `cache:${req.method}:${req.originalUrl}`;
    const cached = await redis.get(key);

    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      redis.setex(key, ttlSeconds, JSON.stringify(body));
      return originalJson(body);
    };
    next();
  };
}

// Usage
app.get('/api/clips/:id', cacheMiddleware(300), clipController.getById);
```

### 4.2 Request Rate Limiting

Prevent abuse and ensure fair resource allocation:

```javascript
// src/middleware/rateLimit.ts
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';

export const clipGenerationLimiter = rateLimit({
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args) }),
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,                   // 10 clips per hour (free tier)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Clip generation limit reached. Try again later.' },
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 minute
  max: 100,                  // 100 requests per minute
  standardHeaders: true,
});
```

### 4.3 Payload Optimization

Compress responses and validate input size:

```javascript
import compression from 'compression';
import express from 'express';

const app = express();
app.use(compression({
  threshold: 1024,           // Compress responses > 1KB
  level: 6,                  // Balanced compression
}));

// Limit upload size
app.use('/api/upload', express.raw({ type: 'video/*', limit: '500mb' }));
app.use(express.json({ limit: '1mb' }));
```

---

## 5. Worker Scaling

### 5.1 Horizontal Scaling (Production)

Add workers based on queue depth:

```yaml
# docker-compose.yml
services:
  worker:
    image: miniop/worker:latest
    deploy:
      replicas: 3
      resources:
        limits:
          cpus: '2.0'
          memory: 4G
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    environment:
      - WORKER_CONCURRENCY=2
      - REDIS_URL=redis://redis:6379
```

Auto-scaling with Docker Swarm or Kubernetes:

```yaml
# k8s/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: miniop-worker
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: miniop-worker
  minReplicas: 1
  maxReplicas: 10
  metrics:
    - type: External
      external:
        metric:
          name: redis_queue_depth
          selector:
            matchLabels:
              queue: clip-generation
        target:
          type: AverageValue
          averageValue: "5"
```

### 5.2 Worker Concurrency Tuning

Balance between throughput and resource usage:

```python
# worker/config.py
import os

WORKER_CONFIG = {
    'concurrency': int(os.getenv('WORKER_CONCURRENCY', 2)),
    'max_memory_mb': int(os.getenv('WORKER_MAX_MEMORY_MB', 2048)),
    'ffmpeg_threads': int(os.getenv('FFMPEG_THREADS', 2)),
    'gpu_enabled': os.getenv('GPU_ENABLED', 'false').lower() == 'true',
    'prefetch_count': int(os.getenv('PREFETCH_COUNT', 1)),
}
```

Rule of thumb: `concurrency = min(available_CPU_cores / 2, available_RAM_GB / 2)`

### 5.3 Free Tier Single-Machine Scaling

Maximize throughput on limited hardware:

```bash
# Set worker concurrency based on available resources
export WORKER_CONCURRENCY=1
export FFMPEG_THREADS=2

# Use SQLite WAL mode for concurrent reads
sqlite3 /opt/miniop/data/miniop.db "PRAGMA journal_mode=WAL;"

# Increase file descriptor limits
ulimit -n 4096
```

---

## 6. Storage Performance

### 6.1 Local Storage Optimization

```bash
# Use SSD for clip output
mount /dev/nvme1n1 /opt/miniop/data/clips

# Enable noatime for write-heavy workloads
# /etc/fstab
/dev/nvme1n1 /opt/miniop/data/clips ext4 defaults,noatime 0 2

# Separate database and clip storage onto different disks
```

### 6.2 S3 Performance (Production)

```javascript
// src/services/storage.ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream } from 'fs';

const s3 = new S3Client({
  region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT,    // For MinIO/R2
  forcePathStyle: true,
});

export async function uploadClip(filePath: string, key: string) {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: createReadStream(filePath),
      ContentType: 'video/mp4',
      // Use intelligent tiering for cost optimization
      StorageClass: 'INTELLIGENT_TIERING',
    },
    queueSize: 4,      // Parallel upload parts
    partSize: 10 * 1024 * 1024,  // 10MB parts
    leavePartsOnError: false,
  });

  return upload.done();
}
```

---

## 7. Performance Regression Detection

### 7.1 Automated Performance Tests

Add performance gates to CI:

```yaml
# .github/workflows/performance.yml
name: Performance Gate
on: [pull_request]

jobs:
  benchmark:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run benchmarks
        run: node scripts/benchmark-api.js --output benchmark-results.json
      - name: Check regression
        run: |
          node scripts/check-benchmark.js \
            --current benchmark-results.json \
            --baseline benchmark-baseline.json \
            --threshold 10  # Fail if >10% regression
```

### 7.2 Continuous Profiling

Enable Node.js profiling in production:

```bash
# Start with profiling
node --prof src/server.js

# Process profiler log
node --prof-process isolate-*.log > profile.txt

# Or use clinic.js for visual profiling
npx clinic doctor -- node src/server.js
npx clinic flame -- node src/server.js
npx clinic bubbleprof -- node src/server.js
```

---

## 8. Performance Tuning Checklist

| Area | Free Tier Action | Production Action |
|------|-----------------|-------------------|
| Database | WAL mode, basic indexes | PgBouncer, pg_stat_statements, partitioning |
| Redis | Default config | maxmemory-policy, key eviction |
| FFmpeg | -preset fast, CPU threads | NVENC GPU encoding, parallel extraction |
| API | gzip, basic caching | CDN, Redis cache layer, rate limiting |
| Workers | concurrency=1 | HPA auto-scaling, GPU allocation |
| Storage | SSD, noatime | S3 multipart, CloudFront CDN |
| Monitoring | htop, logs | Prometheus + Grafana, alerts |

Review this checklist monthly. Re-benchmark after any infrastructure change.
