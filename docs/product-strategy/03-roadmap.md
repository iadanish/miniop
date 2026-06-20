# Roadmap — MiniOp

## Roadmap Philosophy

MiniOp's roadmap is organized into quarterly themes. Each theme has a clear outcome — not a feature list. Features are selected and prioritized based on user feedback, technical dependencies, and market positioning. The roadmap is a living document updated monthly based on community input and business metrics.

## Current State (Q2 2026)

MiniOp has a working MVP with the following capabilities:

- Video upload (direct to S3-compatible storage)
- Transcription via Whisper (CPU-based)
- Basic highlight detection (speech energy + silence gap analysis)
- Clip generation via FFmpeg (single aspect ratio)
- Simple caption overlay (white text, bottom-center)
- REST API for clip creation and job management
- Docker Compose deployment

**What's working**: Transcription accuracy is 95%+ for English. Clip generation produces clean cuts. API is stable.

**What's not working**: Processing is slow (1 hour video takes 30 minutes on CPU). Highlight detection is basic — misses visual cues. Only 16:9 output. No web UI yet.

## Q3 2026 — Speed and Quality

**Theme**: Make processing fast enough that users don't think about it.

**Outcomes**:
- 1-hour video processes in under 5 minutes with GPU
- Highlight detection catches 80%+ of viral-worthy moments
- Output supports all major aspect ratios (9:16, 16:9, 1:1, 4:5)

### Features

**GPU-accelerated Whisper** (Priority: Critical)
- Integrate faster-whisper with CUDA support
- Fallback to CPU when no GPU is available
- Benchmark: 1-hour video transcription in 90 seconds (GPU) vs 12 minutes (CPU)

```yaml
# docker-compose.gpu.yml
services:
  worker:
    image: minio/server:latest-gpu
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    environment:
      WHISPER_DEVICE: cuda
      WHISPER_MODEL: large-v3
```

**Scene-based highlight detection** (Priority: Critical)
- Replace basic speech-energy scoring with multi-signal analysis:
  - Speech transcription (keywords, sentiment)
  - Audio energy (laughter, applause, excitement markers)
  - Visual scene changes (cut detection)
  - Speaker change detection
- Each signal contributes to a composite virality score

```python
# scoring/signals.py (Whisper/Python worker for ML)
def compute_virality_score(segment, signals):
    weights = {
        'speech_energy': 0.25,
        'sentiment_peak': 0.20,
        'scene_change': 0.15,
        'speaker_change': 0.15,
        'keyword_density': 0.15,
        'laughter_detected': 0.10,
    }
    score = sum(signals[k] * weights[k] for k in weights)
    return min(score, 1.0)
```

**Multi-aspect-ratio output** (Priority: High)
- Generate clips in 9:16, 16:9, 1:1, and 4:5
- Intelligent cropping using speaker face detection (center on speaker)
- Letterbox/pillarbox options for non-native ratios

```go
// transcoder/aspect.go
var AspectRatios = map[string]AspectConfig{
    "9:16":  {Width: 1080, Height: 1920, CropStrategy: "face-center"},
    "16:9":  {Width: 1920, Height: 1080, CropStrategy: "center"},
    "1:1":   {Width: 1080, Height: 1080, CropStrategy: "face-center"},
    "4:5":   {Width: 1080, Height: 1350, CropStrategy: "face-center"},
}
```

**Caption styling** (Priority: High)
- Template-based caption system with 5 preset styles (bold-outline, minimal, karaoke, news-ticker, meme-style)
- Custom font and color support via API parameters
- Word-by-word highlighting synchronized with transcription timestamps

```json
{
  "caption_style": {
    "preset": "bold-outline",
    "font": "Montserrat-Bold",
    "font_size": 48,
    "primary_color": "#FFFFFF",
    "outline_color": "#000000",
    "outline_width": 3,
    "position": "bottom-center",
    "word_highlight": true,
    "highlight_color": "#FFD700"
  }
}
```

### Infrastructure

- Kubernetes Helm chart for production deployment
- Prometheus + Grafana monitoring stack
- CI/CD pipeline for automated testing and deployment

## Q4 2026 — Platform

**Theme**: Turn the clipping engine into a platform that others build on.

**Outcomes**:
- Web UI for non-technical users
- Plugin system for custom processing
- Team collaboration features

### Features

**Web UI** (Priority: Critical)
- Next.js frontend with video player, clip preview, and project management
- Drag-and-drop video upload
- Visual timeline editor for adjusting clip boundaries
- Batch processing (queue multiple videos)
- Real-time progress updates via WebSocket

