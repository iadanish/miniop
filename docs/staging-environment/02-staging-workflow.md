# Staging Workflow

## Overview

This document defines the development workflow for MiniOp's staging environment: branching strategy, PR lifecycle, database migrations, feature flags, video processing pipeline testing, and promotion to production. Covers both free-tier (Vercel + Supabase branching) and scaled production (dedicated staging infra).

---

## Branching Strategy

### Free Tier: Vercel Preview + Supabase Branching

```
main (production)
├── staging (pre-production)
│   ├── feat/video-trim          ← PR → Vercel preview + Supabase branch
│   ├── feat/ai-highlights       ← PR → Vercel preview + Supabase branch
│   └── fix/subtitle-sync        ← PR → Vercel preview + Supabase branch
```

Each feature branch gets:
- **Vercel Preview URL**: `minioop-git-feat-video-trim-team.vercel.app`
- **Supabase Branch**: isolated database with latest migrations

```bash
# Create feature branch
git checkout -b feat/video-trim

# Push triggers automatic preview deployment
git push origin feat/video-trim

# Vercel bot comments on PR with preview URL
# Supabase branching creates isolated database
```

### Scaled Production: Environment Promotion

```
feature branches → staging → main (production)
       ↓              ↓           ↓
  PR previews    staging env   production
  (ephemeral)   (persistent)   (persistent)
```

```bash
# Merge to staging for team testing
git checkout staging
git merge feat/video-trim
git push origin staging
# → Deploys to staging.minioop.example.com

# After validation, merge to main
git checkout main
git merge staging
git push origin main
# → Deploys to production
```

---

## Pull Request Lifecycle

### Step 1: Create PR

```bash
git checkout -b feat/clip-export
# Make changes
git add .
git commit -m "feat: add clip export in MP4 and WebM formats"
git push origin feat/clip-export
```

### Step 2: Automated Checks

GitHub Actions runs on every PR:

```yaml
# .github/workflows/pr-check.yml
name: PR Checks

on:
  pull_request:
    branches: [main, staging]

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test:unit -- --coverage
      - run: npm run build

  preview-db:
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
      - run: supabase db push --linked
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
```

### Step 3: Review Preview Deployment

Verify preview URL works:

```bash
# Get preview URL from PR comments
PREVIEW_URL="https://minioop-git-feat-clip-export-team.vercel.app"

# Test health endpoint
curl "$PREVIEW_URL/api/health"

# Test specific feature
curl -X POST "$PREVIEW_URL/api/videos/upload" \
  -H "Authorization: Bearer $PREVIEW_TOKEN" \
  -F "file=@test-video.mp4"
```

### Step 4: Database Migration Review

Check that Supabase branch migrations are correct:

```bash
# List migrations on branch
supabase db diff --linked

# Verify migration SQL
cat supabase/migrations/20240115000000_add_export_formats.sql
```

Migration file:

```sql
-- supabase/migrations/20240115000000_add_export_formats.sql

CREATE TYPE export_format AS ENUM ('mp4', 'webm', 'gif', 'mov');

ALTER TABLE clips ADD COLUMN export_format export_format DEFAULT 'mp4';
ALTER TABLE clips ADD COLUMN export_quality VARCHAR(20) DEFAULT 'high';

CREATE INDEX idx_clips_export_format ON clips(export_format);

-- Add RLS policy for exports
CREATE POLICY "Users can export own clips"
  ON clips FOR SELECT
  USING (auth.uid() = user_id);
```

### Step 5: Merge

After approval and green checks:

```bash
# Squash merge via GitHub UI or CLI
gh pr merge feat/clip-export --squash

# Supabase branch auto-merges migrations
# Vercel preview auto-deletes
```

---

## Video Processing Pipeline Testing

MiniOp's core functionality is video processing. Test the full pipeline in staging.

### Upload Flow

