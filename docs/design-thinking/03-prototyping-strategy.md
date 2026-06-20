# MiniOp Prototyping Strategy

## Overview

Prototyping at MiniOp follows a three-phase approach: validate the riskiest assumptions with disposable prototypes, build interactive prototypes for user testing, then harden into production code. This document defines the methodology, tools, timelines, and implementation details for each phase across free-tier MVP and scaled production contexts.

---

## Phase 1: Riskiest Assumption Testing (RAT)

Before writing production code, validate the technical and user-experience assumptions that could kill the product. For MiniOp, the three riskiest assumptions are:

1. **AI can identify viral-worthy clip moments** from a transcript with >70% user agreement
2. **Auto-generated subtitles are readable** without manual editing
3. **Users will pay for automated clipping** (not just use free CapCut/Descript)

### RAT for AI Clip Selection

Build a disposable prototype that tests whether GPT-4o can select clip-worthy moments:

```python
# rat_clip_selection.py - Disposable prototype for validating AI clip selection
import json
import openai
from youtube_transcript_api import YouTubeTranscriptApi

def get_transcript(video_url: str) -> list[dict]:
    """Fetch transcript from YouTube video."""
    video_id = video_url.split("v=")[1].split("&")[0]
    return YouTubeTranscriptApi.get_transcript(video_id)

def segment_transcript(transcript: list[dict], segment_duration: int = 60) -> list[dict]:
    """Split transcript into overlapping segments for analysis."""
    segments = []
    current_segment = []
    start_time = transcript[0]["start"]
    
    for entry in transcript:
        current_segment.append(entry)
        elapsed = entry["start"] + entry["duration"] - start_time
        
        if elapsed >= segment_duration:
            segments.append({
                "start": start_time,
                "end": entry["start"] + entry["duration"],
                "text": " ".join(e["text"] for e in current_segment),
            })
            # Overlap: keep last 10 seconds
            overlap_entries = [e for e in current_segment if e["start"] >= entry["start"] - 10]
            current_segment = overlap_entries
            start_time = overlap_entries[0]["start"] if overlap_entries else entry["start"]
    
    return segments

def rate_segments(segments: list[dict]) -> list[dict]:
    """Use GPT-4o to rate each segment for viral potential."""
    prompt = """You are a social media content expert. Rate each video segment 
for viral potential on TikTok/Reels on a 1-10 scale.

Consider:
- Emotional impact (surprise, humor, inspiration)
- Self-contained value (makes sense without context)
- Quotability (would someone share this?)
- Hook strength (does it grab attention in 3 seconds?)

Return JSON array with: {segment_index, score, reasoning, suggested_hook}

Segments:
"""
    for i, seg in enumerate(segments):
        prompt += f"\n[{i}] ({seg['start']:.0f}s-{seg['end']:.0f}s): {seg['text']}"
    
    response = openai.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
        temperature=0.3,
    )
    
    return json.loads(response.choices[0].message.content)

def run_rat(video_url: str):
    """Run the riskiest assumption test."""
    transcript = get_transcript(video_url)
    segments = segment_transcript(transcript)
    ratings = rate_segments(segments)
    
    # Output for manual review
    print(f"\n{'='*60}")
    print(f"Video: {video_url}")
    print(f"Segments analyzed: {len(segments)}")
    print(f"{'='*60}\n")
    
    for r in sorted(ratings, key=lambda x: x["score"], reverse=True)[:5]:
        seg = segments[r["segment_index"]]
        print(f"Score: {r['score']}/10 | {seg['start']:.0f}s - {seg['end']:.0f}s")
        print(f"Hook: {r['suggested_hook']}")
        print(f"Reason: {r['reasoning']}")
        print(f"Text: {seg['text'][:100]}...")
        print()

if __name__ == "__main__":
    # Test with 10 popular videos across different genres
    test_urls = [
        "https://www.youtube.com/watch?v=EXAMPLE1",  # Podcast
        "https://www.youtube.com/watch?v=EXAMPLE2",  # Tutorial
        "https://www.youtube.com/watch?v=EXAMPLE3",  # Interview
    ]
    
    for url in test_urls:
        run_rat(url)
```

Run this prototype manually, then have 5 people rate the same clips independently. If >70% agree with the AI's top 5 selections, the assumption is validated.

### RAT for Subtitle Readability

Test subtitle rendering across devices before building a full subtitle engine:

