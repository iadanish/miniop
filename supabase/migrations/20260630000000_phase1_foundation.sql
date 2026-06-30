-- Phase 1 foundation: profiles, videos, clips with RLS

create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  plan text not null default 'free',
  upload_quota_seconds integer not null default 300,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  filename text not null,
  storage_key text not null,
  mime_type text not null,
  file_size_bytes bigint not null,
  duration_seconds integer,
  status text not null default 'uploaded'
    check (status in ('uploaded', 'queued', 'processing', 'done', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.clips (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  start_time double precision,
  end_time double precision,
  virality_score double precision,
  storage_key text,
  status text not null default 'pending'
    check (status in ('pending', 'rendering', 'done', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_videos_user_id on public.videos (user_id);
create index if not exists idx_videos_status on public.videos (status);
create index if not exists idx_clips_video_id on public.clips (video_id);
create index if not exists idx_clips_user_id on public.clips (user_id);

create or replace function public.handle_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at
before update on public.profiles
for each row execute function public.handle_updated_at();

drop trigger if exists videos_updated_at on public.videos;
create trigger videos_updated_at
before update on public.videos
for each row execute function public.handle_updated_at();

drop trigger if exists clips_updated_at on public.clips;
create trigger clips_updated_at
before update on public.clips
for each row execute function public.handle_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, plan, upload_quota_seconds)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'plan', 'free'),
    coalesce((new.raw_user_meta_data ->> 'upload_quota_seconds')::integer, 300)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.videos enable row level security;
alter table public.clips enable row level security;

create policy "Users can view own profile"
on public.profiles for select
using (auth.uid() = id);

create policy "Users can update own profile"
on public.profiles for update
using (auth.uid() = id);

create policy "Users can view own videos"
on public.videos for select
using (auth.uid() = user_id);

create policy "Users can insert own videos"
on public.videos for insert
with check (auth.uid() = user_id);

create policy "Users can update own videos"
on public.videos for update
using (auth.uid() = user_id);

create policy "Users can delete own videos"
on public.videos for delete
using (auth.uid() = user_id);

create policy "Users can view own clips"
on public.clips for select
using (auth.uid() = user_id);

create policy "Users can insert own clips"
on public.clips for insert
with check (auth.uid() = user_id);

create policy "Users can update own clips"
on public.clips for update
using (auth.uid() = user_id);

create policy "Users can delete own clips"
on public.clips for delete
using (auth.uid() = user_id);