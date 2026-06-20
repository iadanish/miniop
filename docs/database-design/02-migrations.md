# Database Migrations

This document covers the migration strategy for MiniOp's PostgreSQL schema on Supabase. It addresses the local development workflow, migration naming conventions, rollback patterns, data migrations, and the production deployment pipeline. Whether running the free-tier single-database setup or a scaled deployment with branching and staging environments, this guide provides the exact commands and patterns to follow.

## Migration Tool: Supabase CLI

MiniOp uses the Supabase CLI for all schema management. It wraps PostgreSQL's native migration system with Supabase-specific features like seed files and local development containers.

### Initial Setup

```bash
# Install Supabase CLI
npm install -g supabase

# Initialize Supabase in your project root
supabase init

# Start local Supabase (Docker required)
supabase start
```

This creates the directory structure:

```
supabase/
├── config.toml
├── migrations/
│   └── 20240101000000_initial_schema.sql
├── seed.sql
└── functions/
```

### Linking to Remote Project

```bash
# Link to your Supabase project
supabase link --project-ref your-project-ref

# Pull current remote schema (if migrating existing project)
supabase db pull

# This creates a migration file from the current remote state
# supabase/migrations/20240115120000_remote_schema.sql
```

## Migration Naming Conventions

Every migration file follows the pattern: `YYYYMMDDHHMMSS_descriptive_name.sql`

The timestamp prefix ensures ordering. The name describes the change, not the table.

**Good names:**
- `20240101000000_create_profiles_table.sql`
- `20240115120000_add_clip_virality_score.sql`
- `20240201000000_partition_transcription_segments.sql`

**Bad names:**
- `20240101000000_update.sql` (update what?)
- `20240101000000_fix.sql` (fix what?)
- `profiles.sql` (no timestamp, no verb)

## Creating Migrations

### Option A: Manual SQL File

```bash
# Create a new migration
supabase migration new add_usage_logs_table
```

This creates `supabase/migrations/20240201000000_add_usage_logs_table.sql`. Edit it with your SQL.

### Option B: Diff from Local Changes

```bash
# Make changes to your local database via Supabase Dashboard or SQL
# Then diff against the migration history
supabase db diff --use-migra -f add_usage_logs_table
```

This generates a migration file containing only the delta between your current local state and the last migration.

## Migration Patterns

### Creating a Table

Every migration must be idempotent on Supabase because branching can replay migrations:

```sql
-- supabase/migrations/20240201000000_create_usage_logs.sql

CREATE TABLE IF NOT EXISTS public.usage_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES public.profiles(id),
    action          TEXT NOT NULL CHECK (action IN ('transcription','clip_generation','export','ai_score')),
    credits_used    INTEGER NOT NULL DEFAULT 1,
    resource_type   TEXT,
    resource_id     UUID,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.usage_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'Users can view own usage logs'
    ) THEN
        CREATE POLICY "Users can view own usage logs"
            ON public.usage_logs FOR SELECT
            USING (auth.uid() = user_id);
    END IF;
END $$;

-- Index for billing queries
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_created
    ON public.usage_logs(user_id, created_at DESC);
```

### Adding a Column

```sql
-- supabase/migrations/20240215000000_add_ai_score_to_clips.sql

ALTER TABLE public.clips
    ADD COLUMN IF NOT EXISTS ai_score NUMERIC(4,3);

COMMENT ON COLUMN public.clips.ai_score IS 'Virality score from AI model, range 0.0-1.0';
```

### Adding a Constraint

Constraints that check existing data must be added in two steps to avoid failures on dirty data:

```sql
-- Step 1: Add as NOT VALID
ALTER TABLE public.clips
    ADD CONSTRAINT clips_aspect_ratio_valid
    CHECK (aspect_ratio IN ('9:16','16:9','1:1','4:5')) NOT VALID;

-- Step 2: Validate (scans rows but doesn't hold ACCESS EXCLUSIVE lock)
ALTER TABLE public.clips
    VALIDATE CONSTRAINT clips_aspect_ratio_valid;
```

### Renaming a Column (Zero-Downtime)

