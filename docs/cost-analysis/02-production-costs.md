# Production Costs: Scaling MiniOp Beyond Free Tiers

When free-tier limits become daily blockers — GPU sessions unavailable, storage full, bandwidth capped — it is time to move to paid infrastructure. This document provides real cost estimates for running MiniOp in production at three scale levels: hobby (100 clips/day), startup (1,000 clips/day), and growth (10,000 clips/day).

## Scale Level 1: Hobby — 100 Clips/Day

At 100 clips/day (~3,000/month), you need reliable GPU access and more storage. Free tiers still cover hosting and database.

### GPU Compute: Colab Pay-As-You-Go or RunPod

**Option A: Google Colab Pay-As-You-Go**
- T4 GPU: $0.12/hour (compute units)
- Processing time per clip: ~12-15 minutes
- 100 clips/day × 15 min = 25 GPU hours/day
- **Monthly cost: 25 hrs × 30 days × $0.12 = $90/month**

Colab Pay-As-You-Go gives you priority GPU access and longer sessions. The T4 is sufficient for Whisper transcription + CLIP-based scene detection on 1080p video.

**Option B: RunPod Serverless**
- T4 GPU: $0.00025/second
- 100 clips × 15 min × 60 sec = 90,000 seconds/day
- **Monthly cost: 90,000 × 30 × $0.00025 = $675/month**

RunPod is 7x more expensive but provides instant cold starts, auto-scaling, and no session management. Use RunPod only if you need sub-second job dispatch.

**Option C: Kaggle Paid (Not Recommended)**
Kaggle does not offer paid GPU tiers. Google's Vertex AI Workbench starts at $0.35/hour for T4, which is 3x Colab pricing with no benefit for this workload.

**Recommendation:** Colab Pay-As-You-Go at $90/month. Write a Colab notebook that auto-starts on schedule via API.

### Storage: Cloudflare R2

At 100 clips/day, you generate ~40 GB of new data daily (source + clips + thumbnails).

| Item | Monthly Volume | Cost |
|------|---------------|------|
| Storage (cumulative, ~600 GB after 15 days avg) | 600 GB | $8.70 |
| Class A operations (writes) | ~6,000/month | Free (within 1M) |
| Class B operations (reads) | ~30,000/month | Free (within 10M) |
| Egress | Unlimited | $0 |

**Monthly R2 cost: ~$9/month**

Implement a 30-day lifecycle policy to auto-delete source videos. Store only final clips and metadata. This keeps storage at ~400-600 GB steady state.

### Database: Supabase Free (Still Viable)

At 100 clips/day, your database grows ~540 KB/month (100 × 30 × 18 KB). The 500 MB limit handles this for years. Supabase Free tier still works.

**Monthly cost: $0**

### Hosting: Vercel Free (Still Viable)

100 clips/day with ~50-100 active users consumes ~5-10 GB bandwidth. Well within the 100 GB free limit.

**Monthly cost: $0**

### Background Jobs: Cloudflare Workers Free (Still Viable)

100 projects × 100 status checks = 10,000 requests/day. The 100,000/day free limit handles 10x this volume.

**Monthly cost: $0**

### Hobby Tier Total

| Service | Monthly Cost |
|---------|-------------|
| GPU Compute (Colab) | $90 |
| Storage (R2) | $9 |
| Database (Supabase Free) | $0 |
| Hosting (Vercel Free) | $0 |
| Background Jobs (Workers Free) | $0 |
| **Total** | **$99/month** |

---

## Scale Level 2: Startup — 1,000 Clips/Day

At 1,000 clips/day (~30,000/month), you need dedicated GPU infrastructure, paid database and hosting, and operational tooling.

### GPU Compute: Dedicated GPU Instance

Colab Pay-As-You-Go becomes unreliable at this volume. You need a dedicated GPU server.

**Option A: Vast.ai (Cheapest)**
- RTX 4090 (24 GB VRAM): $0.35-0.50/hour
- 1,000 clips × 12 min = 200 GPU hours/day
- Need ~8.3 hours of continuous processing per day
- **Monthly cost: 8.3 hrs × 30 days × $0.45 = $112/month**

Vast.ai is a GPU rental marketplace. Prices fluctuate. You get a bare VM with Docker. You manage everything.

**Option B: RunPod Cloud**
- RTX 4090: $0.44/hour
- 200 GPU hours/month = 8.3 hrs/day
- **Monthly cost: 8.3 hrs × 30 × $0.44 = $110/month**

