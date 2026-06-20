# Indexing and Performance

MiniOp's workload is read-heavy for the clip editing UI (timeline, transcript viewer, clip list) and write-heavy during video processing (bulk segment insertion, clip rendering status updates). This document defines the complete index strategy, query optimization patterns, and scaling approach from Supabase's free tier to production with millions of transcription segments.

## Index Strategy Overview

Indexes serve two purposes in MiniOp:

1. **RLS policy acceleration** — every query passes through `auth.uid() = user_id`. Without an index on `user_id`, Supabase's RLS becomes a sequential scan.
2. **Application query support** — the clip editor, dashboard, and search features need specific access patterns.

The rule: **every column used in a WHERE clause of an RLS policy gets an index**. Beyond that, index only for measured query patterns.

## Core Indexes (All Tiers)

### RLS Foundation Indexes

These are mandatory. Without them, RLS policies will degrade as the database grows.

```sql
-- Profiles: auth.uid() lookup
CREATE INDEX idx_profiles_id ON public.profiles(id);  -- Already covered by PK

-- Projects: RLS + list by user
CREATE INDEX idx_projects_user_id ON public.projects(user_id)
    WHERE deleted_at IS NULL;

-- Videos: RLS + list by project
CREATE INDEX idx_videos_user_id ON public.videos(user_id)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_videos_project_id ON public.videos(project_id)
    WHERE deleted_at IS NULL;

-- Transcription jobs: RLS + status polling
CREATE INDEX idx_jobs_user_id ON public.transcription_jobs(user_id);
CREATE INDEX idx_jobs_video_id ON public.transcription_jobs(video_id);
CREATE INDEX idx_jobs_status ON public.transcription_jobs(status)
    WHERE status IN ('queued', 'processing');

-- Transcription segments: RLS + timeline query (highest volume)
CREATE INDEX idx_segments_user_id ON public.transcription_segments(user_id);
CREATE INDEX idx_segments_video_id ON public.transcription_segments(video_id, start_time);

-- Clips: RLS + list by video
CREATE INDEX idx_clips_user_id ON public.clips(user_id)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_clips_video_id ON public.clips(video_id, start_time)
    WHERE deleted_at IS NULL;

-- Clip exports: RLS + status polling
CREATE INDEX idx_exports_user_id ON public.clip_exports(user_id);
CREATE INDEX idx_exports_clip_id ON public.clip_exports(clip_id);

-- Usage logs: billing queries
CREATE INDEX idx_usage_user_created ON public.usage_logs(user_id, created_at DESC);
```

### Partial Indexes for Filtered Queries

Partial indexes save space by indexing only the rows the query actually touches:

```sql
-- Only index active jobs (completed/failed are rarely queried)
CREATE INDEX idx_active_jobs ON public.transcription_jobs(user_id, created_at DESC)
    WHERE status IN ('queued', 'processing');

-- Only index clips that haven't been soft-deleted
CREATE INDEX idx_pending_clips ON public.clips(user_id, created_at DESC)
    WHERE status = 'draft' AND deleted_at IS NULL;

-- Only index recent usage logs (billing queries look at current period)
CREATE INDEX idx_current_usage ON public.usage_logs(user_id, action, created_at)
    WHERE created_at > date_trunc('month', now());
```

### Composite Indexes for Common Queries

```sql
-- Clip editor: fetch segments for a video in timeline order
CREATE INDEX idx_segments_timeline ON public.transcription_segments(
    video_id, start_time ASC
);

-- Dashboard: user's recent videos with status
CREATE INDEX idx_videos_dashboard ON public.videos(
    user_id, created_at DESC, status
) WHERE deleted_at IS NULL;

-- AI score leaderboard: find best clips for a video
CREATE INDEX idx_clips_ai_score ON public.clips(
    video_id, ai_score DESC NULLS LAST
) WHERE deleted_at IS NULL AND status = 'ready';
```

## Query Patterns and Optimization

### Pattern 1: Transcript Timeline Loader