```typescript
// Test script: scripts/test-upload.ts
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function testUpload() {
  const testVideo = path.join(__dirname, '../fixtures/test-video.mp4');

  // Upload to storage
  const { data: upload, error: uploadError } = await supabase.storage
    .from('videos')
    .upload(`uploads/test-${Date.now()}.mp4`, fs.createReadStream(testVideo), {
      contentType: 'video/mp4',
      upsert: false,
    });

  if (uploadError) throw uploadError;
  console.log('Upload successful:', upload.path);

  // Create video record
  const { data: video, error: dbError } = await supabase
    .from('videos')
    .insert({
      user_id: 'test-user-id',
      storage_path: upload.path,
      status: 'uploaded',
      duration: 120,
      file_size: fs.statSync(testVideo).size,
    })
    .select()
    .single();

  if (dbError) throw dbError;
  console.log('Video record created:', video.id);

  // Trigger processing
  const response = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/videos/process`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ videoId: video.id }),
  });

  const result = await response.json();
  console.log('Processing triggered:', result);

  // Poll for completion
  let status = 'processing';
  while (status === 'processing') {
    await new Promise(r => setTimeout(r, 5000));
    const { data } = await supabase
      .from('videos')
      .select('status')
      .eq('id', video.id)
      .single();
    status = data!.status;
    console.log('Status:', status);
  }

  console.log('Final status:', status);
}

testUpload().catch(console.error);
```

### AI Highlight Detection

Test OpenAI integration for highlight detection:

```typescript
// Test script: scripts/test-highlights.ts
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function testHighlightDetection() {
  const transcript = `
    Welcome to today's stream everyone!
    [00:15] And here we go, the most insane play I've ever made!
    [00:18] Did you see that? That was absolutely incredible!
    [00:25] Chat is going crazy right now
    [01:30] Alright, let's get back to the main content
    [05:45] Okay this next part is really important
    [05:50] Watch carefully what happens here
  `;

  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      {
        role: 'system',
        content: `You are a video highlight detector. Identify the most engaging 
        moments from this transcript. Return JSON with highlights array containing 
        start_time, end_time, title, and engagement_score (1-10).`,
      },
      {
        role: 'user',
        content: transcript,
      },
    ],
    response_format: { type: 'json_object' },
  });

  const highlights = JSON.parse(response.choices[0].message.content!);
  console.log('Detected highlights:', JSON.stringify(highlights, null, 2));

  // Validate response structure
  if (!highlights.highlights || !Array.isArray(highlights.highlights)) {
    throw new Error('Invalid response structure');
  }

  for (const highlight of highlights.highlights) {
    if (!highlight.start_time || !highlight.engagement_score) {
      throw new Error('Missing required fields in highlight');
    }
  }

  console.log('Highlight detection test passed');
}

testHighlightDetection().catch(console.error);
```

### Clip Generation

Test FFmpeg clip generation:

```typescript
// src/lib/ffmpeg.ts
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

interface ClipOptions {
  inputPath: string;
  outputPath: string;
  startTime: number;
  duration: number;
  format: 'mp4' | 'webm' | 'gif';
  quality: 'low' | 'medium' | 'high';
}

const qualityPresets = {
  low: { crf: '28', preset: 'ultrafast' },
  medium: { crf: '23', preset: 'medium' },
  high: { crf: '18', preset: 'slow' },
};

export async function generateClip(options: ClipOptions): Promise<string> {
  const { inputPath, outputPath, startTime, duration, format, quality } = options;
  const preset = qualityPresets[quality];

  let ffmpegCmd: string;

  switch (format) {
    case 'mp4':
      ffmpegCmd = `ffmpeg -i "${inputPath}" -ss ${startTime} -t ${duration} \
        -c:v libx264 -crf ${preset.crf} -preset ${preset.preset} \
        -c:a aac -b:a 128k \
        -movflags +faststart "${outputPath}"`;
      break;

    case 'webm':
      ffmpegCmd = `ffmpeg -i "${inputPath}" -ss ${startTime} -t ${duration} \
        -c:v libvpx-vp9 -crf ${preset.crf} -b:v 0 \
        -c:a libopus -b:a 128k \
        "${outputPath}"`;
      break;

    case 'gif':
      ffmpegCmd = `ffmpeg -i "${inputPath}" -ss ${startTime} -t ${duration} \
        -vf "fps=15,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
        "${outputPath}"`;
      break;

    default:
      throw new Error(`Unsupported format: ${format}`);
  }

  await execAsync(ffmpegCmd);
  return outputPath;
}
```

Test clip generation:

```bash
# Generate test clip
npm run test:clip -- \
  --input fixtures/test-video.mp4 \
  --start 15 \
  --duration 30 \
  --format mp4 \
  --quality high