```typescript
// rat_subtitle_rendering.tsx - Quick prototype to test subtitle readability
// Run with: npx tsx rat_subtitle_rendering.tsx

import { createCanvas } from 'canvas';
import fs from 'fs';

const SUBTITLE_STYLES = [
  { name: 'bold-outline', font: 'bold 48px Arial', fill: '#FFFFFF', stroke: '#000000', strokeWidth: 4 },
  { name: 'minimal', font: '40px Helvetica', fill: '#FFFFFF', stroke: null, strokeWidth: 0, shadow: true },
  { name: 'tiktok-style', font: 'bold 52px Impact', fill: '#FFEB3B', stroke: '#000000', strokeWidth: 3 },
  { name: 'clean-sans', font: '44px "SF Pro"', fill: '#FFFFFF', stroke: '#000000', strokeWidth: 2 },
];

const TEST_LINES = [
  "This is a short line",
  "This is a longer line that tests wrapping behavior across the frame",
  "Multiple words here to test reading speed and line breaks",
];

function renderSubtitle(
  style: typeof SUBTITLE_STYLES[0],
  text: string,
  width: number = 1080,
  height: number = 1920
): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  
  // Dark background simulating video
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, width, height);
  
  // Position at bottom third
  const y = height * 0.72;
  
  ctx.font = style.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  // Shadow for readability
  if (style.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
  }
  
  // Stroke outline
  if (style.stroke) {
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.strokeWidth;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, width / 2, y);
  }
  
  // Fill text
  ctx.fillStyle = style.fill;
  ctx.fillText(text, width / 2, y);
  
  return canvas.toBuffer('image/png');
}

// Generate comparison images
for (const style of SUBTITLE_STYLES) {
  for (const line of TEST_LINES) {
    const buffer = renderSubtitle(style, line);
    const filename = `subtitle-test-${style.name}-${line.length}.png`;
    fs.writeFileSync(filename, buffer);
    console.log(`Generated: ${filename}`);
  }
}

console.log('\nReview the generated images to determine which style is most readable.');
```

### RAT for Payment Validation

Test willingness to pay before building billing infrastructure:

```typescript
// Landing page with waitlist + payment intent survey
// Deploy to Vercel as a single page

// pages/index.tsx
import { useState } from 'react';

export default function LandingPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [pricePoint, setPricePoint] = useState<string | null>(null);

  const handleJoinWaitlist = async () => {
    await fetch('/api/waitlist', {
      method: 'POST',
      body: JSON.stringify({ email, preferredPrice: pricePoint }),
    });
    setSubmitted(true);
  };

  return (
    <main className="min-h-screen bg-gradient-to-b from-gray-900 to-gray-800 text-white">
      <div className="max-w-2xl mx-auto pt-20 px-4">
        <h1 className="text-5xl font-bold mb-6">
          Turn long videos into viral shorts in 1 click
        </h1>
        <p className="text-xl text-gray-300 mb-8">
          AI-powered clip detection, auto-subtitles, and one-click export to TikTok, Reels, and Shorts.
        </p>
        
        {!submitted ? (
          <div className="space-y-6">
            <div className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@email.com"
                className="flex-1 px-4 py-3 rounded-lg bg-gray-700 text-white"
              />
              <button onClick={handleJoinWaitlist} className="px-6 py-3 bg-blue-600 rounded-lg font-semibold">
                Join Waitlist
              </button>
            </div>
            
            <div>
              <p className="text-sm text-gray-400 mb-3">What would you pay monthly?</p>
              <div className="flex gap-3">
                {['$9', '$19', '$29', '$49'].map((price) => (
                  <button
                    key={price}
                    onClick={() => setPricePoint(price)}
                    className={`px-4 py-2 rounded-lg border ${
                      pricePoint === price ? 'border-blue-500 bg-blue-500/20' : 'border-gray-600'
                    }`}
                  >
                    {price}/mo
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-green-400 text-xl">
            You're on the list! We'll reach out soon.
          </div>
        )}
      </div>
    </main>
  );
}
```

---

## Phase 2: Interactive Prototypes

After RAT validation, build interactive prototypes for usability testing. These are throwaway frontends with hardcoded data that simulate the real experience.

### Prototype Architecture

```
prototype/
├── app/
│   ├── page.tsx                 # Landing page
│   ├── upload/page.tsx          # Video upload flow
│   ├── clips/[videoId]/page.tsx # Clip viewer + editor
│   └── export/[clipId]/page.tsx # Export flow
├── data/
│   ├── mock-videos.ts           # Hardcoded video metadata
│   ├── mock-clips.ts            # Pre-generated clip data
│   └── mock-subtitles.ts        # Pre-generated subtitle data
├── components/
│   ├── VideoPlayer.tsx          # Custom video player
│   ├── ClipCard.tsx             # Clip preview card
│   ├── SubtitleEditor.tsx       # Inline subtitle editing
│   └── ExportDialog.tsx         # Platform selection
└── lib/
    └── mock-api.ts              # Fake API with delays
```

### Mock API with Realistic Latency