On Supabase's free tier, `ALTER TABLE RENAME COLUMN` is instant. But in production with live traffic, use a three-phase approach:

```sql
-- Phase 1: Add new column, backfill, add trigger
ALTER TABLE public.clips ADD COLUMN virality_tags_new TEXT[];

UPDATE public.clips SET virality_tags_new = virality_tags WHERE virality_tags_new IS NULL;

CREATE OR REPLACE FUNCTION sync_virality_tags()
RETURNS TRIGGER AS $$
BEGIN
    NEW.virality_tags_new := NEW.virality_tags;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sync_virality_tags_trigger
    BEFORE INSERT OR UPDATE ON public.clips
    FOR EACH ROW EXECUTE FUNCTION sync_virality_tags();
```

```sql
-- Phase 2: Deploy application code that reads from virality_tags_new
-- Phase 3: After confirming no reads from old column:
DROP TRIGGER sync_virality_tags_trigger ON public.clips;
ALTER TABLE public.clips DROP COLUMN virality_tags;
ALTER TABLE public.clips RENAME COLUMN virality_tags_new TO virality_tags;
```

### Creating an Index (Non-Blocking)

Large tables need `CREATE INDEX CONCURRENTLY` to avoid locking:

```sql
-- supabase/migrations/20240301000000_index_segments_video.sql

-- Note: CONCURRENTLY cannot run inside a transaction block.
-- Supabase migrations run in a transaction by default.
-- Use a raw SQL file or supabase db execute for this.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_segments_video_time
    ON public.transcription_segments(video_id, start_time);
```

For Supabase CLI, you need to split this into a non-transactional migration:

```toml
# supabase/config.toml
[db.migrations]
transactional = false  # Required for CONCURRENTLY
```

Or run it manually:

```bash
supabase db execute --file supabase/migrations/20240301000000_index_segments_video.sql
```

### Adding a Foreign Key

Foreign keys validate existing data on creation. For large tables, add as `NOT VALID` first:

```sql
ALTER TABLE public.transcription_segments
    ADD CONSTRAINT fk_segments_video
    FOREIGN KEY (video_id) REFERENCES public.videos(id) ON DELETE CASCADE
    NOT VALID;

ALTER TABLE public.transcription_segments
    VALIDATE CONSTRAINT fk_segments_video;
```

## Data Migrations

Schema migrations change structure; data migrations change content. Separate them clearly.

### Backfill Pattern

```sql
-- supabase/migrations/20240315000000_backfill_clip_duration.sql

-- Batch update to avoid long-running transactions
DO $$
DECLARE
    batch_size INT := 1000;
    rows_updated INT;
BEGIN
    LOOP
        UPDATE public.clips
        SET duration_seconds = end_time - start_time
        WHERE duration_seconds IS NULL
        LIMIT batch_size;

        GET DIAGNOSTICS rows_updated = ROW_COUNT;
        EXIT WHEN rows_updated = 0;

        PERFORM pg_sleep(0.1);  -- 100ms pause between batches
        RAISE NOTICE 'Updated % rows', rows_updated;
    END LOOP;
END $$;
```

### Idempotent Seed Data

```sql
-- supabase/seed.sql

INSERT INTO public.profiles (id, email, plan, credits_remaining)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'demo@miniop.dev',
    'free',
    10
)
ON CONFLICT (id) DO NOTHING;
```

## Partitioning Migration (Scaled Production)

When `transcription_segments` exceeds ~50M rows, partition by month:

```sql
-- supabase/migrations/20240401000000_partition_segments.sql

-- 1. Rename existing table
ALTER TABLE public.transcription_segments RENAME TO transcription_segments_old;

-- 2. Create partitioned table
CREATE TABLE public.transcription_segments (
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    transcription_job_id UUID NOT NULL,
    video_id        UUID NOT NULL,
    user_id         UUID NOT NULL,
    start_time      NUMERIC(10,3) NOT NULL,
    end_time        NUMERIC(10,3) NOT NULL,
    text            TEXT NOT NULL,
    speaker         TEXT,
    confidence      NUMERIC(4,3),
    words           JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 3. Create partitions (one per month, 12 months ahead)
CREATE TABLE public.transcription_segments_2024_01
    PARTITION OF public.transcription_segments
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

CREATE TABLE public.transcription_segments_2024_02
    PARTITION OF public.transcription_segments
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

-- Continue for each month...

-- 4. Migrate data
INSERT INTO public.transcription_segments
    SELECT * FROM public.transcription_segments_old;

-- 5. Drop old table (after verifying row counts match)
-- DROP TABLE public.transcription_segments_old;

-- 6. Re-create foreign keys and indexes on partitioned table
CREATE INDEX ON public.transcription_segments(video_id, start_time);
CREATE INDEX ON public.transcription_segments(user_id, created_at DESC);
```

### Automated Partition Creation

Create a function that runs monthly via `pg_cron`:

```sql
CREATE OR REPLACE FUNCTION public.create_monthly_partition()
RETURNS void AS $$
DECLARE
    next_month DATE := date_trunc('month', now() + interval '1 month');
    partition_name TEXT;
    start_date TEXT;
    end_date TEXT;
BEGIN
    partition_name := 'transcription_segments_' || to_char(next_month, 'YYYY_MM');
    start_date := to_char(next_month, 'YYYY-MM-DD');
    end_date := to_char(next_month + interval '1 month', 'YYYY-MM-DD');

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.transcription_segments
         FOR VALUES FROM (%L) TO (%L)',
        partition_name, start_date, end_date
    );
END;
$$ LANGUAGE plpgsql;

-- Schedule monthly (requires pg_cron extension on Supabase)
SELECT cron.schedule(
    'create-segment-partition',
    '0 0 1 * *',  -- Midnight on the 1st of every month
    $$SELECT public.create_monthly_partition()$$
);
```

## Supabase Branching (Preview Environments)

Supabase branches create isolated database copies for PR review:

```bash
# Create a branch from your linked project
supabase branches create my-feature-branch

# Get the branch database URL
supabase branches get my-feature-branch

# Run migrations on the branch
supabase db push --linked

# Delete branch when done
supabase branches delete my-feature-branch
```

Each branch replays all migrations from `supabase/migrations/` on a fresh database copy. This is why idempotent migrations matter.

## Rollback Strategy

Supabase CLI doesn't natively support `migrate down`. Instead, write compensating migrations:

```sql
-- supabase/migrations/20240201120000_rollback_usage_logs.sql
-- Only run if 20240201000000_create_usage_logs.sql needs reverting

DROP POLICY IF EXISTS "Users can view own usage logs" ON public.usage_logs;
DROP TABLE IF EXISTS public.usage_logs;
```

**Naming convention for rollbacks**: Use the same timestamp prefix as the forward migration but append `_rollback` and give it a later timestamp so it sorts after.

For production, always test rollback on a branch first:

```bash
# Create branch, apply forward migration, then apply rollback
supabase branches create test-rollback
# ... apply both migrations, verify state ...
supabase branches delete test-rollback
```

## Migration Checklist

Before merging any migration PR:

- [ ] Migration is idempotent (`IF NOT EXISTS`, `IF EXISTS` guards)
- [ ] No `NOT NULL` without `DEFAULT` on existing tables (breaks existing rows)
- [ ] Indexes use `CONCURRENTLY` for tables > 10K rows
- [ ] Foreign keys added as `NOT VALID` first, then `VALIDATE`
- [ ] RLS policies created for new tables
- [ ] `updated_at` trigger applied to new mutable tables
- [ ] Seed data uses `ON CONFLICT DO NOTHING`
- [ ] Tested on local `supabase start` and on a branch

## Production Deployment

```bash
# 1. Pull latest main
git pull origin main

# 2. Link to production project
supabase link --project-ref prod-project-ref

# 3. Review pending migrations
supabase db diff

# 4. Push migrations
supabase db push

# 5. Verify
supabase db execute --command "SELECT * FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 5;"
```

## Next Steps

- Review `03-indexing-performance.md` for index strategies that complement these migrations.
- Review `01-schema-design.md` for the complete table definitions referenced here.
