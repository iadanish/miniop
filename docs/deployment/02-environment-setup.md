# Environment Setup Guide

This guide walks through provisioning every external service MiniOp depends on, configuring environment variables for local development and production, and validating the full stack before deploying. MiniOp uses Next.js 14 (App Router), Supabase for backend infrastructure, OpenAI for AI-powered clip detection, and Cloudflare R2 or Supabase Storage for video file storage.

## Architecture Overview

MiniOp's environment consists of four external services:

- **Supabase**: PostgreSQL database, authentication, Edge Functions, Realtime subscriptions, and Storage
- **OpenAI**: GPT-4o for transcript analysis and clip selection, Whisper for audio transcription
- **Vercel**: Frontend hosting and serverless API routes (see `01-vercel-deployment.md`)
- **Storage**: Supabase Storage (free tier) or Cloudflare R2 (production) for video files

## Step 1: Supabase Project Setup

### Create the Project

1. Go to [supabase.com](https://supabase.com) and create an account
2. Click **New Project** and configure:
   - **Organization**: Create one or use an existing org
   - **Project Name**: `miniop-production` (or `miniop-dev` for local)
   - **Database Password**: Generate a strong password — save it, you cannot retrieve it later
   - **Region**: Choose the closest region to your user base (e.g., `us-east-1` for US, `eu-west-2` for EU)
3. Wait 2-3 minutes for provisioning

### Retrieve API Keys

Navigate to **Project Settings > API** and copy:

- **Project URL**: `https://xxxxxxxxxxxx.supabase.co`
- **Anon/Public Key**: A `eyJ...` JWT — safe to expose in client-side code
- **Service Role Key**: A `eyJ...` JWT — **never expose this**, it bypasses Row Level Security

### Configure Authentication

Go to **Authentication > Providers** and enable:

- **Email**: Enabled by default. Disable "Confirm email" in development for faster iteration
- **Google OAuth** (optional): Create OAuth credentials at [console.cloud.google.com](https://console.cloud.google.com), add the redirect URL shown in Supabase dashboard
- **GitHub OAuth** (optional): Create an OAuth app at [github.com/settings/developers](https://github.com/settings/developers)

Set the Site URL and Redirect URLs under **Authentication > URL Configuration**:

```
Site URL: https://your-domain.com (or http://localhost:3000 for dev)
Redirect URLs: 
  - https://your-domain.com/auth/callback
  - http://localhost:3000/auth/callback
```

### Set Up Storage Buckets

Go to **Storage** and create these buckets:

| Bucket Name | Public | Purpose |
|-------------|--------|---------|
| `videos` | No | Raw uploaded video files |
| `clips` | Yes | Processed clip files (public for embedding) |
| `thumbnails` | Yes | Generated thumbnail images |

For the `clips` bucket, set a CORS policy to allow embedding:

```sql
-- Run in SQL Editor
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES 
  ('videos', 'videos', false, 524288000, ARRAY['video/mp4', 'video/webm', 'video/quicktime']),
  ('clips', 'clips', true, 104857600, ARRAY['video/mp4', 'video/webm']),
  ('thumbnails', 'thumbnails', true, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp']);
```

The `videos` bucket has a 500 MB file size limit. Adjust based on your expected upload sizes and Supabase plan limits.

## Step 2: Local Supabase Setup

Install the Supabase CLI for local development:

```bash
npm install -g supabase

# Or use npx without global install
npx supabase --version
```

Initialize Supabase in your project:

```bash
cd miniop
npx supabase init
```

This creates a `supabase/` directory with configuration. Start the local Supabase stack:

```bash
npx supabase start
```

This spins up PostgreSQL, GoTrue (auth), PostgREST, Realtime, Storage, and Edge Functions via Docker. The first run downloads ~2 GB of images. Output looks like:

```
         API URL: http://127.0.0.1:54321
     GraphQL URL: http://127.0.0.1:54321/graphql/v1
          DB URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres
      Studio URL: http://127.0.0.1:54323
    Inbucket URL: http://127.0.0.1:54324
      JWT secret: super-secret-jwt-token-with-at-least-32-characters
        anon key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
service_role key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Copy these values for your local `.env.local` file.

## Step 3: OpenAI API Setup

1. Create an account at [platform.openai.com](https://platform.openai.com)
2. Navigate to **API Keys** and create a new key
3. Set a usage limit under **Settings > Limits** — $50/month is reasonable for development
4. Enable the following models in your account:
   - `gpt-4o` — for transcript analysis and clip selection
   - `whisper-1` — for audio transcription

For production, create a dedicated OpenAI organization with a separate API key and higher rate limits. Contact OpenAI sales if you need >10,000 RPM.

## Step 4: Storage Provider Setup

### Option A: Supabase Storage (Free Tier)

No additional setup needed — the buckets created in Step 1 handle storage. Free tier includes 1 GB total storage and 2 GB bandwidth per month. Suitable for development and small-scale deployments.

### Option B: Cloudflare R2 (Production)

R2 provides S3-compatible storage with zero egress fees — critical for video-heavy workloads:

1. Create a Cloudflare account at [dash.cloudflare.com](https://dash.cloudflare.com)
2. Go to **R2 Object Storage** and create a bucket named `miniop-clips`
3. Create an API token under **R2 > Manage R2 API Tokens**:
   - **Permissions**: Object Read & Write
   - **Specify bucket**: `miniop-clips`
   - Save the **Access Key ID** and **Secret Access Key**

4. Enable public access via a custom domain:
   - Go to bucket **Settings > Public Access**
   - Connect a custom domain (e.g., `clips.miniop.dev`)
   - Cloudflare provisions SSL automatically

## Step 5: Environment Variable Configuration

### Development (`.env.local`)

Create `.env.local` at the project root:

```bash
# Supabase (local)
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<from supabase start output>
SUPABASE_SERVICE_ROLE_KEY=<from supabase start output>

# OpenAI
OPENAI_API_KEY=sk-proj-...

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
NODE_ENV=development

# Storage (local uses Supabase Storage by default)
STORAGE_PROVIDER=supabase

# Optional: Rate limiting
RATE_LIMIT_MAX_UPLOADS_PER_HOUR=10
RATE_LIMIT_MAX_CLIPS_PER_VIDEO=20
```

### Production (Vercel Environment Variables)

Set these in the Vercel dashboard or via CLI:

```bash
# Supabase (hosted)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# OpenAI
OPENAI_API_KEY=sk-proj-...

# App
NEXT_PUBLIC_APP_URL=https://app.miniop.dev
NODE_ENV=production

# Storage (Cloudflare R2)
STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=your-access-key
R2_SECRET_ACCESS_KEY=your-secret-key
R2_BUCKET_NAME=miniop-clips
R2_PUBLIC_URL=https://clips.miniop.dev

# Rate limiting (stricter in production)
RATE_LIMIT_MAX_UPLOADS_PER_HOUR=20
RATE_LIMIT_MAX_CLIPS_PER_VIDEO=50
```

## Step 6: Validate the Full Stack

### Check Database Connectivity

```bash
npx supabase db ping
# Expected: "Successfully connected to local database"
```

### Check Auth Configuration

Start the dev server and test authentication:

```bash
npm run dev
```

Navigate to `http://localhost:3000/auth/sign-up` and create a test account. Check Supabase Studio (`http://localhost:54323`) under **Authentication > Users** to confirm the user was created.

### Check OpenAI Integration

Test the OpenAI connection with a simple API call:

```bash
curl http://localhost:3000/api/health/openai
```

Expected response:

```json
{
  "status": "ok",
  "model": "gpt-4o",
  "latencyMs": 234
}
```

### Check Storage

Upload a test file through the Supabase Studio UI at `http://localhost:54323/storage`. Verify it appears in the correct bucket and the public URL resolves for public buckets.

## Step 7: Environment-Specific Configuration

### Feature Flags by Environment

Create a configuration module that adapts to the environment:

```typescript
// lib/config.ts
export const config = {
  storage: {
    provider: (process.env.STORAGE_PROVIDER || 'supabase') as 'supabase' | 'r2',
    r2: {
      accountId: process.env.R2_ACCOUNT_ID || '',
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
      bucket: process.env.R2_BUCKET_NAME || 'miniop-clips',
      publicUrl: process.env.R2_PUBLIC_URL || '',
    },
  },
  rateLimits: {
    maxUploadsPerHour: parseInt(process.env.RATE_LIMIT_MAX_UPLOADS_PER_HOUR || '10'),
    maxClipsPerVideo: parseInt(process.env.RATE_LIMIT_MAX_CLIPS_PER_VIDEO || '20'),
  },
  openai: {
    model: process.env.NODE_ENV === 'production' ? 'gpt-4o' : 'gpt-4o-mini',
    whisperModel: 'whisper-1',
  },
  features: {
    realtimeSubscriptions: process.env.NODE_ENV === 'production',
    analytics: process.env.NODE_ENV === 'production',
  },
} as const;
```

Using `gpt-4o-mini` in development saves costs — it's 15x cheaper than `gpt-4o` and sufficient for testing clip detection logic.

## Troubleshooting

**Supabase local fails to start**: Docker must be running. On Windows, ensure WSL2 backend is enabled for Docker Desktop. Run `docker info` to verify.

**CORS errors on video playback**: Check that your storage bucket CORS policy allows the origin. For local dev, the Supabase CLI configures CORS automatically, but custom policies in `supabase/config.toml` may override this.

**OpenAI rate limit errors (429)**: You've hit the RPM or TPM limit. Add exponential backoff to your OpenAI client calls or reduce concurrent requests in the processing pipeline.

**Supabase connection pool exhaustion**: The default connection pool (pgBouncer) allows 15 connections on the free tier. If you see "too many connections" errors, reduce the Prisma/Drizzle pool size or upgrade the Supabase plan.

## Next Steps

With the environment configured, proceed to:
- `01-vercel-deployment.md` for deploying to Vercel
- `03-database-migration.md` for running database migrations