```typescript
// lib/mock-api.ts
const MOCK_LATENCY = {
  upload: 2000,
  generateClips: 8000,
  export: 3000,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function uploadVideo(file: File): Promise<MockVideo> {
  await delay(MOCK_LATENCY.upload);
  
  return {
    id: 'vid_mock_001',
    filename: file.name,
    duration: 2847, // 47 minutes
    thumbnailUrl: '/mock-thumbnail.jpg',
    status: 'processing',
  };
}

export async function generateClips(videoId: string): Promise<MockClip[]> {
  await delay(MOCK_LATENCY.generateClips);
  
  return [
    {
      id: 'clip_001',
      videoId,
      startTime: 342,
      endTime: 389,
      title: 'The surprising reason most startups fail',
      viralityScore: 9.2,
      thumbnailUrl: '/mock-clips/clip-001.jpg',
      subtitles: [
        { start: 342, end: 345, text: 'The number one reason' },
        { start: 345, end: 348, text: 'most startups fail' },
        { start: 348, end: 352, text: 'is not what you think' },
      ],
    },
    // ... 4 more mock clips
  ];
}

export async function exportClip(
  clipId: string,
  platform: string,
  options: ExportOptions
): Promise<{ downloadUrl: string }> {
  await delay(MOCK_LATENCY.export);
  
  return {
    downloadUrl: `/mock-exports/${clipId}-${platform}.mp4`,
  };
}
```

### Usability Testing Protocol

Test the interactive prototype with 5 users per segment:

```markdown
## Usability Test Script (30 minutes)

### Setup (2 min)
- Share Figma prototype link
- Explain: "We're testing the design, not you"
- Ask for think-aloud narration

### Tasks (20 min)

**Task 1: Upload a video**
- "You have a 1-hour podcast episode. Upload it to generate clips."
- Success: User completes upload flow
- Measure: Time to complete, errors encountered

**Task 2: Review and select clips**
- "The AI found 5 clips. Review them and pick your favorite."
- Success: User selects a clip and can articulate why
- Measure: Time to decision, confidence level (1-5)

**Task 3: Edit subtitles**
- "The auto-generated subtitles have a mistake. Fix it."
- Success: User edits subtitle text
- Measure: Time to find editor, time to make edit

**Task 4: Export to TikTok**
- "Export your selected clip for TikTok."
- Success: User completes export
- Measure: Time to complete, platform confusion

### Wrap-up (8 min)
- "What was confusing?"
- "What would you change?"
- "Would you use this? Why/why not?"
- SUS (System Usability Scale) questionnaire
```

### Production Prototype: Feature Flags

Once the interactive prototype is validated, build real features behind feature flags for gradual rollout:

```typescript
// lib/feature-flags.ts
import { GrowthBook } from '@growthbook/growthbook';

const growthbook = new GrowthBook({
  apiHost: 'https://cdn.growthbook.io',
  clientKey: process.env.GROWTHBOOK_CLIENT_KEY,
  enableDevMode: process.env.NODE_ENV === 'development',
});

// Define feature flags
export const FEATURES = {
  AI_CLIP_SELECTION: 'ai-clip-selection',
  AUTO_SUBTITLES: 'auto-subtitles',
  ONE_CLICK_EXPORT: 'one-click-export',
  BRAND_KIT: 'brand-kit',
  BATCH_PROCESSING: 'batch-processing',
} as const;

export function useFeature(feature: string): {
  enabled: boolean;
  value: any;
  loading: boolean;
} {
  const [state, setState] = useState({
    enabled: false,
    value: null,
    loading: true,
  });

  useEffect(() => {
    const featureValue = growthbook.getFeatureValue(feature, null);
    setState({
      enabled: featureValue !== null,
      value: featureValue,
      loading: false,
    });
  }, [feature]);

  return state;
}
```

```tsx
// Using feature flags in components
function VideoUploadPage() {
  const aiClipSelection = useFeature(FEATURES.AI_CLIP_SELECTION);
  const autoSubtitles = useFeature(FEATURES.AUTO_SUBTITLES);

  return (
    <div>
      <VideoUploader />
      
      {aiClipSelection.enabled && (
        <section>
          <h2>AI-Generated Clips</h2>
          <ClipGenerator mode={aiClipSelection.value.mode} />
        </section>
      )}
      
      {autoSubtitles.enabled && (
        <section>
          <h2>Auto Subtitles</h2>
          <SubtitleGenerator style={autoSubtitles.value.defaultStyle} />
        </section>
      )}
    </div>
  );
}
```

---

## Phase 3: Production Prototyping Patterns

Production code must be built for iteration speed. Use these patterns to keep the codebase prototype-friendly:

### Strangler Fig Pattern for Migration

When replacing prototype code with production implementations, use the strangler fig pattern:

