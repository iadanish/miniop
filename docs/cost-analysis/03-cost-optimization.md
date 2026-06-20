# Cost Optimization: Reducing MiniOp Infrastructure Costs

This document covers practical strategies to reduce MiniOp costs at every scale level. Each optimization includes the expected savings, implementation complexity, and tradeoffs.

## GPU Compute Optimizations

### 1. Batch Processing on Kaggle (Saves $90/month at Hobby Tier)

Kaggle's free 30 GPU-hours/week can absorb your lowest-priority workloads. Route "non-urgent" clips (scheduled posts, batch imports) to Kaggle and reserve Colab/GPU instances for real-time processing.

**Implementation:**
- Tag each processing job with priority: `urgent`, `normal`, `batch`
- `urgent` jobs go to paid GPU (RunPod/Colab Pay-As-You-Go)
- `normal` and `batch` jobs queue for Kaggle
- Kaggle notebook runs on a schedule (every 6 hours) and pulls from the queue

**Savings:** At hobby tier (100 clips/day), if 40% are non-urgent, Kaggle handles 40 clips/day for free. You pay for only 60 clips on Colab.

| Metric | Without Batching | With Batching |
|--------|-----------------|---------------|
| Paid GPU hours/day | 25 hrs | 15 hrs |
| Monthly GPU cost | $90 | $54 |
| **Savings** | | **$36/month (40%)** |

**Tradeoff:** Non-urgent clips take 4-6 hours instead of 15 minutes. Only viable for batch workflows.

### 2. Model Quantization (Saves 30-50% GPU Time)

Whisper-large-v3 runs at full FP32 precision by default. Quantizing to FP16 or INT8 reduces memory usage and inference time with minimal quality loss for transcription.

**Implementation:**
```python
# Instead of:
model = whisper.load_model("large-v3")

# Use:
model = whisper.load_model("large-v3", device="cuda")
model = model.half()  # FP16 quantization
```

For CLIP-based scene detection, use `open_clip` with FP16:
```python
model, _, preprocess = open_clip.create_model_and_transforms(
    'ViT-B-32', pretrained='laion2b_s34b_b79k', precision='fp16'
)
```

**Expected savings:**
| Model | FP32 Time | FP16 Time | Speedup |
|-------|----------|----------|---------|
| Whisper-large-v3 (10 min video) | 180 sec | 110 sec | 1.64x |
| CLIP ViT-B-32 (1,000 frames) | 45 sec | 28 sec | 1.61x |
| Combined per clip | 225 sec | 138 sec | 1.63x |

**Savings at startup tier:** 1,000 clips/day × (225-138) sec = 87,000 sec/day = 24.2 hours/day saved. At $0.44/hour, that is **$320/month saved**.

**Tradeoff:** FP16 requires a GPU with compute capability ≥ 7.0 (all modern NVIDIA GPUs). INT8 quantization is faster but may degrade transcription accuracy for non-English languages.

### 3. Smart Frame Sampling (Saves 40-60% CLIP Processing Time)

Instead of analyzing every frame for scene detection, use adaptive sampling: analyze 1 frame per second initially, then increase density only around detected scene boundaries.

**Implementation:**
- Pass 1: Sample at 1 FPS, run CLIP embeddings
- Pass 2: For segments with high embedding variance (>0.15 cosine distance), sample at 4 FPS
- Pass 3: Refine boundaries to exact frame

**Expected savings:**
| Method | Frames Analyzed | Time per 10-min Video |
|--------|----------------|----------------------|
| Naive (all frames) | 18,000 | 45 sec |
| Fixed 1 FPS | 600 | 15 sec |
| Adaptive 1 FPS + targeted 4 FPS | ~900 | 22 sec |

Adaptive sampling is 2x faster than naive and only 30% slower than fixed 1 FPS, with significantly better scene boundary detection.

**Monthly savings at startup tier:** ~$15-25/month in GPU time.

### 4. Spot/Preemptible Instances (Saves 40-60% GPU Cost)

Vast.ai spot instances and RunPod spot pods offer 40-60% discounts over on-demand pricing. The tradeoff: instances can be terminated with 30-second notice.

**Implementation requirements:**
- Checkpoint processing state to R2 every 2 minutes
- Store `last_processed_frame` and `partial_results` in the checkpoint
- On instance termination, re-queue the job with resume from checkpoint
- Set `max_retries = 3` per job

**Cost comparison:**
| Provider | On-Demand | Spot | Savings |
|----------|----------|------|---------|
| Vast.ai RTX 4090 | $0.45/hr | $0.22/hr | 51% |
| RunPod RTX 4090 | $0.44/hr | $0.25/hr | 43% |