When a user opens the clip editor, the frontend loads the full transcript for a video.

**Query:**
```sql
SELECT id, start_time, end_time, text, speaker, confidence, words
FROM public.transcription_segments
WHERE video_id = 'uuid-here'
ORDER BY start_time ASC;
```

**Index used:** `idx_segments_timeline`

**Performance notes:**
- For a 1-hour video (~8,000 segments), this returns ~8,000 rows of ~500 bytes each = ~4MB.
- On Supabase free tier (shared compute), this completes in <100ms with the index.
- For scaled production: consider returning a summary (no `words` JSONB) for the initial load, then lazy-load word-level data on scroll.

**Optimized variant (summary only):**
```sql
SELECT id, start_time, end_time, text, speaker
FROM public.transcription_segments
WHERE video_id = 'uuid-here'
ORDER BY start_time ASC;
```

### Pattern 2: Clip List with Video Context

The dashboard shows a user's clips across all videos.

**Query:**
```sql
SELECT c.id, c.title, c.start_time, c.end_time, c.ai_score, c.status,
       v.title AS video_title
FROM public.clips c
JOIN public.videos v ON v.id = c.video_id
WHERE c.user_id = 'uuid-here'
  AND c.deleted_at IS NULL
ORDER BY c.created_at DESC
LIMIT 20 OFFSET 0;
```

**Index used:** `idx_clips_user_id`

**Performance notes:**
- The partial index (`WHERE deleted_at IS NULL`) means the index is small and fast.
- The JOIN to videos uses `videos` PK index automatically.
- For pagination beyond page 10, switch to cursor-based pagination:

```sql
-- Cursor-based: much faster for deep pagination
SELECT c.id, c.title, c.start_time, c.end_time, c.ai_score, c.status
FROM public.clips c
WHERE c.user_id = 'uuid-here'
  AND c.deleted_at IS NULL
  AND c.created_at < '2024-01-15T10:30:00Z'  -- cursor from last page
ORDER BY c.created_at DESC
LIMIT 20;
```

### Pattern 3: AI Score Filtering

Users filter clips by virality score to find the best segments.

**Query:**
```sql
SELECT id, title, start_time, end_time, ai_score, virality_tags
FROM public.clips
WHERE video_id = 'uuid-here'
  AND ai_score >= 0.7
  AND deleted_at IS NULL
ORDER BY ai_score DESC;
```

**Index used:** `idx_clips_ai_score`

**Performance notes:**
- The partial index includes `ai_score DESC` which satisfies both the filter and the sort.
- `NULLS LAST` in the index definition ensures clips without scores appear at the end.

### Pattern 4: Usage Billing Query

Summarize current month's credit usage for a user.

**Query:**
```sql
SELECT action, SUM(credits_used) AS total_credits, COUNT(*) AS action_count
FROM public.usage_logs
WHERE user_id = 'uuid-here'
  AND created_at >= date_trunc('month', now())
GROUP BY action;
```

**Index used:** `idx_current_usage`

**Performance notes:**
- The partial index (`WHERE created_at > date_trunc('month', now())`) only indexes the current month's data.
- This index rebuilds itself monthly as old data falls out of the predicate window.

### Pattern 5: Full-Text Search on Transcriptions

Search within a video's transcript for a keyword.

```sql
-- Add a tsvector column (migration)
ALTER TABLE public.transcription_segments
    ADD COLUMN IF NOT EXISTS text_search tsvector
    GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;

-- Index it
CREATE INDEX idx_segments_text_search ON public.transcription_segments
    USING GIN(text_search);

-- Query
SELECT id, start_time, end_time, text
FROM public.transcription_segments
WHERE video_id = 'uuid-here'
  AND text_search @@ plainto_tsquery('english', 'artificial intelligence')
ORDER BY start_time ASC;
```

**Performance notes:**
- The GIN index is large (~30% of the text column size) but makes transcript search instant.
- On free tier: add this only if search is a core feature. Skip it to save storage.
- On production: the GIN index is essential for clip discovery features.