```typescript
// services/clip-generation.ts

// Old prototype implementation
async function generateClipsPrototype(videoId: string): Promise<Clip[]> {
  const transcript = await getTranscript(videoId);
  const segments = segmentTranscript(transcript);
  const ratings = await rateWithOpenAI(segments);
  return ratings.filter(r => r.score >= 7).map(r => toClip(r));
}

// New production implementation
async function generateClipsProduction(videoId: string): Promise<Clip[]> {
  const video = await db.videos.findById(videoId);
  const transcript = await transcriptionService.transcribe(video.storageKey);
  const embeddings = await embeddingService.embed(transcript);
  const highlights = await highlightDetector.detect(embeddings, {
    model: 'minio-highlight-v2',
    threshold: 0.75,
  });
  
  return Promise.all(highlights.map(h => clipRenderer.render(video, h)));
}

// Feature flag controls which implementation runs
export async function generateClips(videoId: string): Promise<Clip[]> {
  const flag = await featureFlags.get('clip-generation-version');
  
  if (flag === 'production') {
    return generateClipsProduction(videoId);
  }
  
  return generateClipsPrototype(videoId);
}
```

### Contract Testing Between Prototype and Production

Ensure the production implementation matches the prototype's behavior:

```typescript
// tests/clip-generation.contract.test.ts
import { generateClipsPrototype } from '../services/clip-generation.prototype';
import { generateClipsProduction } from '../services/clip-generation.production';

const TEST_VIDEOS = [
  { id: 'test_podcast_001', expectedClipCount: 5, minAvgScore: 7 },
  { id: 'test_tutorial_001', expectedClipCount: 3, minAvgScore: 6 },
  { id: 'test_interview_001', expectedClipCount: 4, minAvgScore: 7 },
];

describe('Clip generation contract', () => {
  for (const testCase of TEST_VIDEOS) {
    it(`produces similar results for ${testCase.id}`, async () => {
      const prototypeResult = await generateClipsPrototype(testCase.id);
      const productionResult = await generateClipsProduction(testCase.id);
      
      // Production should find at least as many clips
      expect(productionResult.length).toBeGreaterThanOrEqual(
        Math.floor(prototypeResult.length * 0.8)
      );
      
      // Top clips should overlap by >60%
      const prototypeTop3 = new Set(prototypeResult.slice(0, 3).map(c => c.segmentId));
      const productionTop3 = new Set(productionResult.slice(0, 3).map(c => c.segmentId));
      const overlap = [...prototypeTop3].filter(id => productionTop3.has(id)).length;
      
      expect(overlap / 3).toBeGreaterThanOrEqual(0.6);
    });
  }
});
```

---

## Prototyping Timeline

### Free Tier (4-week sprint)

| Week | Activity | Output |
|------|----------|--------|
| 1 | RAT: AI clip selection + subtitle rendering | Validated/invalidated assumptions |
| 2 | Interactive prototype in Next.js | Clickable prototype for user testing |
| 3 | Usability testing (5 users) + iteration | Refined UX with known issues documented |
| 4 | Build MVP behind feature flags | Deployed free tier with limited features |

### Production (12-week cycle)

| Weeks | Activity | Output |
|-------|----------|--------|
| 1-2 | RAT for new features (batch, brand kit) | Validated assumptions |
| 3-5 | Interactive prototypes for each feature | Testable prototypes |
| 6-7 | Usability testing (15 users across segments) | Feature specifications |
| 8-10 | Production implementation behind flags | Shippable code |
| 11-12 | Gradual rollout (5% → 25% → 100%) | Fully launched features |

---

## Prototype-to-Production Checklist

Before converting any prototype to production code:

```markdown
## Pre-Production Checklist

### Code Quality
- [ ] Remove all hardcoded test data
- [ ] Replace mock API calls with real service calls
- [ ] Add error handling for all failure modes
- [ ] Add logging and observability
- [ ] Write unit tests for core logic
- [ ] Write integration tests for API boundaries

### Performance
- [ ] Load test with expected concurrent users
- [ ] Profile memory usage under load
- [ ] Verify database query performance
- [ ] Test with real video files (not just test clips)
- [ ] Validate CDN caching behavior

### Security
- [ ] Input validation on all user inputs
- [ ] Authentication on all endpoints
- [ ] Rate limiting on expensive operations
- [ ] File type validation on uploads
- [ ] SQL injection / XSS prevention

### Operational
- [ ] Feature flag configured for gradual rollout
- [ ] Monitoring dashboards created
- [ ] Alert thresholds defined
- [ ] Rollback procedure documented
- [ ] Runbook for common failure modes
```

---

## Conclusion

Prototyping is not a phase—it's a continuous practice. Every feature starts as a riskiest assumption test, graduates to an interactive prototype for user validation, then gets built behind feature flags for gradual rollout. The free tier moves fast (4-week cycles); production moves carefully (12-week cycles with contract testing). The key discipline is: never skip the RAT. If the assumption fails, the prototype saved you months of wasted engineering.
