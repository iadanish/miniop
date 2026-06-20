# Vision & Mission — MiniOp

## What MiniOp Is

MiniOp is an open-source video repurposing platform that automatically identifies the most engaging moments in long-form video and generates short-form clips optimized for social media. It is a self-hostable alternative to Opus Clip, giving content creators, media companies, and marketing teams full control over their data, infrastructure, and costs.

## Vision

Every piece of long-form video contains dozens of short-form clips waiting to be discovered. The manual process of finding, trimming, captioning, and formatting these clips takes hours per video. MiniOp automates this entirely using AI-powered scene detection, speech analysis, and virality scoring — while keeping the user in creative control.

MiniOp envisions a world where:

1. **Repurposing is free**: A solo creator with a $5/month VPS gets the same AI clipping that enterprise teams pay thousands for
2. **Your data is yours**: Videos never leave your infrastructure unless you choose to use a cloud provider
3. **Quality is the default**: Generated clips include proper captions, intelligent cropping, and platform-specific formatting out of the box
4. **Extensibility is first-class**: Developers can plug in custom scoring models, caption styles, and export targets

## Mission

Build the best open-source video clipping engine that runs anywhere — from a Raspberry Pi to a GPU cluster — and make it so good that even companies who could afford the proprietary alternative choose MiniOp for its flexibility and transparency.

## Core Principles

### 1. Self-Hostable by Default

Every feature works in a single `docker compose up` command. No external API keys required for basic functionality. Whisper (transcription) and FFmpeg (processing) are bundled. Cloud features (S3 storage, GPU workers) are opt-in enhancements, not requirements.

```bash
# Minimum viable deployment
git clone https://github.com/miniop/miniop.git
cd miniop
cp .env.example .env
docker compose up -d
# → Open http://localhost:3000
```

### 2. Open Core, Not Open Trap

The core clipping engine is Apache 2.0 licensed. This includes:

- Video upload and storage
- Transcription via Whisper
- Scene detection and highlight scoring
- Clip generation with FFmpeg
- Caption burning
- Basic API and web UI

Premium features (team collaboration, advanced analytics, priority GPU scheduling) are available under a commercial license for organizations that need them. The core product is fully functional without the premium layer.

### 3. Performance Over Cleverness

Video processing is CPU and GPU intensive. MiniOp optimizes for throughput, not algorithmic elegance:

- Parallel FFmpeg jobs with configurable concurrency
- GPU-accelerated transcription when CUDA is available
- Streaming processing — start generating clips before transcription finishes
- Chunked upload with resume support for large files

### 4. API-First

Every feature is available via the REST API before it appears in the UI. The web UI is a thin client on top of the API. This means:

- Automation scripts can drive the entire pipeline
- Third-party integrations are first-class
- The mobile app (planned) uses the same API as the web UI

## Target Users

### Solo Creators (Free Tier)

A YouTuber recording 2-hour podcast episodes wants to extract 5-10 clips for TikTok and Instagram Reels. They run MiniOp on a $5/month VPS, upload their episode, and get formatted clips with captions in minutes.

**Pain point**: Spending 3-4 hours manually editing clips after every episode recording session.

**MiniOp solution**: Upload the episode, select "AI Highlight" strategy, download the generated clips. Total time: 5 minutes of setup, 15 minutes of processing.

### Small Production Teams (Pro Tier)

A marketing team at a 50-person startup produces 4-5 videos per week across product demos, webinars, and thought leadership content. They need consistent branding on captions, multiple aspect ratio exports, and a shared project workspace.

**Pain point**: Inconsistent clip quality across team members, no centralized asset management, expensive per-seat SaaS pricing.

**MiniOp solution**: Deploy on a dedicated GPU instance. Team members share projects, apply org-wide caption templates, and get automated clip generation via API integrations with their CMS.

### Media Companies (Enterprise Tier)

A news organization processes hundreds of hours of footage daily. They need high-throughput processing, custom AI models for topic detection, compliance logging, and integration with their broadcast systems.

**Pain point**: Proprietary tools don't integrate with existing MAM (Media Asset Management) systems, per-minute pricing is prohibitive at scale.

**MiniOp solution**: Self-hosted deployment on their GPU cluster. Custom scoring models via the plugin API. S3-compatible storage on their existing MinIO infrastructure. Full audit logging for compliance.

## Success Metrics

| Metric | Year 1 Target | How We Measure |
|--------|---------------|----------------|
| GitHub stars | 10,000 | GitHub analytics |
| Self-hosted deployments | 5,000 | Telemetry (opt-in) |
| Monthly active API users | 2,000 | API key activity |
| Clips generated (all instances) | 1M/month | Aggregated telemetry |
| Community contributors | 100 | GitHub contributors |
| Enterprise customers | 10 | Sales pipeline |

## Competitive Position

| Feature | Opus Clip | Descript | MiniOp |
|---------|-----------|----------|--------|
| Self-hosted | No | No | Yes |
| Open source | No | No | Yes (Apache 2.0) |
| API access | Limited | Yes | Full REST API |
| Custom AI models | No | No | Yes (plugin API) |
| Data sovereignty | No | No | Full control |
| Free tier | 60 min/month | 1 hr/month | Unlimited (self-hosted) |
| GPU acceleration | Yes | Yes | Yes (CUDA/ROCm) |
| Offline processing | No | Partial | Yes |

## What MiniOp Is NOT

- **Not a video editor**: MiniOp doesn't replace Premiere Pro or DaVinci Resolve. It automates the extraction and formatting of clips.
- **Not a social media manager**: MiniOp generates clips but doesn't post them. Integrations with Buffer, Hootsuite, etc. are community-built.
- **Not a video hosting platform**: MiniOp generates files. Hosting and CDN delivery are the user's responsibility (or handled by the cloud offering).

## Brand Voice

MiniOp's documentation and communication are:

- **Direct**: Say what the product does, not what it aspires to do
- **Technical**: Assume the reader is a developer or technically literate creator
- **Honest**: If a feature doesn't exist yet, say so. Link to the roadmap issue.
- **Inclusive**: Use plain language. Avoid jargon when simpler words work. Explain acronyms on first use.

## Licensing Strategy

| Component | License |
|-----------|---------|
| Core engine (transcription, clipping, captions) | Apache 2.0 |
| Web UI | Apache 2.0 |
| REST API server | Apache 2.0 |
| CLI tool | Apache 2.0 |
| Premium features (team, analytics, priority scheduling) | Commercial (BSL 1.1) |
| Official Helm charts | Apache 2.0 |
| Documentation | CC BY 4.0 |

The commercial license converts to Apache 2.0 after 3 years. This protects the business while ensuring the community eventually benefits from all features.

## Go-to-Market Strategy

**Phase 1 (Months 1-6)**: Open-source launch. Focus on developer community. Blog posts, Hacker News, Product Hunt. Target: 5,000 GitHub stars.

**Phase 2 (Months 7-12)**: Pro tier launch. Managed cloud offering with GPU acceleration. Target: 500 paying users.

**Phase 3 (Months 13-18)**: Enterprise tier. Custom deployments, SLA, dedicated support. Target: 10 enterprise contracts.

## Community Building

- **Discord server** for real-time support and feature discussion
- **GitHub Discussions** for long-form design conversations
- **Monthly community calls** demoing upcoming features
- **Good first issue** labels on GitHub for new contributors
- **Contributor recognition** in release notes and a contributors page
