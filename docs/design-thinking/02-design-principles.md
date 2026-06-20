# MiniOp Design Principles

## Overview

Design principles are non-negotiable constraints that guide every product decision in MiniOp. They resolve ambiguity when stakeholders disagree, speed up design reviews by providing shared vocabulary, and ensure consistency across features built by different developers. This document covers the principles themselves, how they apply at free tier versus production scale, and concrete implementation guidance.

---

## Principle 1: Speed Is a Feature

The user's time is the most expensive resource in the system. Every interaction must feel instant or show meaningful progress. A clip generation that takes 30 seconds with a progress bar is acceptable; a clip generation that takes 30 seconds with a spinner is not.

### Free Tier Implementation

Optimize for perceived speed using progressive disclosure:

```typescript
// Show clip previews as they're generated, not all at once
async function generateClips(videoId: string) {
  const generator = streamClipGeneration(videoId);
  
  for await (const clip of generator) {
    // Render each clip immediately as it's ready
    renderClipCard({
      id: clip.id,
      thumbnailUrl: clip.thumbnailUrl,
      timestamp: clip.startTime,
      viralityScore: clip.score,
      status: 'preview',
    });
    
    // Don't wait for all clips to finish
    updateProgressClips(clip.index, clip.total);
  }
}
```

Use streaming API responses from OpenAI to show AI reasoning in real-time:

```typescript
// Stream AI clip selection reasoning
const stream = await openai.chat.completions.create({
  model: 'gpt-4o',
  stream: true,
  messages: [
    {
      role: 'system',
      content: 'Analyze this video transcript and identify the 5 most viral-worthy moments. Explain your reasoning for each.',
    },
    { role: 'user', content: transcript },
  ],
});

for await (const chunk of stream) {
  appendToReasoningPanel(chunk.choices[0]?.delta?.content ?? '');
}
```

### Production-Scale Implementation

At scale, speed requires infrastructure investment:

```yaml
# Kubernetes deployment for clip generation workers
apiVersion: apps/v1
kind: Deployment
metadata:
  name: clip-generator
spec:
  replicas: 3
  selector:
    matchLabels:
      app: clip-generator
  template:
    spec:
      containers:
        - name: clip-generator
          image: minio/clip-generator:latest
          resources:
            requests:
              cpu: "2"
              memory: "4Gi"
              nvidia.com/gpu: "1"  # GPU for video encoding
            limits:
              cpu: "4"
              memory: "8Gi"
              nvidia.com/gpu: "1"
          env:
            - name: MAX_CONCURRENT_JOBS
              value: "5"
            - name: ENCODING_PRESET
              value: "fast"  # Trade quality for speed on free tier
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: clip-generator-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: clip-generator
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Pods
      pods:
        metric:
          name: job_queue_depth
        target:
          type: AverageValue
          averageValue: "3"
```

---

## Principle 2: Defaults Should Be Correct

Users should never have to configure something to get a good result. The first clip generated from a video should be good enough to export without editing. Configuration exists for power users, not as a crutch for bad defaults.

### Free Tier Implementation

Pre-configure everything based on research-backed best practices:

```typescript
// Default clip generation settings based on platform research
const DEFAULT_CLIP_SETTINGS = {
  // TikTok and Reels perform best at 30-60 seconds
  targetDuration: { min: 15, max: 60, optimal: 35 },
  
  // 9:16 is the dominant vertical video format
  aspectRatio: '9:16',
  
  // Open with the hook, not the intro
  skipIntro: true,
  introSkipDuration: 5, // seconds
  
  // Subtitles are mandatory (80% watch muted)
  subtitles: {
    enabled: true,
    style: 'bold-outline', // Highest readability
    fontSize: 48,
    position: 'bottom-third',
    maxWordsPerLine: 5,
  },
  
  // Platform-specific encoding
  encoding: {
    codec: 'h264',
    bitrate: '8M',
    fps: 30,
    audioBitrate: '128k',
  },
};
```

