# Migration Path: Free Tier to Production

## Overview

This document provides step-by-step migration procedures for moving MiniOp from the free tier stack (Colab + Supabase Free + Vercel Hobby + R2 Free) to the production stack (GPU Workers + Supabase Pro + Vercel Pro + Cloudflare Workers). Each section covers one component with rollback procedures.

## Migration Order

Migrate in this order to minimize risk:

1. **R2 Storage** — Zero downtime, no data migration needed
2. **Supabase** — In-place upgrade, automatic migration
3. **Cloudflare Workers** — New component, additive
4. **GPU Worker** — Replace Colab, one-time cutover
5. **Vercel** — In-place upgrade, automatic

```
Week 1: R2 + Supabase upgrade
Week 2: Deploy Cloudflare Workers
Week 3: Deploy GPU worker, run parallel with Colab
Week 4: Cut over fully, Vercel upgrade
```

## Phase 1: Cloudflare R2 (No Migration Needed)

R2 from free to paid is seamless. You stay on the same bucket, same credentials, same API. The free tier limits are soft limits — you pay per-use beyond them.

**Action: Enable billing**

1. Go to Cloudflare Dashboard → R2 → Billing
2. Add a payment method
3. Set a spending limit alert at $10/month

**Verify:**

```bash
# Check current usage
wrangler r2 bucket info minio-clips

# Test write access
echo "test" | wrangler r2 object put minio-clips/migration-test.txt --pipe
wrangler r2 object delete minio-clips/migration-test.txt
```

**Rollback:** Remove payment method. You revert to free tier limits.

## Phase 2: Supabase Free → Pro

Supabase upgrades are in-place. Your database, auth, and storage migrate automatically with zero downtime.

### Pre-migration Checklist

```sql
-- Run in Supabase SQL Editor to check current state

-- Database size
SELECT pg_size_pretty(pg_database_size(current_database()));

-- Table sizes
SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC;

-- Active connections
SELECT count(*) FROM pg_stat_activity;

-- Pending jobs count
SELECT status, count(*) FROM processing_queue GROUP BY status;
```

### Upgrade Steps

1. **Backup the database first:**

```bash
# Using Supabase CLI
supabase db dump --db-url "postgresql://postgres:[password]@db.[project-ref].supabase.co:5432/postgres" > backup_$(date +%Y%m%d).sql

# Or use pg_dump directly
pg_dump "postgresql://postgres:[password]@db.[project-ref].supabase.co:5432/postgres" \
  --format=custom \
  --file=minio_backup_$(date +%Y%m%d).dump
```

2. **Upgrade in dashboard:**

- Go to Supabase Dashboard → Settings → Billing
- Click "Upgrade to Pro"
- Confirm ($25/month)
- Upgrade completes in ~2 minutes

3. **Enable connection pooling (critical for serverless):**

```
# In Supabase Dashboard → Settings → Database
# Connection Pooling:
#   Mode: Transaction
#   Pool Size: 15
#   Default Query Timeout: 10s

# Your new connection string:
# Transaction mode: postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
```

4. **Update environment variables:**

```bash
# Update in Vercel
vercel env rm DATABASE_URL
vercel env add DATABASE_URL
# Enter the new pooled connection string

# Update in Cloudflare Workers (later)
wrangler secret put SUPABASE_URL
```

5. **Verify:**

```sql
-- Check extensions available
SELECT * FROM pg_available_extensions WHERE name IN ('pg_cron', 'vector', 'pg_net');

-- Enable pgvector for future semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- Test pg_cron
SELECT cron.schedule('test-job', '* * * * *', 'SELECT 1');
SELECT cron.unschedule('test-job');
```

### Post-migration: Add Production Database Objects

```sql
-- Atomic job claiming function (replaces polling)
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

-- Job metrics view
CREATE OR REPLACE VIEW job_metrics AS
SELECT
  date_trunc('hour', created_at) AS hour,
  status,
  count(*) AS count,
  avg(extract(epoch FROM (completed_at - started_at))) AS avg_processing_seconds
FROM processing_queue
WHERE created_at > now() - interval '7 days'
GROUP BY 1, 2
ORDER BY 1 DESC;

-- Auto-update project status
CREATE OR REPLACE FUNCTION update_project_status()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE projects SET
    status = CASE
      WHEN EXISTS (
        SELECT 1 FROM clips WHERE project_id = NEW.project_id AND status = 'ready'
      ) THEN 'completed'
      WHEN EXISTS (
        SELECT 1 FROM processing_queue
        WHERE project_id = NEW.project_id AND status = 'processing'
      ) THEN 'processing'
      ELSE status
    END,
    updated_at = now()
  WHERE id = NEW.project_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER on_clip_change
  AFTER INSERT OR UPDATE ON clips
  FOR EACH ROW EXECUTE FUNCTION update_project_status();
```

### Rollback

Supabase Pro can be downgraded back to Free in the same billing section. However:
- You'll lose pg_cron, pgvector, and connection pooling
- Data is preserved, but you may hit free tier limits again
- Downgrade takes effect at the end of the current billing cycle

