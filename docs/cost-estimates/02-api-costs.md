# API Costs

This document covers the API costs for MiniOp's processing pipeline — the external and self-hosted AI services that power clip generation. API costs are the primary variable expense and scale linearly with clip volume.

---

## Pipeline Overview

MiniOp processes each video through these API-dependent stages:

1. **Audio Extraction** — FFmpeg (local, free)
2. **Transcription** — OpenAI Whisper (self-hosted on GPU)
3. **Scene Detection** — PySceneDetect (local, free)
4. **Virality Scoring** — CLIP + custom model (self-hosted on GPU)
5. **Caption Generation** — WhisperX alignment (self-hosted)
6. **Thumbnail Generation** — Frame extraction + overlay (local, free)

The key insight: **MiniOp self-hostes all AI inference on free/paid GPU runtimes**. There are no per-API-call costs for the core pipeline. API costs come from optional enhancements and supporting services.

---

## Free Tier (200–500 clips/month)

### Core Pipeline: $0 (Self-Hosted)

All heavy inference runs on Google Colab / Kaggle GPUs:

| Stage | Model | GPU Memory | Inference Time (T4) |
|-------|-------|------------|---------------------|
| Transcription | Whisper-base | ~1 GB | ~30 sec/10 min video |
| Alignment | WhisperX | ~2 GB | ~15 sec/10 min video |
| Scene Detection | PySceneDetect (content) | CPU only | ~10 sec/10 min video |
| Virality Scoring | CLIP ViT-B/32 | ~2 GB | ~5 sec/10 min video |
| Caption Rendering | FFmpeg + PIL | CPU only | ~5 sec/clip |

**Total per-clip GPU time: ~6 minutes on T4**

No external APIs are called. The models are downloaded once to the Colab environment and cached. This is MiniOp's core cost advantage over SaaS competitors like Opus Clip ($19–$49/month).

### Optional Enhancement APIs

These APIs add features but are not required for core functionality:

#### OpenAI Whisper API (Cloud Alternative)

If self-hosting is impractical, the OpenAI Whisper API is a fallback:

| Metric | Rate | 500 Clips Cost |
|--------|------|----------------|
| Transcription | $0.006/min | 500 clips × 10 min avg = $30.00 |

**Recommendation: Avoid at scale.** Self-hosting Whisper on Colab saves $30/month at just 500 clips. At 3,000 clips, the API would cost $180/month vs. $0 self-hosted.

#### Deepgram Nova-2 (Alternative Transcription)

Deepgram offers faster transcription with better diarization:

| Plan | Rate | 500 Clips Cost |
|------|------|----------------|
| Pay-as-you-go | $0.0043/min | 500 × 10 min × $0.0043 = $21.50 |
| Growth ($49/mo) | 200K min included | $49.00 (overkill for 500 clips) |

**Recommendation: Not needed.** Whisper-base handles English transcription well. Deepgram only matters for multilingual content or speaker diarization.

#### OpenAI GPT-4o-mini (Clip Title/Description Generation)

Optional: generate engaging titles and descriptions for clips.

| Metric | Rate | 500 Clips Cost |
|--------|------|----------------|
| Input tokens | $0.15/1M | ~200 tokens/clip = $0.015 |
| Output tokens | $0.60/1M | ~100 tokens/clip = $0.03 |
| **Total** | | 500 × $0.045 = **$22.50** |

**Recommendation: Optional.** Add this as a premium feature. At 500 clips, the cost is negligible. Use GPT-4o-mini (not GPT-4o) to keep costs under $0.05/clip.

#### Replicate API (Model Hosting Alternative)

Replicate hosts pre-built models with per-second billing:

| Model | Rate | 500 Clips Cost |
|-------|------|----------------|
| Whisper large-v3 | $0.0002/sec | 500 × 30 sec = $3.00 |
| CLIP scoring | $0.0001/sec | 500 × 5 sec = $0.25 |

**Recommendation: Backup only.** Use Replicate when Colab/Kaggle are both throttled. Total cost for 500 clips: ~$3.25.

### Supporting Service APIs

#### Resend (Transactional Email)

| Plan | Allowance | Cost |
|------|-----------|------|
| Free | 3,000 emails/month | $0.00 |
| Pro | 50,000 emails/month | $20.00 |

At 500 clips/month with email notifications (clip ready, export complete), you'll send ~1,500 emails. Free tier covers this.

#### Upstash Redis (Rate Limiting + Queue)

| Plan | Allowance | Cost |
|------|-----------|------|
| Free | 10,000 commands/day | $0.00 |
| Pay-as-you-go | $0.2/100K commands | ~$1.00/month at scale |

The free tier handles job queuing for 500 clips/month. Each clip generates ~20 Redis commands (enqueue, status updates, completion).

### Free Tier API Cost Summary

| API | Required? | Monthly Cost |
|-----|-----------|-------------|
| Whisper (self-hosted) | Yes | $0.00 |
| CLIP (self-hosted) | Yes | $0.00 |
| PySceneDetect | Yes | $0.00 |
| GPT-4o-mini (titles) | Optional | $0.00–$22.50 |
| Replicate (backup) | Optional | $0.00–$3.25 |
| Resend (email) | Yes | $0.00 |
| Upstash Redis | Yes | $0.00 |
| **Total (required only)** | | **$0.00** |
| **Total (with options)** | | **$0.00–$25.75** |

---

## Scaled Production (3,000+ clips/month)

At scale, self-hosting remains the primary strategy, but some APIs become cost-effective.