These defaults are non-negotiable for the free tier. Users can change them, but the default path must produce export-ready clips.

### Production-Scale Implementation

At scale, defaults adapt per segment and platform:

```typescript
// Platform-specific default profiles
const PLATFORM_PROFILES = {
  tiktok: {
    maxDuration: 60,
    aspectRatio: '9:16',
    subtitles: { style: 'tiktok-bold', fontSize: 52 },
    encoding: { bitrate: '6M', fps: 30 },
  },
  instagram_reels: {
    maxDuration: 90,
    aspectRatio: '9:16',
    subtitles: { style: 'clean-sans', fontSize: 44 },
    encoding: { bitrate: '8M', fps: 30 },
  },
  youtube_shorts: {
    maxDuration: 60,
    aspectRatio: '9:16',
    subtitles: { style: 'youtube-default', fontSize: 46 },
    encoding: { bitrate: '10M', fps: 30 },
  },
  twitter: {
    maxDuration: 140,
    aspectRatio: '16:9', // Twitter still favors landscape
    subtitles: { style: 'minimal', fontSize: 40 },
    encoding: { bitrate: '5M', fps: 30 },
  },
};

// Brand kit overrides for paid users
function resolveClipSettings(user, platform) {
  const platformDefaults = PLATFORM_PROFILES[platform];
  const brandOverrides = user.brandKit ?? {};
  
  return {
    ...platformDefaults,
    ...brandOverrides,
    subtitles: {
      ...platformDefaults.subtitles,
      ...brandOverrides.subtitles,
    },
  };
}
```

---

## Principle 3: Progressive Disclosure

Show simple things simply. Advanced features exist but don't surface them until the user demonstrates they need them. The free tier should feel like a one-button tool; the paid tier reveals depth as users engage.

### Free Tier Implementation

The primary UI flow is three steps:

```
Upload Video → AI Generates Clips → Export
```

Advanced options are hidden behind an "Advanced" toggle:

```tsx
function ClipEditor({ clip }: { clip: Clip }) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  
  return (
    <div className="clip-editor">
      {/* Always visible: the essentials */}
      <ClipPreview clip={clip} />
      <SubtitlesEditor subtitles={clip.subtitles} />
      <ExportButton clip={clip} />
      
      {/* Hidden until requested */}
      <button 
        onClick={() => setShowAdvanced(true)}
        className="text-sm text-gray-500 hover:text-gray-700"
      >
        Advanced settings
      </button>
      
      {showAdvanced && (
        <AdvancedSettings>
          <DurationSlider clip={clip} />
          <AspectRatioSelector />
          <SubtitleStyleEditor />
          <AudioTrackSelector />
          <BrandingOverlay />
        </AdvancedSettings>
      )}
    </div>
  );
}
```

### Production-Scale Implementation

Progressive disclosure scales with user tenure and plan:

```typescript
// Feature visibility rules
const FEATURE_FLAGS = {
  // Free tier: always visible
  basic_clip_generation: { minPlan: 'free', minClips: 0 },
  subtitle_editor: { minPlan: 'free', minClips: 0 },
  platform_export: { minPlan: 'free', minClips: 0 },
  
  // Revealed after first successful clip
  clip_trimming: { minPlan: 'free', minClips: 1 },
  subtitle_styling: { minPlan: 'free', minClips: 1 },
  
  // Paid features
  brand_kit: { minPlan: 'pro', minClips: 0 },
  batch_processing: { minPlan: 'pro', minClips: 0 },
  analytics_dashboard: { minPlan: 'pro', minClips: 5 },
  api_access: { minPlan: 'business', minClips: 0 },
  white_label: { minPlan: 'enterprise', minClips: 0 },
};

function isFeatureVisible(feature: string, user: User): boolean {
  const config = FEATURE_FLAGS[feature];
  const planHierarchy = ['free', 'pro', 'business', 'enterprise'];
  
  const userPlanIndex = planHierarchy.indexOf(user.plan);
  const requiredPlanIndex = planHierarchy.indexOf(config.minPlan);
  
  return (
    userPlanIndex >= requiredPlanIndex &&
    user.totalClipsGenerated >= config.minClips
  );
}
```