**Plugin System** (Priority: High)
- Custom scoring models: Users can provide their own ML models for highlight detection
- Custom exporters: Plugin for direct publishing to YouTube Shorts, TikTok, Instagram
- Plugin manifest format:

```yaml
# plugins/custom-scorer/plugin.yaml
name: news-scorer
version: 1.0.0
description: Highlight scoring optimized for news content
author: news-org
type: scorer
entrypoint: scorer.py
requirements:
  - transformers>=4.30
  - torch>=2.0
config:
  model_path: ./models/news-bert
  threshold: 0.7
```

**Team Workspaces** (Priority: Medium)
- Organization accounts with role-based access (admin, editor, viewer)
- Shared projects and clip libraries
- Comment and approval workflow on clips
- Activity log for audit purposes

**API Keys Management** (Priority: High)
- Per-user API keys with configurable scopes
- Key rotation without downtime
- Usage tracking per key

## Q1 2027 — Scale

**Theme**: Handle enterprise workloads and global distribution.

**Outcomes**:
- Process 100+ hours of video per day
- Sub-minute processing for short clips
- Multi-region deployment support

### Features

**Distributed Processing** (Priority: Critical)
- Job queue with worker auto-scaling (scale GPU workers based on queue depth)
- Support for processing across multiple GPU nodes
- Chunked processing: split long videos into segments, process in parallel, reassemble

```yaml
# k8s/worker-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: minio-worker
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: minio-worker
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: External
      external:
        metric:
          name: redis_queue_depth
          selector:
            matchLabels:
              queue: minio:jobs
        target:
          type: AverageValue
          averageValue: "5"
```

**Multi-region CDN** (Priority: High)
- Clip URLs served from nearest edge location
- Upload acceleration via multipart upload with regional endpoints
- Cache invalidation API for updated clips

**Batch Processing API** (Priority: Medium)
- Submit up to 100 videos in a single batch request
- Progress tracking for entire batch
- Priority lanes for enterprise customers

```json
POST /v1/batches
{
  "sources": [
    {"url": "https://...", "options": {"max_clips": 5}},
    {"url": "https://...", "options": {"max_clips": 3}}
  ],
  "priority": "high",
  "webhook_url": "https://..."
}
```

**Custom Model Hosting** (Priority: Medium)
- Enterprise customers can deploy custom Whisper fine-tuned models
- Model versioning and A/B testing
- Automatic fallback to base model if custom model fails

## Q2 2027 — Intelligence

**Theme**: Make the AI smarter, not just faster.

**Outcomes**:
- Clip quality matches or exceeds human editor selections
- Automated caption translation to 20+ languages
- Content-aware aspect ratio selection

### Features

**Advanced Virality Prediction** (Priority: Critical)
- Train a custom model on 100K+ viral clips from YouTube Shorts, TikTok, Reels
- Predict not just "is this engaging" but "why this is engaging" (hook, emotion, surprise, controversy)
- Provide creators with specific suggestions: "Move the hook 3 seconds earlier" or "This segment needs more context"

**Auto-translation** (Priority: High)
- Generate captions in 20+ languages from the original transcription
- Preserve timing and word-level synchronization
- Support for right-to-left languages (Arabic, Hebrew)

**Content-aware cropping** (Priority: Medium)
- Use object detection to keep important visual elements in frame
- Face tracking for speaker-centric crops
- Text/slide detection for presentation recordings (keep slides readable)

**A/B Testing** (Priority: Low)
- Generate multiple clip variants from the same source
- Track performance metrics when connected to social platforms
- Recommend the best-performing variant

## Release Cadence

| Release Type | Cadence | Example |
|-------------|---------|---------|
| Patch (bug fixes) | Weekly | v1.2.1 → v1.2.2 |
| Minor (features) | Monthly | v1.2 → v1.3 |
| Major (breaking) | Quarterly | v1.x → v2.0 |

## Community Input

The roadmap is influenced by:

1. **GitHub Issues**: Feature requests with the most 👍 reactions are prioritized
2. **Discord feedback**: Direct user conversations in #feature-requests channel
3. **Enterprise requests**: Paying customers get a private feedback channel
4. **Internal metrics**: Usage data (with consent) shows which features are most used

## What's NOT on the Roadmap

- **Social media posting**: We don't want to become a social media management tool. Integration via API is the path.
- **Live streaming clipping**: Real-time processing is a different architecture. Planned for 2028.
- **Mobile app**: The web UI will be responsive. A native mobile app is not planned.
- **Video editing**: We will never replace Premiere Pro. Clip boundary adjustment is the extent of our editing features.