## EXPLAIN ANALYZE for Debugging

Always verify index usage with `EXPLAIN ANALYZE`:

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, start_time, end_time, text
FROM public.transcription_segments
WHERE video_id = 'some-uuid'
ORDER BY start_time ASC;
```

**Look for:**
- `Index Scan using idx_segments_timeline` — good, index is used
- `Seq Scan on transcription_segments` — bad, missing index or stale statistics
- `Sort` node after an Index Scan — index doesn't cover the ORDER BY

**Update statistics if plans look wrong:**
```sql
ANALYZE public.transcription_segments;
```

## Connection Pooling

### Free Tier (Supabase Built-in)

Supabase provides PgBouncer in transaction mode automatically. The connection string from the dashboard uses port 6543 (pooler) by default.

**Key settings:**
- Pool mode: `transaction` (connections returned after each transaction)
- Max connections: 50 (Supabase free), 200 (Pro), 500+ (Team/Enterprise)

**Application code must:**
- Never hold transactions open longer than necessary
- Never use `LISTEN/NOTIFY` through the pooler (use direct connection on port 5432)
- Set `statement_timeout` to prevent runaway queries

```sql
-- In your Supabase SQL Editor or migration
ALTER DATABASE postgres SET statement_timeout = '30s';
```

### Scaled Production

Run PgBouncer on a dedicated instance with tuned settings:

```ini
# pgbouncer.ini
[databases]
miniop = host=your-rds-endpoint port=5432 dbname=miniop

[pgbouncer]
pool_mode = transaction
default_pool_size = 20
max_client_conn = 1000
reserve_pool_size = 5
reserve_pool_timeout = 3
server_lifetime = 3600
server_idle_timeout = 600
```

## Monitoring and Maintenance

### Slow Query Logging

```sql
-- Enable slow query logging (Supabase Pro+)
ALTER SYSTEM SET log_min_duration_statement = 1000;  -- Log queries > 1s
SELECT pg_reload_conf();
```

On Supabase free tier, use the SQL Editor's query performance insights or the `pg_stat_statements` extension:

```sql
-- Top 10 slowest queries
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
```

### Index Usage Statistics

Find unused indexes (consuming write overhead without being read):

```sql
SELECT
    schemaname,
    tablename,
    indexname,
    idx_scan AS times_used,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC;
```

Drop indexes with `times_used = 0` after confirming they aren't needed by RLS policies.

### Table Bloat and VACUUM

High-write tables like `transcription_segments` need regular vacuuming:

```sql
-- Check table bloat
SELECT
    schemaname,
    tablename,
    n_dead_tup,
    n_live_tup,
    round(n_dead_tup::numeric / NULLIF(n_live_tup, 0) * 100, 2) AS dead_pct,
    last_autovacuum
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY n_dead_tup DESC;
```

If `dead_pct > 10%` and `last_autovacuum` is stale:

```sql
VACUUM (VERBOSE, ANALYZE) public.transcription_segments;
```

On Supabase, autovacuum is configured and managed. Only intervene if you see specific bloat issues.

## Scaling Checklist

When moving from free tier to production:

- [ ] Add `user_id` indexes on all RLS-protected tables
- [ ] Add partial indexes for status-based filtering
- [ ] Partition `transcription_segments` by month
- [ ] Enable `pg_stat_statements` for query monitoring
- [ ] Set `statement_timeout` globally (30s for OLTP, 300s for batch)
- [ ] Configure PgBouncer with `transaction` pool mode
- [ ] Set up read replica for analytics queries (Supabase read replicas or Neon branching)
- [ ] Add full-text search GIN index on segments if search is used
- [ ] Monitor index usage monthly and drop unused indexes
- [ ] Set up alerting for queries exceeding 5s

## Next Steps

- Review `01-schema-design.md` for the complete table and RLS definitions.
- Review `02-migrations.md` for `CREATE INDEX CONCURRENTLY` patterns in migration files.
