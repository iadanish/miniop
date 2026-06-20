# Database Schema Design

MiniOp is an AI-powered video clipping platform that ingests long-form video, transcribes it, identifies viral-worthy segments, and exports short-form clips. This document defines the PostgreSQL schema running on Supabase, covering the free-tier single-database setup through to a scaled production deployment with partitioning and read replicas.

## Core Design Principles

1. **Append-heavy writes** — transcription segments and clip generation produce high-volume inserts. Schema must support bulk ingestion without lock contention.
2. **Tenant isolation** — every table scoped to `user_id` for Row Level Security (RLS). No cross-tenant data leaks even under application bugs.
3. **Soft deletes** — nothing is hard-deleted. `deleted_at` timestamp on every mutable entity preserves audit trails and enables undo.
4. **Idempotent migrations** — all DDL uses `IF NOT EXISTS` / `IF EXISTS` guards so migrations can safely re-run on Supabase branching.

## Schema Overview

```
┌─────────────┐     ┌──────────────┐     ┌───────────────────┐
│   projects   │────▶│    videos     │────▶│ transcription_jobs │
└─────────────┘     └──────────────┘     └───────────────────┘
                                                 │
                         ┌───────────────────────┤
                         ▼                       ▼
                ┌─────────────────┐    ┌──────────────────────┐
                │  transcriptions  │    │ transcription_segments│
                └─────────────────┘    └──────────────────────┘
                         │
                         ▼
                ┌─────────────────┐     ┌──────────────┐
                │     clips        │────▶│ clip_exports  │
                └─────────────────┘     └──────────────┘
```

## Table Definitions

### `profiles`

Extends Supabase's `auth.users` with application-specific fields. Supabase creates a `auth.users` row on signup; this table is populated via a trigger.

```sql
CREATE TABLE public.profiles (
    id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email           TEXT NOT NULL,
    full_name       TEXT,
    avatar_url      TEXT,
    plan            TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
    credits_remaining INTEGER NOT NULL DEFAULT 10,
    stripe_customer_id TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);
```

**Free tier**: `credits_remaining` defaults to 10 (10 clips/month). Pro tier resets to 200 via a Stripe webhook handler. Enterprise uses unlimited (`-1` sentinel).

### `projects`

Groups related videos. Users organize by client, campaign, or content series.

```sql
CREATE TABLE public.projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES public.profiles(id),
    name            TEXT NOT NULL,
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);
```

### `videos`

Represents an uploaded video or a URL import (YouTube, Vimeo, direct link).

```sql
CREATE TABLE public.videos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES public.profiles(id),
    title           TEXT NOT NULL,
    source_url      TEXT,
    storage_path    TEXT,
    duration_seconds NUMERIC(10,2),
    file_size_bytes BIGINT,
    resolution      TEXT,
    status          TEXT NOT NULL DEFAULT 'uploading'
                    CHECK (status IN ('uploading','uploaded','processing','ready','failed')),
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);
```

The `metadata` JSONB column stores codec info, frame rate, aspect ratio, and any probe data from ffprobe. This avoids schema changes when new metadata fields are discovered.

### `transcription_jobs`

Tracks async transcription tasks dispatched to the worker queue (Supabase Edge Functions or a separate BullMQ worker).

```sql
CREATE TABLE public.transcription_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id        UUID NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES public.profiles(id),
    provider        TEXT NOT NULL DEFAULT 'whisper' CHECK (provider IN ('whisper', 'deepgram', 'assembly')),
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','processing','completed','failed')),
    error_message   TEXT,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `transcription_segments`

The granular word-level output from the ASR model. This is the highest-volume table.

```sql
CREATE TABLE public.transcription_segments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transcription_job_id UUID NOT NULL REFERENCES public.transcription_jobs(id) ON DELETE CASCADE,
    video_id        UUID NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES public.profiles(id),
    start_time      NUMERIC(10,3) NOT NULL,
    end_time        NUMERIC(10,3) NOT NULL,
    text            TEXT NOT NULL,
    speaker         TEXT,
    confidence      NUMERIC(4,3),
    words           JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Scaled production**: This table will grow rapidly. A 1-hour video with word-level timestamps produces ~5,000-10,000 rows. For production, partition by `created_at` monthly (see `02-migrations.md`).

The `words` JSONB array stores per-word timing:
```json
[{"word": "hello", "start": 0.0, "end": 0.32, "confidence": 0.98}]
```