# Verify output
ffprobe -v quiet -print_format json -show_format -show_streams output/clip-001.mp4
```

---

## Feature Flags

Use feature flags to test incomplete features in staging without affecting production.

### Configuration

```typescript
// src/lib/feature-flags.ts
export interface FeatureFlags {
  NEW_EXPORT_FORMATS: boolean;
  AI_HIGHLIGHTS_V2: boolean;
  REAL_TIME_CAPTIONS: boolean;
  BATCH_PROCESSING: boolean;
}

const flags: Record<string, Record<string, boolean>> = {
  production: {
    NEW_EXPORT_FORMATS: false,
    AI_HIGHLIGHTS_V2: false,
    REAL_TIME_CAPTIONS: false,
    BATCH_PROCESSING: false,
  },
  staging: {
    NEW_EXPORT_FORMATS: true,
    AI_HIGHLIGHTS_V2: true,
    REAL_TIME_CAPTIONS: true,
    BATCH_PROCESSING: false,
  },
  development: {
    NEW_EXPORT_FORMATS: true,
    AI_HIGHLIGHTS_V2: true,
    REAL_TIME_CAPTIONS: true,
    BATCH_PROCESSING: true,
  },
};

export function getFlag(flag: keyof FeatureFlags): boolean {
  const env = process.env.NODE_ENV || 'development';
  return flags[env]?.[flag] ?? false;
}

export function withFlags<T>(flag: keyof FeatureFlags, enabled: T, disabled: T): T {
  return getFlag(flag) ? enabled : disabled;
}
```

### Usage in Components

```tsx
// src/components/ExportDialog.tsx
import { getFlag } from '@/lib/feature-flags';

export function ExportDialog({ clipId }: { clipId: string }) {
  const showNewFormats = getFlag('NEW_EXPORT_FORMATS');

  return (
    <div>
      <h3>Export Clip</h3>
      <select>
        <option value="mp4">MP4</option>
        <option value="webm">WebM</option>
        {showNewFormats && (
          <>
            <option value="gif">GIF</option>
            <option value="mov">MOV (ProRes)</option>
          </>
        )}
      </select>
    </div>
  );
}
```

### Usage in API Routes

```typescript
// src/app/api/clips/export/route.ts
import { getFlag } from '@/lib/feature-flags';
import { generateClip } from '@/lib/ffmpeg';

export async function POST(request: Request) {
  const { clipId, format, quality } = await request.json();

  // Gate new formats behind feature flag
  const allowedFormats = ['mp4', 'webm'];
  if (getFlag('NEW_EXPORT_FORMATS')) {
    allowedFormats.push('gif', 'mov');
  }

  if (!allowedFormats.includes(format)) {
    return Response.json(
      { error: `Format ${format} not available` },
      { status: 400 }
    );
  }

  // Process export...
  const clip = await generateClip({
    inputPath: `uploads/${clipId}`,
    outputPath: `exports/${clipId}.${format}`,
    startTime: 0,
    duration: 30,
    format,
    quality,
  });

  return Response.json({ clip });
}
```

---

## Database Migration Workflow

### Creating Migrations

```bash
# Create new migration
supabase migration new add_batch_processing

