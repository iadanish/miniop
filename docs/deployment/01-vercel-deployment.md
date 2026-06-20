# Vercel Deployment Guide

This guide covers deploying MiniOp to Vercel in two configurations: a free-tier setup suitable for development and small-scale usage, and a production-grade deployment with edge functions, preview environments, and optimized build pipelines.

## Prerequisites

- A GitHub, GitLab, or Bitbucket repository containing the MiniOp codebase
- A Vercel account (free tier works for initial deployment)
- A Supabase project (see `02-environment-setup.md` for provisioning)
- Node.js 18+ locally for testing builds before pushing

## Free Tier Deployment

### Step 1: Import the Repository

Navigate to [vercel.com/new](https://vercel.com/new) and select your MiniOp repository. Vercel auto-detects Next.js projects and pre-fills the framework preset. If the detection fails, manually set:

- **Framework Preset**: Next.js
- **Build Command**: `npm run build`
- **Output Directory**: `.next`
- **Install Command**: `npm install`

### Step 2: Configure Environment Variables

In the Vercel dashboard, go to **Settings > Environment Variables** and add:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
OPENAI_API_KEY=sk-proj-...
NEXT_PUBLIC_APP_URL=https://your-app.vercel.app
```

Apply these to **Production**, **Preview**, and **Development** environments. The `SUPABASE_SERVICE_ROLE_KEY` must never be prefixed with `NEXT_PUBLIC_` — it bypasses Row Level Security and must only run server-side.

### Step 3: Deploy

Click **Deploy**. Vercel runs `npm install`, then `npm run build`, then serves the output. The free tier (Hobby plan) includes:

- 100 GB bandwidth per month
- Serverless function execution up to 10 seconds per invocation
- Automatic HTTPS and global CDN
- Unlimited static deployments

### Step 4: Verify the Deployment

After deployment completes, visit the assigned `.vercel.app` URL. Confirm:

1. The landing page loads without hydration errors (check browser console)
2. Authentication flows work (sign up, sign in, sign out)
3. Video upload triggers the processing pipeline (check Supabase Edge Functions logs)
4. The clip preview renders with correct timestamps

If authentication redirects fail, verify `NEXT_PUBLIC_APP_URL` matches the actual deployment URL exactly, including the protocol.

## Free Tier Limitations and Workarounds

The Hobby plan imposes constraints that affect MiniOp specifically:

**Serverless Function Timeout (10s)**: Video processing webhook handlers may exceed this. Work around it by using Supabase Edge Functions for the actual processing orchestration — the Vercel function only enqueues the job. In your API route:

```typescript
// app/api/process/route.ts
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: Request) {
  const { videoId } = await request.json();

  const { error } = await supabase.functions.invoke('process-video', {
    body: { videoId },
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ status: 'queued' });
}
```

**Bandwidth (100 GB/month)**: Each processed clip download consumes bandwidth. For free-tier projects, serve final clips from Supabase Storage directly rather than proxying through Vercel. Set the storage bucket to public and return the Supabase Storage URL to the client.

**Single Concurrent Build**: Free-tier accounts process one deployment at a time. If you push multiple commits rapidly, builds queue. This is acceptable for solo development but blocks team workflows.

## Production Deployment

### Step 1: Upgrade to Pro Plan

The Pro plan ($20/member/month) removes the critical bottlenecks:

- Serverless function timeout increases to 60 seconds (configurable up to 300s with Fluid Compute)
- 1 TB bandwidth per month
- Concurrent builds (up to 3 per account)
- Preview deployments with authentication
- Custom domains with automatic SSL

### Step 2: Configure `vercel.json`

Create a `vercel.json` at the repository root for fine-grained control:

```json
{
  "framework": "nextjs",
  "regions": ["iad1", "sfo1", "cdg1"],
  "functions": {
    "app/api/process/*.ts": {
      "maxDuration": 60,
      "memory": 1024
    },
    "app/api/webhooks/*.ts": {
      "maxDuration": 30,
      "memory": 512
    }
  },
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "no-store" }
      ]
    },
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
      ]
    }
  ],
  "crons": [
    {
      "path": "/api/cron/cleanup",
      "schedule": "0 3 * * *"
    }
  ]
}
```

The `regions` array places serverless functions close to your Supabase region. If your Supabase project runs in `us-east-1`, use `iad1`. For EU users, `cdg1` (Paris) or `fra1` (Frankfurt) reduce latency to EU-hosted Supabase instances.

### Step 3: Set Up Preview Deployments

Every pull request gets a unique preview URL. Protect these with Vercel Authentication:

1. Go to **Settings > General > Preview Deployment Protection**
2. Enable **Vercel Authentication** (only team members can access previews)
3. Optionally add password protection for external stakeholder reviews

Configure preview-specific environment variables so previews point to a staging Supabase project:

```bash
# Set via Vercel CLI
vercel env add NEXT_PUBLIC_SUPABASE_URL preview
# Enter: https://staging-project.supabase.co

vercel env add NEXT_PUBLIC_APP_URL preview
# Leave empty — Vercel sets VERCEL_URL automatically
```

In your Next.js config, handle the dynamic preview URL:

```typescript
// next.config.js
const nextConfig = {
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: process.env.NEXT_PUBLIC_APP_URL || '*' },
        ],
      },
    ];
  },
};
```

### Step 4: Configure Custom Domain

1. In Vercel dashboard, go to **Settings > Domains**
2. Add your domain (e.g., `app.miniop.dev`)
3. Add the DNS records Vercel provides — typically a CNAME record pointing to `cname.vercel-dns.com`
4. Vercel provisions SSL automatically via Let's Encrypt

### Step 5: Enable Monitoring and Alerts

Vercel provides built-in observability under **Observability > Web Analytics** and **Speed Insights**. For deeper monitoring:

```bash
# Install Vercel Analytics
npm install @vercel/analytics @vercel/speed-insights
```

```typescript
// app/layout.tsx
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/next';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
```

Set up deployment notifications in **Settings > Notifications** to receive Slack or email alerts on build failures.

### Step 6: CI/CD Integration

Add a GitHub Actions workflow to run tests before Vercel deploys:

```yaml
# .github/workflows/ci.yml
name: CI
on:
  pull_request:
    branches: [main]
jobs:
  test:
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
      - run: npm test
```

Vercel waits for all required GitHub checks to pass before building the deployment. Configure this under **Settings > Git > Ignored Build Step** if you need custom logic.

## Rollback Procedure

Vercel retains all previous deployments. To rollback:

1. Go to **Deployments** in the dashboard
2. Find the last known-good deployment
3. Click the three-dot menu > **Promote to Production**

This is instant — Vercel swaps the production alias to the selected deployment without rebuilding. For programmatic rollback:

```bash
vercel promote <deployment-url>
```

## Cost Estimation

| Resource | Free Tier | Pro Tier |
|----------|-----------|----------|
| Bandwidth | 100 GB/mo | 1 TB/mo |
| Serverless Execution | 100 GB-hrs/mo | 1000 GB-hrs/mo |
| Build Minutes | 6000 min/mo | 24000 min/mo |
| Team Members | 1 | $20/member |
| Preview Deployments | Unlimited | Unlimited + Protection |

For a MiniOp instance serving ~500 monthly active users processing ~2000 clips/month, the Pro plan provides sufficient headroom. Beyond that, consider Vercel Enterprise or self-hosting with Docker on a VPS.