## Phase 3: Cloudflare Workers (New Component)

This is additive — nothing breaks if the Workers deployment fails. Existing Supabase Edge Functions continue working.

### Setup

```bash
# Install Wrangler
npm install -g wrangler

# Login
wrangler login

# Create the worker project
mkdir -p minio-api && cd minio-api
wrangler init --yes
```

### Create the Worker Code

Replace the generated `src/index.ts` with the API code from [02-paid-production.md](./02-paid-production.md#2-api-gateway-cloudflare-workers-5month).

### Configure Secrets

```bash
# Set secrets (these are encrypted, never visible after setting)
wrangler secret put SUPABASE_URL
# Enter: https://your-project.supabase.co

wrangler secret put SUPABASE_SERVICE_KEY
# Enter: eyJ... (your service role key)
```

### Deploy

```bash
wrangler deploy
# Output: Published minio-api (X.XX sec)
#         https://minio-api.your-subdomain.workers.dev
```

### Test

```bash
# Health check
curl https://minio-api.your-subdomain.workers.dev/api/health

# Submit a test job
curl -X POST https://minio-api.your-subdomain.workers.dev/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "test-uuid",
    "source_url": "https://www.youtube.com/watch?v=test",
    "start_time": 0,
    "end_time": 30,
    "title": "Test clip"
  }'
```

### DNS Setup (Optional Custom Domain)

```bash
# In Cloudflare Dashboard → Workers → minio-api → Settings → Domains & Routes
# Add custom domain: api.yourdomain.com
# Cloudflare handles SSL automatically
```

### Rollback

```bash
# Delete the worker
wrangler delete minio-api

# Revert frontend environment variables to use Supabase Edge Functions
```

## Phase 4: GPU Worker (Replace Colab)

This is the most complex migration. Run the GPU worker in parallel with Colab for one week before cutting over.

### Step 1: Prepare the Worker Image

```bash
# Clone the repo
git clone https://github.com/your-org/minio.git
cd minio

# Build the worker Docker image
docker build -t yourusername/minio-worker:latest -f worker/Dockerfile .

# Test locally (requires ffmpeg)
docker run --rm \
  -e SUPABASE_URL=https://your-project.supabase.co \
  -e SUPABASE_SERVICE_KEY=your-key \
  -e R2_ENDPOINT=https://account-id.r2.cloudflarestorage.com \
  -e R2_ACCESS_KEY=your-key \
  -e R2_SECRET_KEY=your-secret \
  -e R2_BUCKET=minio-clips \
  yourusername/minio-worker:latest

# Push to registry
docker push yourusername/minio-worker:latest
```

### Step 2: Deploy to RunPod

1. Go to [RunPod.io](https://runpod.io) → Pods → New Pod
2. Select GPU: RTX 3090 (24GB VRAM, $0.22/hr on Community Cloud)
3. Container Image: `yourusername/minio-worker:latest`
4. Environment Variables:
   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_KEY=eyJ...
   R2_ENDPOINT=https://account-id.r2.cloudflarestorage.com
   R2_ACCESS_KEY=your-r2-access-key
   R2_SECRET_KEY=your-r2-secret-key
   R2_BUCKET=minio-clips
   WORKER_ID=runpod-1
   POLL_INTERVAL=10
   ```
5. Select "On-Demand" or "Spot" (Spot is ~40% cheaper but can be interrupted)
6. Deploy

### Step 3: Parallel Operation (1 Week)

Run both systems simultaneously:

- **Colab notebook** continues processing jobs via direct Supabase polling
- **RunPod worker** claims jobs via the `claim_next_job` function

The `FOR UPDATE SKIP LOCKED` in the claim function ensures no duplicate processing. Both workers can poll the same queue safely.

**Monitor for issues:**

```sql
-- Check which worker is processing what
SELECT
  id,
  status,
  started_at,
  payload->>'title' AS title,
  attempts
FROM processing_queue
WHERE created_at > now() - interval '1 day'
ORDER BY created_at DESC;

-- Check for failed jobs
SELECT count(*), date_trunc('hour', created_at) AS hour
FROM processing_queue
WHERE status = 'failed' AND created_at > now() - interval '7 days'
GROUP BY 2 ORDER BY 2 DESC;
```

### Step 4: Cutover

After one week of stable parallel operation:

1. Stop running the Colab notebook
2. Verify RunPod worker is processing all jobs
3. Delete or archive the Colab notebook
4. (Optional) Set up auto-start/stop schedule for RunPod to save costs

**RunPod cost optimization:**

```
# If processing is batchy (e.g., users submit during business hours):
# Use RunPod's "On-Demand" with a cron to scale down overnight

# Schedule: Start at 8 AM UTC, stop at midnight UTC
# Savings: ~66% (8 hours instead of 24)
# Monthly cost: $0.22 × 8 × 30 = $52.80
```

### Rollback

If the GPU worker has issues:

1. Restart the Colab notebook
2. Colab resumes polling the same queue
3. Investigate RunPod logs:
   ```bash
   # RunPod dashboard → Pods → Your Pod → Logs
   # Or SSH into the pod
   ssh root@pod-ip -p 22
   docker logs $(docker ps -q)
   ```

## Phase 5: Vercel Hobby → Pro

### Upgrade Steps

1. Go to Vercel Dashboard → Settings → Billing
2. Upgrade to Pro ($20/month per member)
3. Enable Web Analytics in project settings

### Update Environment Variables for New Architecture

```bash
# Point frontend to Cloudflare Workers API
vercel env rm NEXT_PUBLIC_API_URL
vercel env add NEXT_PUBLIC_API_URL
# Enter: https://minio-api.your-subdomain.workers.dev

# Update Supabase connection to use pooled connection
vercel env rm NEXT_PUBLIC_SUPABASE_URL
vercel env add NEXT_PUBLIC_SUPABASE_URL
# Keep the same URL, but update database connection string if using direct DB access

vercel env rm DATABASE_URL
vercel env add DATABASE_URL
# Enter pooled connection: postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
```

### Update Frontend to Use New API

```typescript
// lib/api.ts
const API_BASE = process.env.NEXT_PUBLIC_API_URL || "/api";

export async function submitClipJob(params: {
  project_id: string;
  source_url: string;
  start_time: number;
  end_time: number;
  title?: string;
}) {
  const resp = await fetch(`${API_BASE}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return resp.json();
}

export async function getJobStatus(jobId: string) {
  const resp = await fetch(`${API_BASE}/jobs/${jobId}`);
  return resp.json();
}

export async function getProjectClips(projectId: string) {
  const resp = await fetch(`${API_BASE}/clips/${projectId}`);
  return resp.json();
}
```

### Rollback

Vercel Pro can be downgraded to Hobby. Changes take effect at the end of the billing cycle. Preview deployments and analytics data are preserved for 30 days.

## Post-Migration Verification Checklist

Run through this checklist after completing all phases:

```bash
# 1. Frontend loads
curl -I https://your-app.vercel.app
# Expected: 200 OK

# 2. API health check
curl https://minio-api.your-subdomain.workers.dev/api/health
# Expected: {"status":"ok","checks":{...}}

# 3. Submit a test job
curl -X POST https://minio-api.your-subdomain.workers.dev/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"project_id":"test","source_url":"https://youtube.com/watch?v=dQw4w9WgXcQ","start_time":0,"end_time":10,"title":"Migration Test"}'
# Expected: {"job_id":"...","status":"queued"}

# 4. Check job was claimed by worker
# (Query Supabase or check RunPod logs)

# 5. Verify clip was created and stored in R2
# (Query clips table, check R2 bucket)

# 6. Verify clip is accessible via frontend
# (Load the clip URL in browser)
```

## Migration Timeline

| Day | Task | Risk | Rollback Time |
|-----|------|------|---------------|
| 1 | Enable R2 billing | None | Instant |
| 1-2 | Upgrade Supabase, backup DB | Low | ~2 min |
| 3-5 | Deploy Cloudflare Workers, test | None (additive) | Delete worker |
| 8-14 | Deploy RunPod worker, parallel run | Low | Restart Colab |
| 15 | Cut over to RunPod only | Medium | Restart Colab |
| 15-16 | Upgrade Vercel, update env vars | Low | Revert env vars |
| 17-21 | Monitor, fix issues | — | Per-component |

## Rollback Emergency Procedure

If everything breaks and you need to revert to free tier immediately:

```bash
# 1. Stop RunPod worker
# RunPod dashboard → Pods → Stop

# 2. Restart Colab notebook
# Open the notebook, run all cells

# 3. Revert frontend to Supabase Edge Functions
vercel env rm NEXT_PUBLIC_API_URL
# Deploy previous commit
vercel --prod

# 4. Downgrade Supabase (takes effect at billing cycle end)
# Dashboard → Settings → Billing → Downgrade

# 5. Delete Cloudflare Worker
wrangler delete minio-api

# 6. Downgrade Vercel (takes effect at billing cycle end)
# Dashboard → Settings → Billing → Downgrade
```

**Data safety:** No data is lost during rollback. R2 clips, Supabase records, and user accounts persist regardless of tier changes. The only risk is during the Supabase backup step — always backup before upgrading.

## Future Scaling (Beyond $100/month)

When you need to scale beyond 3,000 clips/month:

| Scale Target | Solution | Est. Cost |
|-------------|----------|-----------|
| 10,000 clips/month | 2-3 GPU pods, Supabase Pro sufficient | $120-180/month |
| 25,000 clips/month | Dedicated GPU server (Hetzner/OVH), self-hosted Postgres | $200-300/month |
| 50,000+ clips/month | Kubernetes cluster, managed Postgres, multi-region | $500+/month |

See the architecture decision records in the project docs for guidance on when each threshold applies.
