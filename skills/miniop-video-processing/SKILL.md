# MiniOp Video Processing

Complete video processing pipeline for MiniOp - handles video downloading, processing, and export.

## When to use

Use this skill when processing videos for MiniOp - downloading from URLs, applying effects, generating clips, and exporting final videos.

## Capabilities

- Download videos from YouTube, Vimeo, TikTok URLs
- Process videos with FFmpeg
- Apply aspect ratio conversions (9:16, 1:1, 16:9, 4:5)
- Apply layout modes (Fill, Fit, Three, Four, Split, ScreenShare, Gameplay)
- Generate clips based on AI analysis
- Export in multiple formats (MP4, WebM)

## Free Tier Services

- Google Colab (15 hrs/week) for GPU processing
- Kaggle (30 hrs/week) as fallback
- Cloudflare R2 (10GB) for storage
- Backblaze B2 as storage fallback

## Video Processing Pipeline

1. **Download**: yt-dlp for URL-based downloads
2. **Analyze**: FFmpeg for video metadata extraction
3. **Process**: Apply effects, transitions, captions
4. **Export**: Generate final output in requested format

## Integration with Other Skills

- Uses miniop-ai-clipping for clip selection
- Uses miniop-captions for caption overlay
- Uses miniop-brand for branding elements
- Uses miniop-social for platform-specific optimization

## Commands

```bash
# Install dependencies
npm install yt-dlp ffmpeg fluent-ffmpeg

# Process video
node skills/miniop-video-processing/process-video.js --input video.mp4 --output clip.mp4 --format 9:16
```
