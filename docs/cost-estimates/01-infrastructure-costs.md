# Infrastructure Costs

This document details the infrastructure costs for running MiniOp across two deployment profiles: **Free Tier** (200–500 clips/month) and **Scaled Production** (3,000+ clips/month). All pricing is based on publicly available rates as of June 2026.

---

## Architecture Overview

MiniOp's infrastructure breaks down into five layers:

1. **Compute** — AI inference (scene detection, transcription, captioning, scoring)
2. **Storage** — video files, thumbnails, metadata
3. **Frontend Hosting** — web app, static assets, SSR
4. **Backend/API** — job orchestration, auth, database
5. **Edge/CDN** — content delivery, rate limiting, caching

---

## Free Tier (~200–500 clips/month)

### Compute: Google Colab + Kaggle

The primary inference pipeline runs on free GPU notebooks.

| Resource | Provider | Free Allowance | MiniOp Usage |
|----------|----------|----------------|--------------|
| GPU Runtime (T4) | Google Colab | ~4-12 hrs/session, variable availability | 3-6 min/clip → 200 clips = 20 hrs/month |
| GPU Runtime (P100/T4) | Kaggle | 30 hrs/week GPU | Backup when Colab throttles |
| CPU Runtime | Google Colab | Unlimited (low priority) | Pre/post-processing |

**Monthly compute cost: $0**

Colab free tier provides T4 GPUs which handle MiniOp's pipeline (Whisper-base, CLIP scoring, scene detection) comfortably. Sessions last ~4-12 hours depending on GPU availability and usage patterns. Kaggle's 30 hrs/week guaranteed GPU quota acts as overflow — split workloads across both platforms.

**Practical limits:**
- Colab sessions last ~4-12 hrs/session with variable availability; sessions disconnect after inactivity
- Kaggle caps at 30 GPU-hours/week guaranteed (120/month), enough for ~1,200 clips
- Combined capacity: ~500 clips/month before hitting soft throttles

### Storage: Cloudflare R2

| Metric | Value | Cost |
|--------|-------|------|
| Storage (10 GB) | 10 GB × $0.015/GB | $0.15 |
| Class A writes (500 ops) | 500 × $4.50/million | ~$0.00 |
| Class B reads (2,000 ops) | 2,000 × $0.36/million | ~$0.00 |
| Egress | **Free** (no egress fees) | $0.00 |

**Monthly storage cost: ~$0.15**

R2's free tier includes 10 GB storage and 10M Class A / 50M Class B operations per month. At 200–500 clips with average 30 MB per output clip, you consume 6–15 GB. The first 10 GB is free; the remaining 5 GB costs $0.075.

### Frontend: Vercel

| Metric | Free Allowance | MiniOp Usage |
|--------|----------------|--------------|
| Bandwidth | 100 GB/month | ~5 GB (UI assets, dashboards) |
| Serverless Function executions | 1M/month | ~50K (API calls) |
| Build minutes | 6,000/month | ~200 (CI/CD) |
| Concurrent builds | 1 | Sufficient |

**Monthly frontend cost: $0**

Vercel's free tier (Hobby) is more than enough for the web dashboard. The Next.js app serves static pages with client-side rendering for the clip editor, keeping serverless function usage minimal.

### Backend: Supabase

| Metric | Free Allowance | MiniOp Usage |
|--------|----------------|--------------|
| Database | 500 MB | ~50 MB (job metadata, user data) |
| Auth | 50,000 MAUs | ~100 users |
| Storage | 1 GB | Thumbnails only (~200 MB) |
| Edge Functions | 500K invocations | ~20K/month |
| Realtime | 200 concurrent connections | ~10 peak |

**Monthly backend cost: $0**

Supabase free tier provides a full Postgres database with Row Level Security, auth, and edge functions. The 500 MB database can hold approximately 500,000 clip metadata records — far beyond the 500/month target.

### Edge/CDN: Cloudflare Workers

| Metric | Free Allowance | MiniOp Usage |
|--------|----------------|--------------|
| Requests | 100,000/day | ~2,000/day |
| CPU time | 10 ms/invocation | ~5 ms average |
| KV reads | 100,000/day | ~1,000/day |
| KV writes | 1,000/day | ~100/day |

**Monthly edge cost: $0**

Workers handle rate limiting, webhook routing, and lightweight API proxying. The free tier's 100K requests/day is sufficient for 200–500 clips/month with typical user interaction patterns.

### Free Tier Summary

| Layer | Monthly Cost |
|-------|-------------|
| Compute (Colab + Kaggle) | $0.00 |
| Storage (Cloudflare R2) | $0.15 |
| Frontend (Vercel) | $0.00 |
| Backend (Supabase) | $0.00 |
| Edge (Cloudflare Workers) | $0.00 |
| **Total** | **$0.15** |

---

## Scaled Production (~3,000+ clips/month)

At 3,000 clips/month, free tiers break down. Here's what changes and what it costs.