Similar pricing to Vast.ai but with better infrastructure (persistent volumes, API-driven scaling).

**Option C: Lambda Cloud**
- RTX A6000 (48 GB): $0.80/hour
- 200 GPU hours/month
- **Monthly cost: 8.3 hrs × 30 × $0.80 = $200/month**

More expensive but offers better GPUs, persistent storage, and stable pricing. The A6000's 48 GB VRAM allows processing 2-3 clips simultaneously.

**Recommendation:** RunPod Cloud at $110/month. The API-first approach integrates cleanly with Cloudflare Workers for job dispatch.

### Storage: Cloudflare R2

At 1,000 clips/day, storage grows ~400 GB daily.

| Item | Monthly Volume | Cost |
|------|---------------|------|
| Storage (steady state ~4 TB with 30-day lifecycle) | 4,000 GB | $58.50 |
| Class A operations (writes) | ~30,000/month | Free |
| Class B operations (reads) | ~200,000/month | Free |
| Egress | Unlimited | $0 |

**Monthly R2 cost: ~$59/month**

### Database: Supabase Pro

At 1,000 clips/day, you generate ~18 MB of metadata monthly. The database stays small, but you need the Pro tier for:
- 8 GB database (vs 500 MB)
- 250 GB bandwidth (vs 5 GB)
- 1,000 concurrent realtime connections (vs 200)
- Daily backups
- No pausing

| Supabase Pro | Cost |
|-------------|------|
| Base plan | $25/month |
| Compute (small) | Included |
| Database storage (8 GB) | Included |
| **Monthly Supabase cost** | **$25/month** |

### Hosting: Vercel Pro

At 1,000 clips/day with 500-1,000 DAU, you need:
- 1 TB bandwidth (vs 100 GB free)
- 1,000 GB-hours serverless (vs 100 GB-hours free)
- Concurrent builds
- Team collaboration

| Vercel Pro | Cost |
|-----------|------|
| Base plan (per member) | $20/month |
| Additional bandwidth | $40/100 GB overage |
| **Monthly Vercel cost** | **$20-60/month** |

Assume $40/month average with moderate overage.

### Background Jobs: Cloudflare Workers Paid

Workers Paid costs $5/month base + usage.

| Resource | Usage | Cost |
|----------|-------|------|
| Base plan | - | $5/month |
| Requests (1M/month) | 1M | Included |
| CPU time | Standard | Included |
| KV storage (1 GB) | 1 GB | $0.50/month |
| **Monthly Workers cost** | | **$5.50/month** |

### Additional Services

| Service | Purpose | Cost |
|---------|---------|------|
| Sentry (errors) | Error tracking | $0 (free tier, 5K events) |
| Uptime monitoring | Health checks | $0 (UptimeRobot free) |
| Domain + DNS | Cloudflare Registrar | $10-15/year (~$1/month) |
| Email (transactional) | Resend free tier | $0 (3K emails/month) |

### Startup Tier Total

| Service | Monthly Cost |
|---------|-------------|
| GPU Compute (RunPod) | $110 |
| Storage (R2) | $59 |
| Database (Supabase Pro) | $25 |
| Hosting (Vercel Pro) | $40 |
| Background Jobs (Workers Paid) | $5.50 |
| Monitoring + Domain | $1 |
| **Total** | **$240.50/month** |

**Cost per clip: $240.50 / 30,000 = $0.008/clip**

---

## Scale Level 3: Growth — 10,000 Clips/Day

At 10,000 clips/day (~300,000/month), you need multi-GPU infrastructure, optimized storage, and operational maturity.

### GPU Compute: Multi-GPU Cluster

10,000 clips × 12 min = 2,000 GPU hours/day = 83 GPU hours/day continuous.

**Option A: RunPod GPU Cluster**
- 4x RTX 4090: $0.44/hour each
- 83 GPU hours/day ÷ 4 GPUs = ~21 hours/day per GPU
- **Monthly cost: 4 GPUs × 21 hrs × 30 days × $0.44 = $1,109/month**

**Option B: On-Demand Spot Instances (Vast.ai)**
- RTX 4090 spot: $0.20-0.30/hour (varies)
- 83 GPU hours/day
- **Monthly cost: 83 hrs × 30 × $0.25 = $623/month**

Spot pricing is 40-50% cheaper but instances can be interrupted. Implement checkpointing and auto-retry.