**At startup tier:** $110/month → $60-65/month. **Savings: $45-50/month.**

**Tradepoint:** Interruption rate varies (5-15% depending on provider and time of day). Budget for 10-15% job restarts.

## Storage Optimizations

### 5. Aggressive Lifecycle Policies (Saves 60-70% Storage)

Most users access clips heavily for 3-7 days, then rarely. Implement a tiered lifecycle:

| Age | Action | Storage Cost |
|-----|--------|-------------|
| 0-7 days | Full quality (source + clips) | Standard R2 ($0.015/GB) |
| 7-30 days | Clips only (source eligible for deletion per retention policy) | Standard R2 |
| 30-90 days | Compressed clips (H.265, 50% bitrate) | Standard R2 |
| 90+ days | Delete (user can re-process) | $0 |

**R2 lifecycle rule configuration:**
```json
{
  "rules": [
    {
      "id": "delete-source-after-30-days",
      "enabled": true,
      "path": "projects/*/source/",
      "expiration": { "days": 30 }
    },
    {
      "id": "compress-clips-after-30-days",
      "enabled": true,
      "path": "projects/*/clips/",
      "transition": { "days": 30, "storageClass": "STANDARD_IA" }
    }
  ]
}
```

**Savings at startup tier:** Without lifecycle, 1,000 clips/day × 30 days × 400 MB = 12 TB. With lifecycle (30-day source retention), steady state drops to ~6 TB. **Savings: $90/month.**

### 6. Source Video Transcoding to Efficient Codec (Saves 30-40% Storage)

Many uploaded videos use H.264 at high bitrates. Transcode to H.265 (HEVC) at perceptually equivalent quality for 30-40% smaller files.

**Implementation:**
```bash
ffmpeg -i input.mp4 -c:v libx265 -crf 28 -preset fast -c:a aac -b:a 128k output.mp4
```

| Codec | 10-min 1080p Size | Quality |
|-------|------------------|---------|
| H.264 CRF 23 | 280 MB | Excellent |
| H.265 CRF 28 | 165 MB | Excellent |
| H.265 CRF 30 | 120 MB | Good |

**Savings:** At 1,000 clips/day, transcoding saves ~115 GB/day = 3.45 TB/month. At R2 pricing, that is **$50/month saved**.

**Tradeoff:** Transcoding adds ~30 seconds per video to processing time. H.265 decoding is slightly slower for preview playback, but modern browsers handle it fine via hardware acceleration.

### 7. Deduplicate Thumbnails and Previews

Many clips share similar visual content. Use perceptual hashing (pHash) to detect near-duplicate thumbnails and store one copy with references.

**Implementation:**
- Compute pHash for each thumbnail on generation
- If Hamming distance < 10 to an existing thumbnail, store a reference instead of a new file
- Expected deduplication rate: 15-25% for typical video content

**Savings:** Minimal per-video (~50 KB), but at 30,000 clips/month, saves ~300-500 MB/month. Primarily reduces Class A write operations.

## Database Optimizations

### 8. JSONB Metadata Instead of Separate Tables

Store clip metadata, processing logs, and user preferences as JSONB columns in a single `projects` table instead of normalized relational tables.

**Why this helps:**
- Fewer round-trips to Supabase (1 query instead of 3-5)
- JSONB indexing is fast enough for metadata queries
- Reduces Supabase connection pool pressure
- Smaller database footprint (no join tables)

**Schema:**
```sql
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  title TEXT NOT NULL,
  status TEXT DEFAULT 'processing',
  metadata JSONB DEFAULT '{}',
  clips JSONB DEFAULT '[]',
  processing_log JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_projects_user ON projects(user_id);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_clips ON projects USING GIN(clips);
```

**Savings:** Reduces database size by ~30%, fewer connections needed, simpler queries. Indirect savings from avoiding Supabase compute upgrades longer.

### 9. Archive Completed Projects to R2

After 30 days, move project metadata from Supabase to R2 as JSON files. Keep only a lightweight record (id, title, created_at, clip_count) in the database.

**Implementation:**
- Cloudflare Worker runs daily
- Queries projects where `updated_at < now() - interval '30 days'`
- Dumps full project JSON to R2: `archive/{user_id}/{project_id}.json`
- Updates Supabase record to minimal fields

**Savings:** At 30,000 projects/month, each 18 KB, database grows 540 MB/month. Archiving after 30 days keeps database under 200 MB permanently. Avoids Supabase storage add-on ($25/month for 50 GB).

## Hosting Optimizations

### 10. Migrate to Cloudflare Pages (Saves $200+/month at Growth Tier)

Vercel Pro charges $20/month per member + bandwidth overage ($40/100 GB). Cloudflare Pages has zero bandwidth fees.