---

## Principle 4: Errors Are Conversations

Error messages must tell the user what happened, why it happened, and what they can do about it. Stack traces are for developers; users need plain language with a clear next action.

### Free Tier Implementation

```typescript
// Error handling with user-friendly messages
class ClipGenerationError extends Error {
  constructor(
    public code: string,
    public userMessage: string,
    public action: { label: string; handler: () => void },
    public technicalDetails?: string
  ) {
    super(userMessage);
  }
}

const ERROR_MAP = {
  VIDEO_TOO_LONG: new ClipGenerationError(
    'VIDEO_TOO_LONG',
    'Your video is over 4 hours long. Free accounts process videos up to 2 hours. Upgrade to Pro for longer videos.',
    { label: 'Upgrade to Pro', handler: () => navigate('/pricing') }
  ),
  
  UNSUPPORTED_FORMAT: new ClipGenerationError(
    'UNSUPPORTED_FORMAT',
    'We don\'t support .wmv files yet. Try converting to .mp4 or .mov first.',
    { label: 'See supported formats', handler: () => openHelp('formats') }
  ),
  
  PROCESSING_FAILED: new ClipGenerationError(
    'PROCESSING_FAILED',
    'Something went wrong while generating clips. We\'ve saved your video—try again and it should work.',
    { label: 'Retry', handler: () => retryGeneration() }
  ),
  
  RATE_LIMITED: new ClipGenerationError(
    'RATE_LIMITED',
    'You\'ve hit your monthly limit of 90 minutes. Your limit resets on the 1st, or upgrade for unlimited processing.',
    { label: 'Upgrade to Pro', handler: () => navigate('/pricing') }
  ),
};
```

### Production-Scale Implementation

At scale, errors feed into observability:

```typescript
// Error telemetry for production debugging
function handleError(error: ClipGenerationError, context: RequestContext) {
  // Log to observability platform
  logger.error('clip_generation_failed', {
    error_code: error.code,
    user_id: context.userId,
    video_id: context.videoId,
    plan: context.userPlan,
    technical_details: error.technicalDetails,
    stack: error.stack,
  });
  
  // Track error rates for alerting
  metrics.increment('clip_generation.errors', {
    code: error.code,
    plan: context.userPlan,
  });
  
  // Show user-friendly message
  showErrorToast({
    title: error.userMessage,
    action: error.action,
  });
}
```

---

## Principle 5: Build for the Marginalized User

Design for the user with the worst internet, the oldest device, and the least technical skill. If it works for them, it works for everyone. This means: minimal JavaScript bundles, server-side rendering, offline-capable core flows, and accessible UI.

### Free Tier Implementation

```typescript
// Next.js configuration for performance
// next.config.js
module.exports = {
  // Static generation where possible
  output: 'standalone',
  
  // Image optimization
  images: {
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [640, 750, 828, 1080],
  },
  
  // Bundle analysis
  webpack: (config, { dev }) => {
    if (!dev) {
      config.plugins.push(
        new BundleAnalyzerPlugin({
          analyzerMode: 'disabled',
          generateStatsFile: true,
        })
      );
    }
    return config;
  },
  
  // Compression
  compress: true,
  
  // Headers for caching
  async headers() {
    return [
      {
        source: '/api/clips/:id',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=3600' },
        ],
      },
    ];
  },
};
```

### Production-Scale Implementation

At scale, performance budgets are enforced in CI:

