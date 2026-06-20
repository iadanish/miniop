# Free Tier Costs: Running MiniOp for $0/Month

MiniOp is designed to run entirely on free tiers during development and early production. This document breaks down every free-tier service, its limits, what happens when you exceed them, and the real cost of staying free.

## Service-by-Service Free Tier Breakdown

### GPU Compute: Google Colab Free

Google Colab Free provides Tesla T4 (15 GB VRAM) access with no billing required.

| Resource | Free Limit | MiniOp Usage per 10-min Video |
|----------|-----------|-------------------------------|
| GPU sessions | ~4-6 hrs/day (variable) | 8-15 minutes processing |
| RAM | 12.7 GB | 4-6 GB peak |
| Disk | ~100 GB (ephemeral) | 2-3 GB per session |
| Concurrent sessions | 1 | 1 |

**What this means:** You can process roughly 20-40 short clips per day on Colab Free. Google enforces dynamic usage limits — heavy users get throttled to 1-2 hours. There is no published SLA; sessions disconnect after 90 minutes of inactivity or 12 hours maximum.

**Hidden cost:** Colab sessions are ephemeral. Every restart requires reinstalling dependencies (~3-5 minutes). Over a month of daily use, you lose ~2-3 hours to setup overhead.

**Realistic throughput:** 15-25 clips/day assuming 8-12 active GPU hours and 15 minutes per clip (including download, process, upload).

### GPU Compute: Kaggle Notebooks

Kaggle provides 30 hours/week of GPU time on Tesla P100 (16 GB VRAM) or T4.

| Resource | Free Limit | Notes |
|----------|-----------|-------|
| GPU hours | 30 hrs/week | Resets every Monday 00:00 UTC |
| CPU-only hours | Unlimited | Not viable for video processing |
| RAM | 16 GB (P100) | Better than Colab |
| Internet access | Disabled by default | Must enable in notebook settings |
| Persistence | Output only (20 GB) | No filesystem persistence |

**What this means:** 30 hours/week = ~120-180 clips/week, or ~17-25 clips/day if you spread usage evenly. Kaggle is more predictable than Colab but has a hard weekly cap.

**Combined Colab + Kaggle throughput:** 32-50 clips/day with manual session management.

### Storage: Cloudflare R2 Free Tier

R2 provides the most generous free object storage tier available.

| Resource | Free Limit | Overage Cost |
|----------|-----------|-------------|
| Storage | 10 GB | $0.015/GB/month |
| Class A operations (writes) | 1M/month | $4.50/million |
| Class B operations (reads) | 10M/month | $0.36/million |
| Egress | Free (always) | $0 |

**MiniOp storage math:**
- 10-minute source video: ~150-300 MB (1080p H.264)
- 10 extracted clips (30-60s each): ~50-100 MB total
- Thumbnails + metadata: ~5 MB
- **Per-video footprint:** ~350-400 MB
- **Free tier capacity:** ~25-28 videos stored simultaneously

**Key advantage:** R2 has zero egress fees. Serving clips to users costs nothing regardless of volume. This is the single biggest cost advantage over AWS S3 ($0.09/GB egress) or GCS ($0.12/GB egress).

**Practical limit:** At 25 videos stored, you need to implement lifecycle rules to delete source videos after processing. Keep only final clips + metadata to extend capacity to ~100+ projects.

### Database: Supabase Free Tier

| Resource | Free Limit | Notes |
|----------|-----------|-------|
| Database | 500 MB | Postgres with full feature set |
| Auth | 50,000 MAU | More than enough |
| Storage | 1 GB | For supplementary files |
| Edge Functions | 500K invocations/month | Cold start ~250ms |
| Bandwidth | 5 GB | Combined across all services |
| Realtime connections | 200 concurrent | WebSocket connections |

**MiniOp database usage per project:**
- Project metadata: ~2 KB
- Clip metadata (10 clips): ~5 KB
- Processing status logs: ~10 KB
- User/session data: ~1 KB
- **Per project:** ~18 KB
- **Free tier capacity:** ~27,000 projects (database is not the bottleneck)

**The 500 MB database limit** will never be your constraint. You will hit the 1 GB storage limit or 5 GB bandwidth limit first.

### Hosting: Vercel Free Tier

| Resource | Free Limit | Notes |
|----------|-----------|-------|
| Serverless executions | 100 GB-hours/month | Cold start ~250ms |
| Edge executions | 1M units/month | Global edge network |
| Bandwidth | 100 GB/month | Combined edge + serverless |
| Build minutes | 6,000/month | ~200 builds/day |
| Max execution duration | 10 seconds (serverless) | 30 seconds (edge) |
| Concurrent builds | 1 | Serial deploys |
| Projects | Unlimited | No limit on repos |

**MiniOp frontend cost:** A Next.js dashboard serving 1,000 daily active users consumes roughly 5-15 GB-hours/month of serverless compute and 20-40 GB/month bandwidth. Well within limits.

**Vercel's 10-second serverless timeout** is the real constraint. Any API route that calls external services (Supabase, R2, processing status) must complete within 10 seconds. Use Edge Functions (30s limit) or stream responses for long operations.

### Background Jobs: Cloudflare Workers Free Tier

| Resource | Free Limit | Notes |
|----------|-----------|-------|
| Requests | 100,000/day | ~3M/month |
| CPU time | 10 ms/invocation | Hard limit, no overage |
| Wall-clock time | 30 seconds (via `waitUntil`) | For async operations |
| KV reads | 100,000/day | Key-value storage |
| KV writes | 1,000/day | Write-heavy workloads beware |
| Durable Objects | Not available on free tier | Requires paid plan |

**MiniOp usage:** Workers handle webhook callbacks, status polling, and lightweight API routing. 100K requests/day supports ~1,000 active projects with 100 status checks each.

**The 10ms CPU limit** means you cannot do video processing in Workers. Use Workers only for orchestration (triggering Colab/Kaggle jobs, updating status, routing requests).

## Total Free Tier Capacity Summary

| Metric | Free Capacity | Bottleneck |
|--------|--------------|------------|
| Clips/day | 32-50 | GPU compute (Colab + Kaggle) |
| Stored videos | 25-100 | R2 storage (10 GB) |
| Database records | ~27,000 projects | Supabase DB (500 MB) |
| Frontend users | ~5,000 DAU | Vercel bandwidth (100 GB) |
| API requests | ~3M/month | Cloudflare Workers (100K/day) |

## Where Free Tiers Break Down

1. **GPU availability is unreliable.** Colab Free has no SLA. During peak hours (US business hours), you may get zero GPU access. Kaggle's 30-hour weekly cap is predictable but inflexible.

2. **No concurrent processing.** Both Colab and Kaggle free tiers support only one GPU session. You cannot parallelize clip generation.

3. **Ephemeral compute loses state.** If a Colab session disconnects mid-processing, you lose all progress. Implement checkpointing — save intermediate results to R2 every 2-3 minutes of processing.

4. **Supabase bandwidth (5 GB)** is the sleeper constraint. Serving 1,000 clip previews at 50 MB each = 50 GB. You must use R2 for all media serving, never Supabase Storage.

5. **Vercel's 10-second timeout** forces architectural decisions early. Any operation that might take longer must be async: queue the job, return immediately, poll for status.

## Monthly Cost at Free Tier: $0.00

Every service listed above has a genuine $0 tier with no credit card required (Colab, Kaggle) or generous free allocations (R2, Supabase, Vercel, Workers). The only cost is your time managing sessions and working around limits.

**Next step:** When free-tier limits become a daily blocker, see [02-production-costs.md](02-production-costs.md) for scaled pricing.
