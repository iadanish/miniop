# MiniOp User Research

## Overview

MiniOp is an AI-powered video repurposing platform that transforms long-form video content into short, viral-ready clips for social media distribution. This document outlines user research methodology, findings, and implementation strategies for both a free-tier MVP and scaled production deployment.

---

## Target User Segments

### Segment 1: Solo Content Creators (Free Tier Primary)

Solo creators repurposing podcast episodes, YouTube videos, or webinar recordings into TikTok/Reels/Shorts content. They process 1-5 videos per week, have zero budget for editing tools, and need a simple drag-and-drop workflow. They don't care about API access, team features, or advanced analytics—they want fast, good-enough clips.

### Segment 2: Marketing Teams (Paid Tier Primary)

Mid-size marketing teams (5-20 people) managing multiple brand channels. They process 50-200 videos per month, need brand kit integration (watermarks, colors, fonts), require team collaboration with role-based access, and demand analytics on clip performance across platforms.

### Segment 3: Media Agencies (Enterprise Tier)

Agencies managing 10+ client accounts with white-label requirements. They need bulk processing, custom AI model fine-tuning for specific content verticals, SLA guarantees, and compliance features (SOC 2, GDPR).

---

## Research Methodology

### Free Tier: Lean Research Approach

For the initial MVP, use lightweight, high-velocity research methods:

**User Interviews (n=15-20)**

Conduct 30-minute video calls with creators found via Twitter, Reddit r/NewTubers, and creator Discord servers. Recruit by posting in these communities:

```
# Recruitment post template
Subject: Quick chat about video repurposing? (30 min, $25 gift card)

Hey! I'm building a tool that auto-clips long videos into shorts.
Looking for creators who repurpose content across platforms.

What I need: 30 min of your time on a quick call
What you get: $25 Amazon gift card + early access

DM me if interested!
```

Interview script covering core pain points:
1. Walk me through how you currently turn a long video into shorts
2. What's the most frustrating part of that process?
3. How do you decide which moments to clip?
4. What tools do you use today? What do you pay?
5. If you could wave a magic wand, what would the ideal workflow look like?

**Analytics Instrumentation**

Embed event tracking from day one to understand actual usage patterns:

```javascript
// Track key user actions in the free tier
import { analytics } from './lib/analytics';

// Video upload events
analytics.track('video_uploaded', {
  source: 'file_upload' | 'url_import',
  duration_seconds: video.duration,
  file_size_mb: video.size / (1024 * 1024),
  format: video.format,
});

// Clip generation events
analytics.track('clips_generated', {
  video_id: video.id,
  clip_count: clips.length,
  generation_time_ms: elapsedTime,
  ai_model_used: 'gpt-4o' | 'local-whisper',
});

// Clip export events
analytics.track('clip_exported', {
  clip_id: clip.id,
  platform: 'tiktok' | 'instagram_reels' | 'youtube_shorts' | 'twitter',
  aspect_ratio: '9:16' | '1:1' | '16:9',
  has_subtitles: boolean,
  has_watermark: boolean,
});
```

**Behavioral Cohort Analysis**

After 30 days, segment users by engagement:
- **Activated**: Generated ≥3 clips from ≥2 videos
- **Retained**: Returned after 7 days
- **Converted**: Upgraded to paid tier

```sql
-- Identify activated users
SELECT
  user_id,
  COUNT(DISTINCT video_id) as videos_processed,
  COUNT(*) as total_clips_generated,
  MIN(created_at) as first_clip,
  MAX(created_at) as last_clip,
  DATEDIFF(day, MIN(created_at), MAX(created_at)) as active_span_days
FROM clip_events
WHERE event_type = 'clip_exported'
GROUP BY user_id
HAVING COUNT(DISTINCT video_id) >= 2
  AND COUNT(*) >= 3;
```

### Scaled Production: Comprehensive Research Program

At scale (10,000+ users), layer in structured research:

**Continuous Discovery Habits**

Run weekly 30-minute interviews with a rotating panel of 5 users from each segment. Use Teresa Torres' opportunity solution tree framework:

```
Desired Outcome: Creators repurpose content faster
├── Opportunity: Too hard to find the best moments
│   ├── Solution: AI-powered highlight detection
│   └── Solution: Engagement prediction scoring
├── Opportunity: Subtitle formatting takes too long
│   ├── Solution: Auto-style subtitles with brand kits
│   └── Solution: Template-based subtitle presets
└── Opportunity: Can't preview clips before export
    ├── Solution: Real-time preview renderer
    └── Solution: Side-by-side comparison view
```

**NPS and Satisfaction Surveys**

Deploy in-app surveys using a service like Sprig or Hotjar:

```javascript
// Trigger survey after 5th clip export
function triggerSurvey(user) {
  if (user.clip_export_count === 5 && !user.survey_completed) {
    Sprig.init({
      studyId: process.env.SPRIG_STUDY_ID,
      userId: user.id,
      attributes: {
        plan: user.plan,
        days_since_signup: daysSince(user.created_at),
        videos_processed: user.video_count,
      },
    });
  }
}
```

**Support Ticket Analysis**

Categorize support tickets monthly to identify systemic issues:

```python
# Categorize support tickets with LLM
import openai

def categorize_ticket(ticket_body: str) -> dict:
    response = openai.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": """Categorize this support ticket into:
            - bug: something is broken
            - feature_request: user wants new functionality
            - ux_confusion: user can't figure out how to do something
            - billing: payment or subscription issue
            - performance: speed or reliability concern
            
            Also extract: severity (low/medium/high), affected_feature"""},
            {"role": "user", "content": ticket_body}
        ],
        response_format={"type": "json_object"}
    )
    return json.loads(response.choices[0].message.content)
```

---

## Key Research Findings (Hypothesized)

Based on competitive analysis of Opus Clip, Descript, and Opus.pro:

1. **Clip selection is the bottleneck.** Creators spend 60-70% of their time scrubbing through video to find clip-worthy moments. AI highlight detection is the #1 value driver.

2. **Subtitles drive engagement.** 80% of social video is watched on mute. Auto-subtitles with styling are table stakes, not a differentiator.

3. **Export friction kills workflows.** Users want one-click export to specific platforms with correct aspect ratios, not generic file downloads.

4. **Free tier must be generous.** Competitors offer 60-90 minutes of free processing monthly. Below this, users don't bother signing up.

5. **Speed matters more than quality.** Users prefer "good enough" clips in 30 seconds over "perfect" clips in 5 minutes.

---

## Implementing Research Insights

### Free Tier Implementation Priorities

Based on findings, prioritize these features in order:

1. **AI Clip Detection** - Use GPT-4o with timestamps to identify viral-potential moments
2. **Auto-Subtitles** - Whisper transcription + styled overlay rendering
3. **One-Click Export** - Platform-specific presets (TikTok 9:16, Instagram 1:1)
4. **Generous Free Limit** - 90 minutes/month free processing

### Production-Scale Research Infrastructure

At scale, invest in a research operations stack:

```yaml
# Research ops infrastructure
services:
  interviews:
    tool: "Cal.com"  # Self-hosted scheduling
    cadence: "5 users/week"
    incentive: "$50 gift card per interview"
  
  surveys:
    tool: "Sprig"  # In-app micro-surveys
    trigger: "post-export, post-signup-day-7"
    sample_rate: 0.1  # 10% of users see surveys
  
  analytics:
    tool: "PostHog"  # Self-hosted product analytics
    events: "defined in analytics schema above"
    dashboards: ["activation_funnel", "feature_adoption", "retention"]
  
  support_analysis:
    tool: "Linear + custom LLM categorization"
    cadence: "weekly ticket review"
    output: "monthly_insights_report.md"
```

---

## Conclusion

User research for MiniOp should start lean (interviews + analytics) and scale into a structured program (continuous discovery + surveys + support analysis). Every finding must map to an implementable feature with clear success metrics. The free tier validates demand; the paid tier validates willingness to pay.