### Core Pipeline: Self-Hosted on RunPod

| Stage | Model | Inference Time (A10G) | Cost at $0.08/hr |
|-------|-------|----------------------|------------------|
| Transcription | Whisper-medium | ~20 sec/10 min video | $0.0004 |
| Alignment | WhisperX | ~10 sec/10 min video | $0.0002 |
| Scene Detection | PySceneDetect | CPU, ~8 sec | $0.0001 |
| Virality Scoring | CLIP ViT-L/14 | ~4 sec/10 min video | $0.0001 |
| Caption Rendering | FFmpeg + PIL | CPU, ~4 sec | $0.0001 |
| **Total per clip** | | ~46 sec GPU + ~12 sec CPU | **$0.001** |

**3,000 clips × $0.001 = $3.00/month for core inference**

This is dramatically cheaper than any API-based approach. The RunPod serverless model charges only for active GPU time — no idle costs.

### API Comparison at 3,000 Clips/Month

| Approach | Monthly Cost | Cost/Clip |
|----------|-------------|-----------|
| Self-hosted (RunPod) | $3.00 | $0.001 |
| OpenAI Whisper API | $180.00 | $0.060 |
| Deepgram Growth | $49.00 | $0.016 |
| Replicate Whisper | $18.00 | $0.006 |
| AssemblyAI | $165.00 | $0.055 |

**Self-hosting is 60x cheaper than OpenAI's API and 16x cheaper than Deepgram.**

### Enhanced APIs at Scale

#### GPT-4o-mini (Titles + Descriptions + Social Captions)

At scale, this becomes a genuine value-add:

| Metric | Rate | 3,000 Clips Cost |
|--------|------|------------------|
| Input tokens | $0.15/1M | 3,000 × 300 tokens = $0.135 |
| Output tokens | $0.60/1M | 3,000 × 200 tokens = $0.36 |
| **Total** | | **$0.50** |

Cost per clip: $0.0002. This is effectively free at scale. Strongly recommend enabling this.

#### ElevenLabs / PlayHT (Text-to-Speech for Descriptions)

Optional: generate audio descriptions or voiceovers.

| Service | Rate | 3,000 Clips Cost |
|---------|------|------------------|
| ElevenLabs Starter | $5/month for 30K chars | ~$5.00 |
| PlayHT Creator | $31/month for 100K chars | ~$31.00 |

**Recommendation: Skip.** MiniOp's core value is clip extraction, not generation. TTS adds complexity without proportional value.

#### Anthropic Claude (Advanced Summarization)

For complex content summarization beyond GPT-4o-mini:

| Model | Rate | 3,000 Clips Cost |
|-------|------|------------------|
| Claude Haiku | $0.25/1M input, $1.25/1M output | ~$1.50 |
| Claude Sonnet | $3/1M input, $15/1M output | ~$15.00 |

**Recommendation: Use Haiku if needed.** Only worth it for long-form content (1+ hour videos) where GPT-4o-mini misses context.

### Supporting Services at Scale

#### Resend (Email)

| Plan | Cost | Notes |
|------|------|-------|
| Pro | $20/month | 50K emails, enough for 3,000 clips + user notifications |

#### Upstash Redis

| Plan | Cost | Notes |
|------|------|-------|
| Pay-as-you-go | $2–5/month | ~60K commands/month |

#### QStash (Async Job Scheduling)

| Plan | Cost | Notes |
|------|------|-------|
| Free | 0 | 500 msgs/day sufficient |
| Pro | $10/month | 10K msgs/day for burst processing |

### Scaled API Cost Summary

| API | Required? | Monthly Cost |
|-----|-----------|-------------|
| Whisper (RunPod self-hosted) | Yes | $3.00 |
| CLIP (RunPod self-hosted) | Yes | Included |
| GPT-4o-mini (titles) | Recommended | $0.50 |
| Resend (email) | Yes | $20.00 |
| Upstash Redis | Yes | $3.00 |
| QStash (job scheduling) | Optional | $0.00–$10.00 |
| **Total (required)** | | **$26.00** |
| **Total (with options)** | | **$26.50–$36.50** |

---

## Cost Reduction Strategies

### Transcription Optimization
- **Use Whisper-base for drafts** — 2x faster, acceptable accuracy for preview clips
- **Cache transcription results** — re-process from cached transcript instead of re-transcribing
- **Batch audio segments** — process multiple short clips in one GPU call

### Model Selection Trade-offs

| Model | Speed | Accuracy | VRAM | Best For |
|-------|-------|----------|------|----------|
| Whisper-base | Fast | Good | 1 GB | Drafts, previews |
| Whisper-medium | Medium | Better | 5 GB | Production |
| Whisper-large-v3 | Slow | Best | 10 GB | Final delivery |

Start with base, upgrade to medium for production. Large-v3 only if multilingual support is critical.

### API Call Reduction
- **Client-side preprocessing** — detect silence, trim dead air before sending to API
- **Incremental processing** — only reprocess changed segments
- **Webhook-based architecture** — avoid polling for job status

---

## Monitoring API Spend

Set up alerts per service:

| Service | Alert Threshold | Action |
|---------|----------------|--------|
| RunPod | $30/month | Switch to Colab backup |
| OpenAI API | $5/month | Self-host instead |
| Upstash | $5/month | Review command patterns |
| Resend | $20/month | Batch notifications |

The fundamental principle: **self-host inference, pay for orchestration APIs only**. This keeps MiniOp's API costs under $37/month even at 3,000+ clips — compared to $200–500/month for fully API-dependent architectures.
