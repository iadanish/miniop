# Free Tier Scaling: Running MiniOp at 200-500 Clips/Month for $0

## Overview

This guide covers running MiniOp entirely on free tiers. The architecture uses Supabase Edge Functions as the API gateway (handling routing, auth, rate limiting, and job dispatch), Google Colab for GPU-intensive video processing, Cloudflare R2 for clip storage, Supabase for the database, and Vercel for the web frontend. Total cost: $0/month. Expected throughput: 200-500 clips depending on clip length and processing frequency.

## Architecture

```
User → Vercel (Next.js frontend) → Supabase Edge Functions (API gateway + job dispatch)
                                        ↓
                               Supabase (auth + DB)
                                        ↓
                               Google Colab (GPU processing)
                                        ↓
                              Cloudflare R2 (clip storage)
                                        ↓
                              Supabase Storage (thumbnails)
```

## Component Breakdown

### 1. Frontend: Vercel Hobby Plan

Vercel's free tier provides 100GB bandwidth/month and serverless function execution. This is more than sufficient for a small MiniOp deployment.

**Setup:**

```bash
# Clone and deploy
git clone https://github.com/your-org/minio.git
cd minio
npm install
vercel --prod
```

**Environment variables in Vercel dashboard:**

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_BUCKET_NAME=minio-clips
COLAB_WEBHOOK_URL=https://your-colab-instance.ngrok.io/process
```

**Limitations and workarounds:**

- 100GB bandwidth: Each clip is ~5-15MB. At 500 clips/month with average 10MB, you use ~5GB. Plenty of headroom.
- Serverless function timeout: 10 seconds on Hobby. Use Supabase Edge Functions or direct Colab webhook for long operations.
- No cron jobs on Hobby: Use Supabase pg_cron instead.

### 2. Database + Auth: Supabase Free Tier

Supabase free gives you 500MB database, 1GB file storage, 50,000 monthly active users, and 500MB edge function invocations.

**Database schema initialization:**

```sql
-- Run in Supabase SQL Editor

CREATE TABLE projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE clips (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT,
  start_time FLOAT NOT NULL,
  end_time FLOAT NOT NULL,
  duration FLOAT GENERATED ALWAYS AS (end_time - start_time) STORED,
  r2_key TEXT,
  thumbnail_url TEXT,
  score FLOAT DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE processing_queue (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  priority INT DEFAULT 0,
  payload JSONB NOT NULL,
  status TEXT DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  attempts INT DEFAULT 0,
  max_attempts INT DEFAULT 3,
  created_at TIMESTAMPTZ DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- Index for queue polling
CREATE INDEX idx_queue_status ON processing_queue(status, priority DESC, created_at);

-- Row Level Security
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE clips ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can CRUD own projects" ON projects
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can read own clips" ON clips
  FOR SELECT USING (
    project_id IN (SELECT id FROM projects WHERE user_id = auth.uid())
  );
```

**Enable pg_cron for queue management:**

```sql
-- In Supabase SQL Editor (requires pg_cron extension)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Clean up stale processing jobs every 10 minutes
SELECT cron.schedule(
  'cleanup-stale-jobs',
  '*/10 * * * *',
  $$UPDATE processing_queue SET status = 'queued', attempts = attempts + 1
    WHERE status = 'processing' AND started_at < now() - interval '30 minutes'
    AND attempts < max_attempts$$
);
```

**Supabase Edge Function for job submission:**

```typescript
// supabase/functions/submit-clip-job/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  const { project_id, source_url, start_time, end_time, title } = await req.json();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  // Insert into processing queue
  const { data, error } = await supabase
    .from("processing_queue")
    .insert({
      project_id,
      payload: { source_url, start_time, end_time, title },
      priority: 0,
    })
    .select()
    .single();

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 400 });
  }

  // Notify Colab via webhook (if running)
  const colabUrl = Deno.env.get("COLAB_WEBHOOK_URL");
  if (colabUrl) {
    try {
      await fetch(colabUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: data.id, ...data.payload }),
      });
    } catch {
      // Colab not running - job stays queued for polling
    }
  }

  return new Response(JSON.stringify({ job_id: data.id }), { status: 200 });
});
```

Deploy with:

```bash
supabase functions deploy submit-clip-job
```

### 3. GPU Processing: Google Colab Free Tier

Colab free provides T4 GPU access for ~4-12 hours per session. The key constraint is session disconnection after inactivity. For 200-500 clips/month, you need ~10-25 processing sessions.

**Colab notebook setup (save as `minio_processor.ipynb`):**

```python
# Cell 1: Install dependencies
!pip install ffmpeg-python openai-whisper yt-dlp transformers torch torchvision