| Provider | Monthly Cost (1 TB bandwidth) |
|----------|------------------------------|
| Vercel Pro | $240 |
| Cloudflare Pages | $0 (free) |
| **Savings** | **$240/month** |

**Migration effort:** Medium. Cloudflare Pages supports Next.js but with some limitations:
- No ISR (Incremental Static Regeneration) — use on-demand revalidation via Workers
- No Node.js runtime in Functions — use Workers for API routes
- No Image Optimization API — implement via Cloudflare Image Resizing ($1/100K requests)

**When to migrate:** When Vercel bandwidth overage exceeds $50/month consistently.

### 11. Edge-First Architecture with Cloudflare Workers

Move API logic from Vercel Serverless Functions to Cloudflare Workers. Workers run at the edge (300+ locations globally) with sub-millisecond cold starts.

**What to move:**
- Webhook handlers (RunPod job completion callbacks)
- Status polling endpoints
- Authentication middleware
- Rate limiting
- URL shortening for clip sharing

**What to keep on Vercel:**
- Next.js page rendering (SSR/SSG)
- Image optimization
- Complex API routes requiring Node.js runtime

**Savings:** Workers Paid is $5/month base. Moving 80% of API traffic from Vercel to Workers reduces Vercel function executions by 80%, extending the time before you need compute upgrades.

## Network Optimizations

### 12. Cloudflare CDN for Clip Delivery

Serve all clips through Cloudflare's CDN (free with R2). Cache clips at edge locations for 7 days.

**Configuration:**
```
Cache-Control: public, max-age=604800, s-maxage=604800
```

**Impact:** First request for a clip hits R2 (origin). Subsequent requests from the same region hit the CDN edge (0 ms latency, zero origin bandwidth). For popular clips, this eliminates 90%+ of R2 reads.

**Savings:** Reduces R2 Class B operations by 80-90%. At growth tier (2M reads/month), this saves potential overage costs and improves user experience.

## Optimization Priority Matrix

| Optimization | Savings | Effort | Priority |
|-------------|---------|--------|----------|
| Batch processing on Kaggle | $36/month | Low | **Do first** |
| FP16 quantization | $320/month | Low | **Do first** |
| Smart frame sampling | $20/month | Medium | Do second |
| Spot instances | $45/month | Medium | Do second |
| Lifecycle policies | $90/month | Low | **Do first** |
| H.265 transcoding | $50/month | Low | Do second |
| Cloudflare Pages migration | $240/month | High | Do when scaling |
| JSONB schema | Indirect | Low | Do first |
| Project archiving | $25/month | Medium | Do second |
| CDN caching | Varies | Low | Do first |

## Combined Optimization Impact

**Hobby tier (100 clips/day):**
| Item | Before | After |
|------|--------|-------|
| GPU compute | $90 | $18 (Kaggle batching + FP16) |
| Storage | $9 | $3 (lifecycle) |
| **Total** | **$99** | **$21/month** |

**Startup tier (1,000 clips/day):**
| Item | Before | After |
|------|--------|-------|
| GPU compute | $110 | $35 (spot + FP16 + smart sampling) |
| Storage | $59 | $25 (lifecycle + H.265) |
| Database | $25 | $25 |
| Hosting | $40 | $40 |
| Workers | $5.50 | $5.50 |
| **Total** | **$240.50** | **$130.50/month** |

**Growth tier (10,000 clips/day):**
| Item | Before | After |
|------|--------|-------|
| GPU compute | $1,109 | $450 (spot + FP16 + smart sampling) |
| Storage | $221 | $95 (lifecycle + H.265) |
| Database | $100 | $75 (archiving) |
| Hosting | $240 | $5 (Cloudflare Pages) |
| Workers | $22.50 | $22.50 |
| Monitoring | $48 | $48 |
| **Total** | **$1,740.50** | **$695.50/month** |

## Monitoring Cost in Production

Set up budget alerts to prevent surprises:

1. **Cloudflare R2:** Monitor via R2 API (`GET /r2/billing`). Alert at 80% of expected storage.
2. **Supabase:** Monitor via Supabase dashboard. Alert at 70% of database storage.
3. **RunPod:** Set monthly spending cap in dashboard. Alert at $500 (startup) or $800 (growth).
4. **Vercel:** Enable spend management in project settings. Set hard limit.
5. **Cloudflare Workers:** Monitor via Analytics API. Alert at 80K requests/day.

Create a weekly cost review routine. Check each service's dashboard every Monday. Track cost-per-clip trend — it should decrease over time as optimizations compound.

**See also:** [01-free-tier-costs.md](01-free-tier-costs.md) | [02-production-costs.md](02-production-costs.md)
