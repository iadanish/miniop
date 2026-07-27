-- Helper function to update job status from backend

create or replace function public.update_job_status(
  p_video_id uuid,
  p_status text,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.processing_jobs
  set
    status = p_status,
    error = coalesce(p_error, error),
    started_at = case when p_status = 'running' then now() else started_at end,
    completed_at = case when p_status in ('completed', 'failed') then now() else completed_at end
  where video_id = p_video_id
    and status not in ('completed', 'failed');

  update public.videos
  set status = case
    when p_status = 'running' then 'processing'
    when p_status = 'completed' then 'done'
    when p_status = 'failed' then 'failed'
    else status
  end
  where id = p_video_id;
end;
$$;