**Option C: Self-Hosted GPU Server**
- 2x RTX 4090 system: ~$3,500 upfront + $150/month electricity + $100/month hosting
- Amortized over 12 months: $3,500/12 + $250 = $542/month
- **Monthly cost: $542/month (year 1), $250/month (year 2+)**

Self-hosting becomes cheapest after month 8-10. Requires DevOps capacity.

**Recommendation:** Start with RunPod cluster ($1,109/month), evaluate self-hosting at 20,000+ clips/day.

### Storage: Cloudflare R2

| Item | Monthly Volume | Cost |
|------|---------------|------|
| Storage (steady state ~15 TB with lifecycle) | 15,000 GB | $221 |
| Class A operations (writes) | ~300,000/month | Free |
| Class B operations (reads) | ~2,000,000/month | Free |
| Egress | Unlimited | $0 |

**Monthly R2 cost: ~$221/month**

Compare to AWS S3: storage alone would be ~$345/month, plus ~$900/month in egress fees. R2 saves $1,024/month at this scale.

### Database: Supabase Pro + Compute Add-on

| Item | Cost |
|------|------|
| Pro plan | $25/month |
| Compute (medium, 2 vCPU) | $50/month |
| Database storage (50 GB) | $25/month |
| Bandwidth (250 GB) | Included |
| **Monthly Supabase cost** | **$100/month** |

### Hosting: Vercel Pro (Team)

| Item | Cost |
|------|------|
| Pro plan (2 members) | $40/month |
| Bandwidth overage (~500 GB) | $200/month |
| Edge function executions | Included in base |
| **Monthly Vercel cost** | **$240/month** |

At this scale, consider migrating to Cloudflare Pages (free bandwidth) to save $200+/month.

### Background Jobs: Cloudflare Workers Paid

| Item | Cost |
|------|------|
| Base plan | $5/month |
| Requests (~5M/month) | $5/month overage |
| KV storage (5 GB) | $2.50/month |
| Durable Objects (for queues) | $10/month |
| **Monthly Workers cost** | **$22.50/month** |

### Additional Services

| Service | Purpose | Cost |
|---------|---------|------|
| Sentry (team) | Error tracking | $26/month |
| BetterStack | Uptime + logs | $0 (free tier) |
| Domain + SSL | Cloudflare | $1/month |
| Email (Resend) | Transactional | $20/month (50K emails) |
| Monitoring (Grafana Cloud) | Metrics | $0 (free tier, 10K series) |

### Growth Tier Total

| Service | Monthly Cost |
|---------|-------------|
| GPU Compute (RunPod) | $1,109 |
| Storage (R2) | $221 |
| Database (Supabase Pro+) | $100 |
| Hosting (Vercel Pro) | $240 |
| Background Jobs (Workers) | $22.50 |
| Monitoring + Email + Domain | $48 |
| **Total** | **$1,740.50/month** |

**Cost per clip: $1,740.50 / 300,000 = $0.0058/clip**

---

## Cost Comparison: Free vs. Paid at Each Scale

| Scale | Free Tier | Paid | Cost/Clip |
|-------|----------|------|-----------|
| 100 clips/day | $0 (limited) | $99/month | $0.033 |
| 1,000 clips/day | Not possible | $240.50/month | $0.008 |
| 10,000 clips/day | Not possible | $1,740.50/month | $0.0058 |

The cost per clip decreases with scale due to fixed costs (database, hosting) spreading over more units and GPU utilization improving with dedicated infrastructure.

## Opus Clip Pricing Comparison

Opus Clip charges $19/month for 150 clips (Starter) and $49/month for 500 clips (Pro). Their per-clip cost:

- Starter: $19/150 = $0.127/clip
- Pro: $49/500 = $0.098/clip

MiniOp at startup scale ($0.008/clip) is **12x cheaper** than Opus Clip Pro. Even at hobby scale ($0.033/clip), MiniOp is 3x cheaper. The gap widens with scale.

## When to Move Between Tiers

| Signal | Action |
|--------|--------|
| GPU sessions unavailable >2x/week | Move from Free to Hobby ($99/month) |
| Processing queue >24 hours behind | Add GPU capacity (Hobby → Startup) |
| Storage >80% of R2 free tier | Enable lifecycle policies |
| Vercel bandwidth overage >$50/month | Evaluate Cloudflare Pages migration |
| Database connections dropping | Upgrade Supabase compute |
| >5,000 clips/day sustained | Move to Growth tier with multi-GPU |

**Next step:** See [03-cost-optimization.md](03-cost-optimization.md) for strategies to reduce costs at every tier.