### `clips`

AI-generated or manually-created clip segments.

```sql
CREATE TABLE public.clips (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id        UUID NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES public.profiles(id),
    title           TEXT NOT NULL,
    start_time      NUMERIC(10,3) NOT NULL,
    end_time        NUMERIC(10,3) NOT NULL,
    duration_seconds NUMERIC(10,2) GENERATED ALWAYS AS (end_time - start_time) STORED,
    aspect_ratio    TEXT NOT NULL DEFAULT '9:16' CHECK (aspect_ratio IN ('9:16','16:9','1:1','4:5')),
    layout          TEXT NOT DEFAULT 'default' CHECK (layout IN ('default','speaker','subtitle','split')),
    ai_score        NUMERIC(4,3),
    virality_tags   TEXT[],
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','rendering','ready','exported','failed')),
    render_path     TEXT,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);
```

`ai_score` is the virality score (0.0-1.0) from the scoring model. `virality_tags` stores reasons like `{'hook_strong','emotional_peak','trending_topic'}`.

### `clip_exports`

Tracks render jobs and export destinations.

```sql
CREATE TABLE public.clip_exports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clip_id         UUID NOT NULL REFERENCES public.clips(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES public.profiles(id),
    format          TEXT NOT NULL DEFAULT 'mp4' CHECK (format IN ('mp4','webm','gif')),
    resolution      TEXT NOT NULL DEFAULT '1080x1920',
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','rendering','completed','failed')),
    storage_path    TEXT,
    file_size_bytes BIGINT,
    platform        TEXT CHECK (platform IN ('tiktok','instagram','youtube_shorts','twitter','generic')),
    published_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `usage_logs`

Tracks credit consumption for billing reconciliation.

```sql
CREATE TABLE public.usage_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES public.profiles(id),
    action          TEXT NOT NULL CHECK (action IN ('transcription','clip_generation','export','ai_score')),
    credits_used    INTEGER NOT NULL DEFAULT 1,
    resource_type   TEXT,
    resource_id     UUID,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Row Level Security (RLS)

Every table with `user_id` gets an RLS policy. This is the primary multi-tenant isolation mechanism on Supabase.

```sql
ALTER TABLE public.videos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own videos"
    ON public.videos FOR SELECT
    USING (auth.uid() = user_id AND deleted_at IS NULL);

CREATE POLICY "Users can insert own videos"
    ON public.videos FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own videos"
    ON public.videos FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own videos"
    ON public.videos FOR DELETE
    USING (auth.uid() = user_id);
```

Apply the same pattern to `projects`, `transcription_jobs`, `transcription_segments`, `clips`, `clip_exports`, and `usage_logs`. The `profiles` table uses `auth.uid() = id` since the primary key matches the auth user.

**Important**: For `transcription_segments`, the RLS check on `user_id` ensures that even though segments reference `video_id`, the tenant boundary is enforced. In scaled deployments, consider a security-definer function that joins to the video's owner for better query plans.

## Free Tier vs Scaled Production

| Aspect | Free Tier (Supabase) | Scaled Production |
|--------|---------------------|-------------------|
| Database | Single Supabase Postgres | RDS/Neon with read replicas |
| `transcription_segments` | Regular table | Partitioned by month |
| `clips` storage | Supabase Storage (1GB) | S3 + CloudFront CDN |
| RLS | Enabled on all tables | Enabled + security-definer helpers |
| Connections | Supabase pooler (PgBouncer) | PgBouncer on dedicated instance |
| JSONB columns | Used freely | GIN-indexed, some extracted to columns |
| Backups | Supabase daily | pgBackRest continuous archiving |

## Updated At Trigger

Auto-update `updated_at` on any row modification:

```sql
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON public.videos
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
```

Apply this trigger to `profiles`, `projects`, `videos`, and `clips`.

## Profile Auto-Creation

Create a profile row when a user signs up via Supabase Auth:

```sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, full_name, avatar_url)
    VALUES (
        NEW.id,
        NEW.email,
        NEW.raw_user_meta_data->>'full_name',
        NEW.raw_user_meta_data->>'avatar_url'
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

## Next Steps

- Review `02-migrations.md` for version-controlled schema changes and Supabase CLI workflow.
- Review `03-indexing-performance.md` for index strategy and query optimization on these tables.
