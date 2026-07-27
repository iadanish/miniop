-- Phase 2: MiMo AI Pipeline — processing_jobs, transcriptions, video/clip alterations

create table if not exists public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  job_type text not null check (job_type in ('transcribe', 'analyze', 'render', 'full')),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed')),
  payload jsonb not null default '{}',
  result jsonb not null default '{}',
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.transcriptions (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  language text not null default 'en',
  duration_seconds double precision,
  segments jsonb not null default '[]',
  full_text text,
  created_at timestamptz not null default now()
);

alter table public.videos add column if not exists transcription_id uuid references public.transcriptions (id);
alter table public.videos add column if not exists analysis jsonb not null default '{}';

alter table public.clips add column if not exists hook_score double precision;
alter table public.clips add column if not exists retention_score double precision;
alter table public.clips add column if not exists quotability_score double precision;
alter table public.clips add column if not exists platform_scores jsonb not null default '{}';
alter table public.clips add column if not exists caption_text text;
alter table public.clips add column if not exists suggestions jsonb not null default '[]';
alter table public.clips add column if not exists thumbnail_storage_key text;

alter table public.profiles add column if not exists mimo_api_key text;

create index if not exists idx_jobs_video_id on public.processing_jobs (video_id);
create index if not exists idx_jobs_user_id on public.processing_jobs (user_id);
create index if not exists idx_jobs_status on public.processing_jobs (status);
create index if not exists idx_transcriptions_video_id on public.transcriptions (video_id);

drop trigger if exists processing_jobs_updated_at on public.processing_jobs;
create trigger processing_jobs_updated_at
before update on public.processing_jobs
for each row execute function public.handle_updated_at();

alter table public.processing_jobs enable row level security;
alter table public.transcriptions enable row level security;

create policy "Users can view own jobs"
on public.processing_jobs for select
using (auth.uid() = user_id);

create policy "Users can insert own jobs"
on public.processing_jobs for insert
with check (auth.uid() = user_id);

create policy "Users can update own jobs"
on public.processing_jobs for update
using (auth.uid() = user_id);

create policy "Users can view own transcriptions"
on public.transcriptions for select
using (auth.uid() = user_id);

create policy "Users can insert own transcriptions"
on public.transcriptions for insert
with check (auth.uid() = user_id);

create policy "Users can update own profile keys"
on public.profiles for update
using (auth.uid() = id);
