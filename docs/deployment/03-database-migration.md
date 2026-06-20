# Database Migration Guide

This guide covers managing database schema migrations for MiniOp using Supabase's migration tooling. It addresses local development workflows, staging validation, production deployment, rollback strategies, and data migration patterns for both free-tier and scaled production environments.

## Migration Tooling Overview

MiniOp uses Supabase CLI's built-in migration system, which wraps PostgreSQL migration files and applies them in order against your Supabase project. Migrations live in `supabase/migrations/` as timestamped SQL files.

```bash
supabase/
├── config.toml
├── migrations/
│   ├── 20240101000000_initial_schema.sql
│   ├── 20240115120000_add_clip_metadata.sql
│   └── 20240201090000_add_processing_queue.sql
├── seed.sql
└── functions/
```

## Initial Schema

The initial migration creates MiniOp's core tables. Run this when setting up a new Supabase project:

```sql
-- supabase/migrations/20240101000000_initial_schema.sql

-- Users table (extends Supabase auth.users)
CREATE TABLE public.profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email TEXT NOT NULL,
  full_name TEXT,
  avatar_url TEXT,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  credits_remaining INTEGER NOT NULL DEFAULT 10,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Videos uploaded by users
CREATE TABLE public.videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  source_url TEXT,
  storage_path TEXT,
  duration_seconds NUMERIC(10, 2),
  file_size_bytes BIGINT,
  mime_type TEXT NOT NULL DEFAULT 'video/mp4',
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN (
    'uploaded', 'transcribing', 'analyzing', 'processing', 'completed', 'failed'
  )),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Clips generated from videos
CREATE TABLE public.clips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  start_time NUMERIC(10, 3) NOT NULL,
  end_time NUMERIC(10, 3) NOT NULL,
  duration_seconds NUMERIC(10, 3) GENERATED ALWAYS AS (end_time - start_time) STORED,
  storage_path TEXT,
  thumbnail_path TEXT,
  transcript_text TEXT,
  score NUMERIC(5, 3),
  rank INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'rendering', 'completed', 'failed'
  )),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Processing jobs queue
CREATE TABLE public.processing_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK (job_type IN ('transcribe', 'analyze', 'render_clip', 'generate_thumbnail')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'processing', 'completed', 'failed', 'cancelled'
  )),
  priority INTEGER NOT NULL DEFAULT 5,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  error_message TEXT,
  result JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_videos_user_id ON public.videos(user_id);
CREATE INDEX idx_videos_status ON public.videos(status);
CREATE INDEX idx_clips_video_id ON public.clips(video_id);
CREATE INDEX idx_clips_user_id ON public.clips(user_id);
CREATE INDEX idx_clips_score ON public.clips(score DESC);
CREATE INDEX idx_processing_jobs_status ON public.processing_jobs(status, priority DESC);
CREATE INDEX idx_processing_jobs_video_id ON public.processing_jobs(video_id);

-- Updated_at trigger function
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_videos_updated_at
  BEFORE UPDATE ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_clips_updated_at
  BEFORE UPDATE ON public.clips
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_processing_jobs_updated_at
  BEFORE UPDATE ON public.processing_jobs
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Auto-create profile on user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', ''),
    COALESCE(NEW.raw_user_meta_data->>'avatar_url', '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Row Level Security
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processing_jobs ENABLE ROW LEVEL SECURITY;

-- Profiles: users can read their own profile, update their own profile
CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id);

-- Videos: users can CRUD their own videos
CREATE POLICY "Users can view own videos"
  ON public.videos FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own videos"
  ON public.videos FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own videos"
  ON public.videos FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own videos"
  ON public.videos FOR DELETE
  USING (auth.uid() = user_id);

-- Clips: users can read their own clips, public clips are readable by anyone
CREATE POLICY "Users can view own clips"
  ON public.clips FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own clips"
  ON public.clips FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own clips"
  ON public.clips FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own clips"
  ON public.clips FOR DELETE
  USING (auth.uid() = user_id);

-- Processing jobs: service role only (no user-facing policies)
-- Jobs are created/updated via Edge Functions using the service role key
```

## Local Development Workflow

### Creating a New Migration

When you need to change the schema, generate a migration file:

```bash
npx supabase migration new add_clip_sharing
```

This creates `supabase/migrations/20240315143000_add_clip_sharing.sql`. Write the SQL:

```sql
-- supabase/migrations/20240315143000_add_clip_sharing.sql

CREATE TABLE public.clip_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_id UUID NOT NULL REFERENCES public.clips(id) ON DELETE CASCADE,
  shared_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  shared_with UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  share_token TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
  expires_at TIMESTAMPTZ,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_clip_shares_token ON public.clip_shares(share_token);
CREATE INDEX idx_clip_shares_clip_id ON public.clip_shares(clip_id);

ALTER TABLE public.clip_shares ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view shares they created"
  ON public.clip_shares FOR SELECT
  USING (auth.uid() = shared_by);

CREATE POLICY "Users can create shares for own clips"
  ON public.clip_shares FOR INSERT
  WITH CHECK (
    auth.uid() = shared_by AND
    EXISTS (SELECT 1 FROM public.clips WHERE id = clip_id AND user_id = auth.uid())
  );

CREATE POLICY "Users can delete own shares"
  ON public.clip_shares FOR DELETE
  USING (auth.uid() = shared_by);
```