# Edit migration file
vim supabase/migrations/20240120000000_add_batch_processing.sql
```

Migration content:

```sql
-- supabase/migrations/20240120000000_add_batch_processing.sql

CREATE TABLE batch_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  total_clips INTEGER NOT NULL DEFAULT 0,
  completed_clips INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE batch_job_clips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_job_id UUID NOT NULL REFERENCES batch_jobs(id) ON DELETE CASCADE,
  video_id UUID NOT NULL REFERENCES videos(id),
  clip_config JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  output_path TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_batch_jobs_user_id ON batch_jobs(user_id);
CREATE INDEX idx_batch_jobs_status ON batch_jobs(status);
CREATE INDEX idx_batch_job_clips_batch_id ON batch_job_clips(batch_job_id);

ALTER TABLE batch_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_job_clips ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own batch jobs"
  ON batch_jobs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view own batch job clips"
  ON batch_job_clips FOR SELECT
  USING (
    batch_job_id IN (
      SELECT id FROM batch_jobs WHERE user_id = auth.uid()
    )
  );

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER batch_jobs_updated_at
  BEFORE UPDATE ON batch_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
```

### Testing Migrations

```bash
# Test migration locally
supabase db reset

# Verify schema
supabase db diff

# Test rollback (create down migration)
cat > supabase/migrations/20240120000000_add_batch_processing.down.sql << 'EOF'
DROP TRIGGER IF EXISTS batch_jobs_updated_at ON batch_jobs;
DROP FUNCTION IF EXISTS update_updated_at();
DROP TABLE IF EXISTS batch_job_clips;
DROP TABLE IF EXISTS batch_jobs;
EOF

# Test rollback
supabase migration down 1
supabase db reset
```

### Applying to Staging

```bash
# Push to staging branch
git checkout staging
git merge feat/batch-processing
git push origin staging

# CI automatically:
# 1. Runs migrations against staging database
# 2. Deploys updated code
# 3. Runs smoke tests
```

---

## Monitoring Staging Deployments

### Deployment Notifications

```yaml
# .github/workflows/staging-notify.yml
name: Staging Deployment Notification

on:
  deployment_status:
    environment: staging

jobs:
  notify:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - name: Notify Slack
        uses: slackapi/slack-github-action@v1
        with:
          payload: |
            {
              "text": "Staging deployment successful",
              "blocks": [
                {
                  "type": "section",
                  "text": {
                    "type": "mrkdwn",
                    "text": "*Staging Deployed* :white_check_mark:\n*Commit:* `${{ github.sha }}`\n*Author:* ${{ github.actor }}\n*URL:* https://staging.minioop.example.com"
                  }
                }
              ]
            }
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

### Staging Logs

```bash
# View staging logs (ECS)
aws logs tail /ecs/minioop-staging --follow

# View specific service logs
aws logs tail /ecs/minioop-staging/api --follow
aws logs tail /ecs/minioop-staging/worker --follow

# Filter errors
aws logs filter-log-events \
  --log-group-name /ecs/minioop-staging \
  --filter-pattern "ERROR" \
  --start-time $(date -d '1 hour ago' +%s)000
```

---

## Rollback Procedure

If staging deployment fails:

```bash
# Option 1: Revert commit and push
git revert HEAD
git push origin staging

# Option 2: Redeploy previous task definition
aws ecs update-service \
  --cluster minioop-staging \
  --service minioop-staging \
  --task-definition minioop-staging:PREVIOUS_REVISION

# Option 3: Rollback database migration
supabase migration down 1
```

---

## Promotion to Production

After staging validation:

```bash
# 1. Create production PR
gh pr create --base main --head staging \
  --title "Release: staging → production" \
  --body "Staging validated. Ready for production."

# 2. After approval, merge
gh pr merge --squash

# 3. CI deploys to production
# 4. Monitor production health
curl https://minioop.example.com/api/health
```

---

## Next Steps

With staging workflow established, proceed to [03-smoke-testing.md](./03-smoke-testing.md) for comprehensive validation procedures.