```yaml
# .github/workflows/performance-budget.yml
name: Performance Budget
on: [pull_request]

jobs:
  lighthouse:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Lighthouse
        uses: treosh/lighthouse-ci-action@v10
        with:
          urls: |
            https://staging.minio.dev/
            https://staging.minio.dev/dashboard
          budgetPath: ./lighthouse-budget.json
          uploadArtifacts: true

# lighthouse-budget.json
[
  {
    "path": "/*",
    "resourceSizes": [
      { "resourceType": "total", "budget": 300 },
      { "resourceType": "script", "budget": 150 },
      { "resourceType": "image", "budget": 100 }
    ],
    "resourceCounts": [
      { "resourceType": "third-party", "budget": 10 }
    ],
    "timings": [
      { "metric": "largest-contentful-paint", "budget": 2500 },
      { "metric": "cumulative-layout-shift", "budget": 0.1 },
      { "metric": "total-blocking-time", "budget": 200 }
    ]
  }
]
```

---

## Principle 6: Data Belongs to the User

Users own their videos, clips, and data. They can export everything, delete everything, and we never use their content to train models without explicit consent. This builds trust and differentiates from competitors who silently train on uploads.

### Implementation

```typescript
// User data export endpoint
app.get('/api/user/export', requireAuth, async (req, res) => {
  const user = req.user;
  
  // Collect all user data
  const exportData = {
    profile: await db.users.findById(user.id),
    videos: await db.videos.findByUser(user.id),
    clips: await db.clips.findByUser(user.id),
    exports: await db.exports.findByUser(user.id),
    settings: await db.userSettings.findByUser(user.id),
    analytics: await db.clipAnalytics.findByUser(user.id),
  };
  
  // Generate downloadable archive
  const archive = archiver('zip');
  archive.append(JSON.stringify(exportData, null, 2), { name: 'data.json' });
  
  for (const video of exportData.videos) {
    const stream = await storage.get(video.storageKey);
    archive.append(stream, { name: `videos/${video.filename}` });
  }
  
  for (const clip of exportData.clips) {
    const stream = await storage.get(clip.storageKey);
    archive.append(stream, { name: `clips/${clip.filename}` });
  }
  
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="minio-export-${user.id}.zip"`);
  archive.pipe(res);
  archive.finalize();
});

// Hard delete - removes all data permanently
app.delete('/api/user/account', requireAuth, async (req, res) => {
  const user = req.user;
  
  // Delete from storage
  const videos = await db.videos.findByUser(user.id);
  for (const video of videos) {
    await storage.delete(video.storageKey);
  }
  
  const clips = await db.clips.findByUser(user.id);
  for (const clip of clips) {
    await storage.delete(clip.storageKey);
  }
  
  // Delete from database (cascade)
  await db.users.hardDelete(user.id);
  
  // Clear from cache
  await cache.flush(`user:${user.id}`);
  
  res.status(204).send();
});
```

---

## Principle Application Matrix

| Principle | Free Tier | Production |
|-----------|-----------|------------|
| Speed Is a Feature | Streaming responses, progress bars | GPU workers, auto-scaling, CDN |
| Defaults Should Be Correct | One-size-fits-all best practices | Platform-specific + brand kit overrides |
| Progressive Disclosure | Advanced toggle hides complexity | Feature flags by plan + tenure |
| Errors Are Conversations | Friendly messages + clear actions | Telemetry + alerting + support escalation |
| Build for Marginalized User | Performance budgets, SSR, a11y | CI enforcement, global CDN, offline support |
| Data Belongs to the User | Export + delete endpoints | Encryption at rest, audit logs, compliance |

---

## Using These Principles in Code Reviews

Every PR should reference applicable principles:

```
## What
Add streaming clip preview as clips are generated.

## Why
Principle 1 (Speed Is a Feature): Users currently wait for all clips to finish
before seeing any. Streaming previews make the tool feel 3x faster.

## How
- Subscribe to clip generation SSE events
- Render ClipCard components as each clip completes
- Show aggregate progress indicator

Ref: docs/design-thinking/02-design-principles.md#principle-1
```

---

## Conclusion

These six principles are not aspirational—they are constraints. Every feature, bug fix, and design decision must be justified against them. When principles conflict (speed vs. defaults), the user's immediate need wins. When in doubt, ship the simpler version and iterate.