# Cell 2: Mount Google Drive for temporary storage
from google.colab import drive
drive.mount('/content/drive')

# Cell 3: Processing pipeline
import ffmpeg
import whisper
import yt_dlp
import requests
import json
import time
import os
from transformers import pipeline

SUPABASE_URL = "https://your-project.supabase.co"
SUPABASE_KEY = "your-service-role-key"
R2_ENDPOINT = "https://your-account-id.r2.cloudflarestorage.com"
R2_ACCESS_KEY = "your-r2-key"
R2_SECRET_KEY = "your-r2-secret"
R2_BUCKET = "minio-clips"

def download_video(url, output_path="/content/video.mp4"):
    ydl_opts = {
        'format': 'best[height<=720]',
        'outtmpl': output_path,
        'quiet': True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])
    return output_path

def extract_clip(input_path, start, end, output_path):
    (
        ffmpeg
        .input(input_path, ss=start, to=end)
        .output(output_path, vcodec='libx264', acodec='aac', preset='fast', crf=23)
        .overwrite_output()
        .run(quiet=True)
    )
    return output_path

def upload_to_r2(local_path, key):
    import boto3
    s3 = boto3.client('s3',
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY,
        aws_secret_access_key=R2_SECRET_KEY,
    )
    s3.upload_file(local_path, R2_BUCKET, key,
        ExtraArgs={'ContentType': 'video/mp4'})
    return f"{R2_ENDPOINT}/{R2_BUCKET}/{key}"

def generate_thumbnail(video_path, time_sec=1.0):
    thumb_path = "/content/thumb.jpg"
    (
        ffmpeg
        .input(video_path, ss=time_sec)
        .output(thumb_path, vframes=1, s='640x360')
        .overwrite_output()
        .run(quiet=True)
    )
    return thumb_path

def process_job(job):
    project_id = job['project_id']
    payload = job['payload']
    job_id = job['id']

    # Update status to processing
    requests.patch(
        f"{SUPABASE_URL}/rest/v1/processing_queue?id=eq.{job_id}",
        headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json",
                 "Prefer": "return=minimal"},
        json={"status": "processing", "started_at": "now()"}
    )

    try:
        # Download source video
        video_path = download_video(payload['source_url'])

        # Extract clip
        clip_path = f"/content/clip_{job_id}.mp4"
        extract_clip(video_path, payload['start_time'], payload['end_time'], clip_path)

        # Upload to R2
        r2_key = f"clips/{project_id}/{job_id}.mp4"
        r2_url = upload_to_r2(clip_path, r2_key)

        # Generate and upload thumbnail
        thumb_path = generate_thumbnail(clip_path)
        thumb_key = f"thumbs/{project_id}/{job_id}.jpg"
        upload_to_r2(thumb_path, thumb_key)

        # Create clip record
        requests.post(
            f"{SUPABASE_URL}/rest/v1/clips",
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
            json={
                "project_id": project_id,
                "title": payload.get('title', 'Untitled Clip'),
                "start_time": payload['start_time'],
                "end_time": payload['end_time'],
                "r2_key": r2_key,
                "thumbnail_url": f"{R2_ENDPOINT}/{R2_BUCKET}/{thumb_key}",
                "status": "ready"
            }
        )

        # Mark job complete
        requests.patch(
            f"{SUPABASE_URL}/rest/v1/processing_queue?id=eq.{job_id}",
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json",
                     "Prefer": "return=minimal"},
            json={"status": "completed", "completed_at": "now()"}
        )

        # Cleanup temp files
        for f in [video_path, clip_path, thumb_path]:
            if os.path.exists(f):
                os.remove(f)

    except Exception as e:
        requests.patch(
            f"{SUPABASE_URL}/rest/v1/processing_queue?id=eq.{job_id}",
            headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json",
                     "Prefer": "return=minimal"},
            json={"status": "failed"}
        )
        raise e