### Compute: Colab Pro + RunPod Workers

| Resource | Provider | Monthly Cost | Notes |
|----------|----------|-------------|-------|
| Colab Pro | Google | $9.99 | Priority T4/A100, longer sessions |
| RunPod Persistent Pod | RunPod | ~$53 | RTX 3090, 8 hrs/day (~$0.22/hr) |

**Calculation for RunPod persistent pod:**
- RTX 3090 at $0.22/hr × 8 hrs/day × 30 days = ~$53/month
- Handles 3,000+ clips/month with headroom

**Monthly compute cost: ~$63**

Colab Pro handles development, testing, and overflow. RunPod persistent pod handles the production workload with consistent availability. The RTX 3090 processes clips reliably at ~2-3 min per clip.

### Storage: Cloudflare R2 (Scaled)

| Metric | Value | Cost |
|--------|-------|------|
| Storage (100 GB) | 100 GB × $0.015/GB | $1.50 |
| Class A writes (3,000 ops) | 3,000 × $4.50/million | $0.01 |
| Class B reads (15,000 ops) | 15,000 × $0.36/million | $0.01 |
| Egress | Free | $0.00 |

**Monthly storage cost: $1.52**

At 3,000 clips/month with 30 MB average output, you accumulate ~90 GB/month. Implement a 90-day retention policy to cap storage at ~270 GB ($4.05/month). With lifecycle rules deleting older clips, steady-state stays near 100 GB.

### Frontend: Vercel Pro

| Metric | Cost |
|--------|------|
| Pro plan | $20/month per member |
| Additional bandwidth (over 1 TB) | $40/100 GB |

**Monthly frontend cost: $20**

One developer seat on Vercel Pro ($20/month) removes the Hobby tier's concurrent build limits and adds preview deployments. The 1 TB bandwidth allowance covers ~3,000 users browsing clip previews comfortably. Add a second seat only if you have a dedicated frontend developer.

### Backend: Supabase Pro

| Metric | Cost |
|--------|------|
| Pro plan | $25/month |
| Includes 8 GB database | Sufficient |
| Includes 100 GB storage | Sufficient |
| Includes 250K Edge Function invocations | Sufficient |
| Additional database (if needed) | $0.125/GB |

**Monthly backend cost: $25**

Supabase Pro removes the free tier's connection limits and adds point-in-time recovery. The 8 GB database handles 3,000 clips/month metadata plus user accounts, job queues, and analytics without needing add-ons.

### Edge/CDN: Cloudflare Workers Paid

| Metric | Cost |
|--------|------|
| Workers Paid plan | $5/month |
| Includes 10M requests/month | Sufficient |
| Additional requests | $0.30/million |

**Monthly edge cost: $5**

The paid plan removes the 100K/day request cap and adds Durable Objects for stateful rate limiting. At 3,000 clips/month, expect ~60K requests/day — well within the 10M monthly allowance.

### Scaled Production Summary

| Layer | Monthly Cost |
|-------|-------------|
| Compute (Colab Pro + RunPod) | $63 |
| Storage (Cloudflare R2) | $1.52 |
| Frontend (Vercel Pro) | $20.00 |
| Backend (Supabase Pro) | $25.00 |
| Edge (Cloudflare Workers) | $5.00 |
| **Total** | **$114.52** |

---

## Cost Optimization Strategies

### At Free Tier
- **Rotate Colab accounts** — use multiple Google accounts to bypass session limits
- **Implement client-side compression** — reduce R2 storage by compressing before upload
- **Cache aggressively** — use Cloudflare's page rules to cache static clip previews

### At Scale
- **Spot instances over on-demand** — RunPod spot is 60–70% cheaper than on-demand
- **R2 lifecycle rules** — auto-delete source videos after processing, keep only final clips
- **Batch processing** — queue clips and process in bulk during off-peak GPU pricing
- **Supabase connection pooling** — use Supavisor to reduce database connection overhead

### Break-Even Analysis

| Clips/Month | Recommended Tier | Monthly Cost | Cost/Clip |
|-------------|-----------------|-------------|-----------|
| 0–500 | Free | $0.15 | $0.0003 |
| 500–1,500 | Hybrid (Colab Pro + Free services) | $10.14 | $0.007 |
| 1,500–3,000 | Mixed (Colab Pro + some paid) | $40–55 | $0.018 |
| 3,000+ | Full scaled production | $115 | $0.038 |

---

## Monitoring Costs

Set up billing alerts on every provider:

- **Google Cloud**: Budget alert at $15/month on Colab Pro
- **RunPod**: Spending cap at $60/month
- **Vercel**: Usage dashboard, alert at 80% bandwidth
- **Supabase**: Dashboard monitoring, alert at 80% database
- **Cloudflare**: Analytics dashboard, alert at 50% of free tier

This infrastructure keeps MiniOp operational from prototype to production at under $115/month for 3,000+ clips — roughly $0.04 per clip at scale.