### Applying Migrations Locally

Reset the local database to apply all migrations from scratch:

```bash
npx supabase db reset
```

This drops the local database, re-runs every migration in order, and applies `supabase/seed.sql` if it exists. Use this after any schema change to verify migrations apply cleanly.

### Diffing Against Remote

If you made manual changes in the Supabase Dashboard and want to capture them as a migration:

```bash
npx supabase db diff --linked
```

This compares your remote database against the local migration history and outputs the SQL diff. Pipe it into a new migration:

```bash
npx supabase db diff --linked --use-migra > supabase/migrations/$(date +%Y%m%d%H%M%S)_remote_changes.sql
```

Review the generated SQL before committing — automated diffs sometimes include unnecessary changes.

## Production Migration Workflow

### Free Tier (Direct Apply)

For small projects on the Supabase free tier with low traffic:

1. Push migrations to the remote project:

```bash
npx supabase db push
```

2. This runs all pending migrations against the linked Supabase project. The command:
   - Checks which migrations have already been applied (tracked in `supabase_migrations.schema_migrations` table)
   - Applies only new migrations in order
   - Fails if any migration has a syntax error (previous migrations remain applied)

3. Verify in Supabase Studio that the new tables/columns exist.

**Risk**: Direct apply runs migrations immediately. If a migration locks a table with existing data, it blocks reads/writes until completion. For tables under 100K rows, this is typically under 1 second. For larger tables, use the staged approach below.

### Production (Staged Migration)

For production databases with significant traffic:

#### Step 1: Test on a Database Branch

Supabase supports database branching (available on Pro plan and above):

```bash
# Create a preview branch
npx supabase branches create staging

# Get the branch's connection string
npx supabase branches get staging
```

Apply migrations to the branch first:

```bash
npx supabase db push --linked --db-url postgresql://postgres:password@db.staging-project.supabase.co:5432/postgres
```

Run your test suite against the staging branch to verify schema compatibility.

#### Step 2: Apply During Low-Traffic Window

Schedule the migration for the lowest-traffic period. For most B2B SaaS products, this is early morning (UTC-5) on weekdays:

```bash
# Check pending migrations
npx supabase db push --dry-run

# Apply
npx supabase db push
```

#### Step 3: Verify Post-Migration

```bash
# Check migration history
npx supabase migration list --linked

# Verify specific table structure
npx supabase inspect db table-sizes --linked
```

## Safe Migration Patterns

### Adding a Column (Non-Breaking)

```sql
-- Safe: adds a nullable column, no table lock
ALTER TABLE public.clips ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';
```

This completes instantly even on large tables because PostgreSQL doesn't rewrite the table for nullable columns with defaults (PostgreSQL 11+).

### Adding a NOT NULL Column (Requires Default)

```sql
-- Safe: adds a non-null column with default (PG 11+ optimizes this)
ALTER TABLE public.clips ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';
```

### Renaming a Column (Two-Phase)

Never rename a column in one migration if the application reads it. Instead:

```sql
-- Migration 1: Add new column, backfill
ALTER TABLE public.clips ADD COLUMN clip_title TEXT;
UPDATE public.clips SET clip_title = title WHERE clip_title IS NULL;
ALTER TABLE public.clips ALTER COLUMN clip_title SET NOT NULL;

-- Deploy code that reads from clip_title --

-- Migration 2 (next release): Drop old column
ALTER TABLE public.clips DROP COLUMN title;
```

### Adding an Index (Concurrent)

```sql
-- Safe: does not lock the table for writes
CREATE INDEX CONCURRENTLY idx_clips_created_at ON public.clips(created_at DESC);
```

`CONCURRENTLY` prevents the index build from blocking writes. It takes longer but doesn't cause downtime. Note: `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, so Supabase CLI handles this correctly — the migration runs outside a transaction block.

### Creating a Foreign Key on Existing Data

```sql
-- Step 1: Add as NOT VALID (instant, no row scan)
ALTER TABLE public.clip_shares
  ADD CONSTRAINT fk_clip_shares_clip
  FOREIGN KEY (clip_id) REFERENCES public.clips(id) ON DELETE CASCADE
  NOT VALID;

-- Step 2: Validate (scans rows but doesn't lock writes)
ALTER TABLE public.clip_shares
  VALIDATE CONSTRAINT fk_clip_shares_clip;
```

## Data Migrations

When you need to transform existing data (not just change schema), write a data migration:

```sql
-- supabase/migrations/20240320100000_backfill_clip_scores.sql

-- Backfill clip scores using a simple heuristic for existing clips
-- This runs once and processes rows in batches to avoid long locks
DO $$
DECLARE
  batch_size INT := 1000;
  rows_updated INT;
BEGIN
  LOOP
    UPDATE public.clips
    SET score = CASE
      WHEN duration_seconds BETWEEN 15 AND 60 THEN 0.8
      WHEN duration_seconds BETWEEN 5 AND 15 THEN 0.6
      WHEN duration_seconds BETWEEN 60 AND 180 THEN 0.5
      ELSE 0.3
    END
    WHERE id IN (
      SELECT id FROM public.clips
      WHERE score IS NULL
      LIMIT batch_size
    );

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;

    PERFORM pg_sleep(0.1);  -- Brief pause between batches
  END LOOP;
END $$;
```

## Rollback Strategies

### Manual Rollback

Supabase CLI doesn't have a built-in rollback command. Create rollback migrations manually:

```bash
npx supabase migration new rollback_add_clip_sharing
```

Write the inverse SQL:

```sql
-- supabase/migrations/20240316000000_rollback_add_clip_sharing.sql
DROP TABLE IF EXISTS public.clip_shares;
```

**Important**: If the forward migration has already been applied to production and contains data, the rollback must preserve that data. Add a `SELECT INTO` to archive before dropping:

```sql
CREATE TABLE IF NOT EXISTS public._archive_clip_shares AS
  SELECT * FROM public.clip_shares WHERE false;

INSERT INTO public._archive_clip_shares
  SELECT * FROM public.clip_shares;

DROP TABLE public.clip_shares;
```

### Point-in-Time Recovery (Pro Plan)

Supabase Pro plan includes daily backups and point-in-time recovery (PITR) up to 7 days. If a migration corrupts data:

1. Go to **Supabase Dashboard > Database > Backups**
2. Select a recovery point just before the migration
3. Restore to a new project
4. Migrate the data back to the production project

PITR requires the Pro plan ($25/month). Free-tier projects have daily backups only, with no point-in-time granularity.

## Seed Data

Create `supabase/seed.sql` for development fixtures:

```sql
-- supabase/seed.sql

-- Insert a test user (requires auth.users entry, which Supabase CLI handles during reset)
INSERT INTO public.profiles (id, email, full_name, plan, credits_remaining)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'test@miniop.dev',
  'Test User',
  'pro',
  100
) ON CONFLICT (id) DO NOTHING;

-- Insert sample videos
INSERT INTO public.videos (id, user_id, title, status, duration_seconds)
VALUES
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000001', 'Sample Podcast Episode', 'completed', 3600),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000001', 'Product Demo Recording', 'completed', 900);

-- Insert sample clips
INSERT INTO public.clips (video_id, user_id, title, start_time, end_time, score, status)
VALUES
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000001', 'Key Insight on AI', 120.5, 165.2, 0.92, 'completed'),
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000001', 'Funny Moment', 450.0, 475.8, 0.85, 'completed'),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000001', 'Feature Highlight', 30.0, 55.3, 0.78, 'completed');
```

Seed data only applies during `supabase db reset`, not during production migrations.

## CI/CD Integration

Add migration validation to your CI pipeline:

```yaml
# .github/workflows/migrations.yml
name: Database Migrations
on:
  pull_request:
    paths:
      - 'supabase/migrations/**'

jobs:
  verify-migrations:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: supabase/setup-cli@v1
        with:
          version: latest
      
      - name: Start Supabase
        run: supabase start
      
      - name: Apply Migrations
        run: supabase db reset
      
      - name: Verify Schema
        run: |
          supabase db diff --check
          
      - name: Run Tests Against Schema
        run: npm test -- --grep "database"
        
      - name: Stop Supabase
        if: always()
        run: supabase stop
```

This catches migration errors before they reach production. The `--check` flag in `db diff` returns a non-zero exit code if there are unapplied migrations, preventing merges of incomplete migration sets.

## Common Pitfalls

**Migration order matters**: Never rename or reorder existing migration files. Supabase tracks applied migrations by filename in `supabase_migrations.schema_migrations`. Reordering causes "migration already applied" errors or skips.

**Don't modify applied migrations**: If a migration has been pushed to production, treat it as immutable. Create a new migration to fix issues.

**Test `db reset` locally**: Always run `npx supabase db reset` before pushing migrations. This replays the full migration history and catches ordering issues.

**Beware of `DROP COLUMN`**: Dropping a column that the application still reads causes immediate runtime errors. Deploy the code change first (stop reading the column), then deploy the migration.

**Large table ALTERs**: Adding a NOT NULL constraint without a default on a table with existing rows requires a full table scan and exclusive lock. Use the two-phase approach: add as NULLABLE first, backfill, then add the constraint.