# Cell 4: Main polling loop
def poll_and_process():
    """Poll Supabase queue and process jobs."""
    while True:
        try:
            # Fetch next queued job
            resp = requests.get(
                f"{SUPABASE_URL}/rest/v1/processing_queue"
                f"?status=eq.queued&order=priority.desc,created_at.asc&limit=1",
                headers={"apikey": SUPABASE_KEY}
            )
            jobs = resp.json()

            if jobs:
                process_job(jobs[0])
            else:
                time.sleep(30)  # Poll every 30 seconds

        except KeyboardInterrupt:
            print("Stopped.")
            break
        except Exception as e:
            print(f"Error: {e}")
            time.sleep(10)

poll_and_process()
```

**Keeping Colab alive:**

```javascript
// Paste in browser console to prevent disconnection
// Run this while Colab is processing
setInterval(() => {
    document.querySelector("#connect").click();
}, 60000);
```

Or use the Colab alive trick with JavaScript injection in a cell:

```python
from IPython.display import Javascript
display(Javascript('''
    function ClickConnect(){
        console.log("Keeping alive...");
        document.querySelector("#connect").click();
    }
    setInterval(ClickConnect, 60000)
'''))
```

### 4. Clip Storage: Cloudflare R2 Free Tier

R2 provides 10GB storage, 1,000 Class A operations (writes), and 10,000,000 Class B operations (reads) per month for free. No egress fees.

**R2 bucket setup via Wrangler CLI:**

```bash
npm install -g wrangler
wrangler login

# Create bucket
wrangler r2 bucket create minio-clips

# Create API token in Cloudflare dashboard:
# Go to R2 > Manage R2 API Tokens > Create API token
# Permissions: Object Read & Write
# Specify bucket: minio-clips
```

**Generate presigned URLs for direct browser uploads (avoids Vercel function limits):**

```typescript
// lib/r2.ts - Use in Vercel API routes
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

export async function getUploadUrl(key: string, contentType: string) {
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(r2, command, { expiresIn: 3600 });
}

export function getPublicUrl(key: string) {
  return `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET_NAME}/${key}`;
}
```

**Capacity math for 10GB free tier:**

- Average clip (720p, 30s): ~5MB
- 10GB / 5MB = 2,000 clips stored simultaneously
- At 500 clips/month, you have ~4 months before needing to archive or delete old clips

### 5. Scheduled Processing with Supabase pg_cron

Since Vercel Hobby has no cron, use Supabase's built-in scheduler:

```sql
-- Check for pending projects every 5 minutes during business hours
SELECT cron.schedule(
  'process-pending-projects',
  '*/5 9-17 * * *',
  $$
    SELECT net.http_post(
      url := 'https://your-project.supabase.co/functions/v1/check-pending-jobs',
      headers := '{"Authorization": "Bearer your-service-role-key"}'::jsonb
    )
  $$
);
```

## Monitoring and Alerts

Set up basic monitoring with Supabase webhooks:

```sql
-- Trigger on failed jobs
CREATE OR REPLACE FUNCTION notify_failed_job()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'failed' AND OLD.status != 'failed' THEN
    PERFORM net.http_post(
      url := 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL',
      body := json_build_object(
        'text', format('Job %s failed for project %s', NEW.id, NEW.project_id)
      )::text
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER on_job_failed
  AFTER UPDATE ON processing_queue
  FOR EACH ROW EXECUTE FUNCTION notify_failed_job();
```

## Capacity Planning

| Metric | Free Tier Limit | 500 Clips Usage | Headroom |
|--------|----------------|-----------------|----------|
| Vercel bandwidth | 100GB/month | ~5GB | 95% |
| Supabase DB | 500MB | ~50MB | 90% |
| Supabase edge invocations | 500MB/month | ~10MB | 98% |
| R2 storage | 10GB | ~2.5GB | 75% |
| R2 Class A ops | 1,000/month | ~500 | 50% |
| R2 Class B ops | 10M/month | ~50,000 | 99% |
| Colab GPU sessions | ~4-12hrs/session | ~25 sessions/month | Manual |

## Scaling Triggers

Move to paid tiers when you hit any of these:

- Colab sessions running daily (switch to dedicated GPU)
- R2 storage exceeding 8GB (archive or upgrade)
- Supabase database exceeding 400MB (optimize or upgrade)
- Processing latency exceeding 24 hours (need persistent workers)
- More than 3 concurrent users (Vercel Hobby limits)

See [02-paid-production.md](./02-paid-production.md) for the production scaling guide.
