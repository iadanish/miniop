# Video Processing Optimization

Video processing is the computational heart of MiniOp. Every user action — uploading, transcribing, detecting highlights, clipping, exporting — runs through FFmpeg or a Whisper model. This document details how to optimize each stage, from free-tier CPU-only processing to scaled GPU-accelerated pipelines.

---

## 1. The Processing Pipeline

```
Upload → Probe → Audio Extract → Transcribe → Highlight Detect → Clip Extract → Encode → Upload to CDN
         (ffprobe)  (ffmpeg)      (whisper)     (custom)        (ffmpeg)       (ffmpeg)
```

Each stage has different optimization levers. We address them in order of impact.

---

## 2. Video Probing: Know What You're Working With

Before any processing, probe the input to make smart decisions downstream:

```bash
ffprobe -v quiet -print_format json -show_format -show_streams input.mp4
```

Parse the output to extract key properties:

```python
import json
import subprocess

def probe_video(path: str) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json",
         "-show_format", "-show_streams", path],
        capture_output=True, text=True, check=True
    )
    data = json.loads(result.stdout)

    video_stream = next(s for s in data["streams"] if s["codec_type"] == "video")
    audio_stream = next(s for s in data["streams"] if s["codec_type"] == "audio")

    return {
        "duration": float(data["format"]["duration"]),
        "width": int(video_stream["width"]),
        "height": int(video_stream["height"]),
        "fps": eval(video_stream.get("r_frame_rate", "30/1")),
        "video_codec": video_stream["codec_name"],
        "audio_codec": audio_stream["codec_name"],
        "bitrate": int(data["format"].get("bit_rate", 0)),
        "has_audio": True,
    }
```

Use this to decide:
- If `video_codec` is already `h264` and resolution is 1080p or lower, you can copy the video stream during clip extraction (10x faster than re-encoding)
- If `duration` exceeds your plan limit, reject early
- If `fps` is above 60, consider downscaling to reduce processing time

---

## 3. Audio Extraction for Transcription

Whisper needs 16kHz mono WAV audio. Extract it efficiently:

```bash
ffmpeg -i input.mp4 \
  -vn \
  -acodec pcm_s16le \
  -ar 16000 \
  -ac 1 \
  -f wav \
  /tmp/audio.wav
```

**Key optimizations:**

- `-vn` skips video decoding entirely — critical for speed
- Output to a tmpfs/ramdisk mount if available (`/dev/shm/miniop/` on Linux) to avoid disk I/O
- For files longer than 30 minutes, split audio into 10-minute chunks with 30-second overlap to enable parallel transcription

### 3.1 Free Tier: Whisper CPU Optimization

On CPU, model selection matters enormously:

| Model | Size | Speed (10 min audio, 4-core CPU) | Accuracy (WER) |
|---|---|---|---|
| `tiny` | 39M | ~12s | ~12% |
| `base` | 74M | ~20s | ~8% |
| `small` | 244M | ~45s | ~5% |
| `medium` | 769M | ~150s | ~4% |

For free tier, use `base` — it's the best speed/accuracy tradeoff on CPU.

```python
import whisper

model = whisper.load_model("base")
result = model.transcribe(
    "/tmp/audio.wav",
    language="en",
    fp16=False,  # CPU doesn't support FP16 efficiently
    condition_on_previous_text=True,
    compression_ratio_threshold=2.4,
    no_speech_threshold=0.6,
)
```

Disable `fp16=False` on CPU — FP16 operations on CPU are actually slower than FP32 on most hardware because they require conversion overhead without GPU tensor cores.

### 3.2 Scaled: Whisper GPU with faster-whisper

Use `faster-whisper` with CTranslate2 for 4-8x speedup over vanilla Whisper on GPU:

```python
from faster_whisper import WhisperModel

model = WhisperModel("large-v3", device="cuda", compute_type="float16")

segments, info = model.transcribe(
    "/tmp/audio.wav",
    beam_size=5,
    language="en",
    vad_filter=True,
    vad_parameters=dict(
        min_silence_duration_ms=500,
        speech_pad_ms=200,
        threshold=0.35,
    ),
    word_timestamps=True,  # needed for precise clip boundaries
)

transcript = []
for segment in segments:
    transcript.append({
        "start": segment.start,
        "end": segment.end,
        "text": segment.text,
        "words": [{"word": w.word, "start": w.start, "end": w.end} for w in segment.words],
    })
```

**VAD filter** (`vad_filter=True`) is the single biggest speedup — it skips silence detection segments, reducing transcription time by 30-40% for typical video content with pauses.

**Word-level timestamps** (`word_timestamps=True`) enable precise clip boundary cutting instead of segment-level boundaries, improving clip quality.

---

## 4. Highlight Detection

After transcription, identify the most engaging segments. This is a lightweight CPU operation compared to video processing, but poor implementation adds unnecessary latency.

### 4.1 Scoring Algorithm

```python
from dataclasses import dataclass

@dataclass
class HighlightCandidate:
    start: float
    end: float
    score: float
    transcript: str

def detect_highlights(transcript: list[dict], target_clips: int = 5,
                      min_duration: float = 15, max_duration: float = 90) -> list[HighlightCandidate]:
    # Build a sliding window over transcript segments
    candidates = []
    segments = transcript

    for i in range(len(segments)):
        window_text = ""
        window_start = segments[i]["start"]

        for j in range(i, len(segments)):
            window_text += " " + segments[j]["text"]
            window_end = segments[j]["end"]
            duration = window_end - window_start

            if duration < min_duration:
                continue
            if duration > max_duration:
                break

            score = _score_segment(window_text, segments[i:j+1])
            candidates.append(HighlightCandidate(
                start=window_start,
                end=window_end,
                score=score,
                transcript=window_text.strip(),
            ))

    # Remove overlapping candidates (keep highest score)
    candidates.sort(key=lambda c: c.score, reverse=True)
    selected = []
    for c in candidates:
        if len(selected) >= target_clips:
            break
        if not any(_overlaps(c, s) for s in selected):
            selected.append(c)

    return sorted(selected, key=lambda c: c.start)

def _score_segment(text: str, segments: list) -> float:
    score = 0.0

    # Keyword density (engagement signals)
    keywords = ["amazing", "incredible", "wait", "oh my", "watch", "insane",
                 "unbelievable", "secret", "trick", "hack", "tip", "mistake"]
    text_lower = text.lower()
    for kw in keywords:
        if kw in text_lower:
            score += 0.5

    # Sentence completeness preference
    if text.strip().endswith(('.', '!', '?')):
        score += 0.3

    # Density: more words per second = more engaging
    duration = segments[-1]["end"] - segments[0]["start"]
    words_per_second = len(text.split()) / max(duration, 1)
    score += min(words_per_second * 0.2, 1.0)

    # Slight preference for mid-video content (intro/outro avoidance)
    total_segments = len(segments)
    position_ratio = segments[0].get("index", 0) / max(total_segments, 1)
    if 0.15 < position_ratio < 0.85:
        score += 0.2

    return score

def _overlaps(a: HighlightCandidate, b: HighlightCandidate) -> bool:
    return a.start < b.end and b.start < a.end
```

This runs in under 100ms for a 10-minute transcript. No optimization needed at any scale.

---

## 5. Clip Extraction and Encoding

This is the most CPU-intensive stage. FFmpeg configuration determines both output quality and processing speed.

### 5.1 Free Tier: Fast CPU Encoding

```bash
ffmpeg -y \
  -ss 120.5 \
  -i input.mp4 \
  -t 35.0 \
  -c:v libx264 \
  -preset fast \
  -crf 23 \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" \
  -c:a aac \
  -b:a 128k \
  -movflags +faststart \
  output.mp4
```

**Key flags explained:**

- `-ss` before `-i`: input seeking. This is critical — placing `-ss` before `-i` makes FFmpeg seek to the nearest keyframe and start decoding from there, rather than decoding the entire file from the beginning. For a 10-minute video, this saves ~8 seconds per clip.
- `-preset fast`: encodes 2-3x faster than `medium` with ~10% larger file size. On free tier, speed matters more than file size.
- `-crf 23`: constant rate factor. Lower = better quality, larger files. 23 is the default and good enough for social media clips.
- `-movflags +faststart`: moves the moov atom to the beginning of the file, enabling progressive playback without downloading the entire file.

### 5.2 Stream Copy (When Possible)

If the source video is already H.264 and you're not scaling, **copy the stream** instead of re-encoding:

```bash
ffmpeg -y \
  -ss 120.5 \
  -i input.mp4 \
  -t 35.0 \
  -c copy \
  -movflags +faststart \
  output.mp4
```

This is **10-50x faster** than re-encoding because no decoding/encoding happens — FFmpeg just copies bytes. The downside: you cannot scale, add filters, or guarantee precise frame boundaries (it snaps to the nearest keyframe). For social media clips where exact framing matters, re-encode.

Detection logic:

```python
def can_stream_copy(probe: dict, target_resolution: tuple[int, int] = (1920, 1080)) -> bool:
    return (
        probe["video_codec"] == "h264"
        and probe["width"] <= target_resolution[0]
        and probe["height"] <= target_resolution[1]
        and probe["fps"] <= 60
    )
```

### 5.3 Scaled: Parallel Clip Export

When exporting multiple clips from the same source video, parallelize FFmpeg processes but limit concurrency:

```python
import asyncio
from concurrent.futures import ProcessPoolExecutor

# Each FFmpeg process uses ~1-2 cores. On an 8-core machine, run 4 clips in parallel.
clip_pool = ProcessPoolExecutor(max_workers=4)

async def export_clips(source_path: str, clips: list[dict], output_dir: str) -> list[str]:
    loop = asyncio.get_event_loop()
    tasks = []

    for i, clip in enumerate(clips):
        output_path = f"{output_dir}/clip_{i}.mp4"
        tasks.append(loop.run_in_executor(
            clip_pool,
            _export_single_clip,
            source_path, output_path, clip["start"], clip["duration"]
        ))

    results = await asyncio.gather(*tasks, return_exceptions=True)
    return [r for r in results if isinstance(r, str)]

def _export_single_clip(source, output, start, duration):
    import subprocess
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(start),
        "-i", source,
        "-t", str(duration),
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        output
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return output
```

### 5.4 Scaled: Hardware-Accelerated Encoding

On GPU nodes, use NVENC for encoding (NVIDIA GPUs) or VideoToolbox on macOS:

```bash
ffmpeg -y \
  -ss 120.5 \
  -i input.mp4 \
  -t 35.0 \
  -c:v h264_nvenc \
  -preset p4 \
  -cq 23 \
  -b:v 0 \
  -c:a aac -b:a 128k \
  -movflags +faststart \
  output.mp4
```

NVENC encoding speed comparison on an NVIDIA T4:

| Method | Speed (1080p, 35s clip) | CPU Usage |
|---|---|---|
| libx264 `-preset fast` | ~8s | 100% (4 cores) |
| h264_nvenc `-preset p4` | ~1.5s | 5% CPU, 40% GPU |
| h264_nvenc `-preset p1` (fastest) | ~0.8s | 3% CPU, 60% GPU |

NVENC is 5-10x faster and frees CPU for transcription and API serving.

---

## 6. Batch Processing Optimization

When a user uploads a 2-hour video expecting 10+ clips, sequential processing is too slow. Use a pipeline approach:

```python
import asyncio

async def process_video_pipeline(source_path: str, config: dict):
    probe = probe_video(source_path)

    # Stage 1: Audio extraction (starts immediately)
    audio_task = asyncio.create_task(extract_audio(source_path))

    # Stage 2: Transcription (waits for audio)
    audio_path = await audio_task
    transcript = await transcribe(audio_path)

    # Stage 3: Highlight detection (CPU-bound, fast)
    highlights = detect_highlights(transcript, target_clips=config.get("clip_count", 5))

    # Stage 4: Parallel clip export
    clip_paths = await export_clips(source_path, [
        {"start": h.start, "end": h.end, "duration": h.end - h.start}
        for h in highlights
    ], output_dir=config["output_dir"])

    # Stage 5: Parallel upload to CDN
    cdn_urls = await asyncio.gather(*[
        upload_to_cdn(path) for path in clip_paths
    ])

    return {
        "clips": [
            {"url": url, "highlight": h}
            for url, h in zip(cdn_urls, highlights)
        ]
    }
```

The pipeline parallelism reduces total time: while clips 1-4 are encoding, the next set of highlights is already queued.

---

## 7. Memory Management

Video processing is memory-hungry. A single FFmpeg process decoding 4K video can consume 2-4 GB of RAM.

### 7.1 Free Tier: Constrain FFmpeg Memory

```bash
# Limit FFmpeg's thread count to reduce memory usage
ffmpeg -threads 2 -i input.mp4 ...

# Use lower-quality decoding for preview/thumbnail generation
ffmpeg -i input.mp4 -vf "scale=640:360" -frames:v 1 thumbnail.jpg
```

### 7.2 Scaled: Per-Worker Memory Limits

In Docker/Kubernetes, enforce memory limits per worker:

```yaml
# docker-compose.yml
services:
  clip-worker:
    image: miniop-worker:latest
    deploy:
      resources:
        limits:
          memory: 4G
          cpus: '2.0'
        reservations:
          memory: 2G
          cpus: '1.0'
    environment:
      - MAX_CONCURRENT_CLIPS=2
```

If a worker exceeds its memory limit, the container gets OOM-killed. The job queue (BullMQ) automatically re-queues the failed job for another worker.

### 7.3 Disk Space Management

Video files accumulate fast. A single 10-minute 1080p source video generates:
- Original: ~500 MB
- Audio extract: ~100 MB
- 5 clips at 1080p: ~100 MB total
- Thumbnails: ~5 MB

Total: ~700 MB per job. At 100 jobs/day, that's 70 GB/day.

Implement aggressive cleanup:

```python
import os
import time

def cleanup_job_files(job_dir: str):
    """Remove all temp files for a completed job."""
    import shutil
    if os.path.exists(job_dir):
        shutil.rmtree(job_dir)

def schedule_cleanup(base_dir: str, max_age_hours: int = 2):
    """Remove any job directories older than max_age_hours."""
    cutoff = time.time() - (max_age_hours * 3600)
    for job_id in os.listdir(base_dir):
        job_path = os.path.join(base_dir, job_id)
        if os.path.isdir(job_path) and os.path.getmtime(job_path) < cutoff:
            shutil.rmtree(job_path)
```

---

## 8. Quality vs Speed Tradeoff Matrix

| Scenario | Preset | CRF | Resolution | Speed | Quality |
|---|---|---|---|---|---|
| Free tier, social media clips | `fast` | 23 | 1080p | Baseline | Good |
| Free tier, preview/thumbnail | `ultrafast` | 28 | 720p | 2x baseline | Acceptable |
| Scaled, standard quality | `medium` | 22 | 1080p | 0.5x baseline | Very good |
| Scaled, high quality (pro users) | `slow` | 20 | 1080p | 0.25x baseline | Excellent |
| Scaled, 4K source → 1080p output | `medium` | 22 | 1080p | 0.4x baseline | Very good |

For most MiniOp use cases (social media clips), `fast` preset with CRF 23 is the right default. Only offer higher quality to paying users who explicitly request it.

---

## 9. Monitoring Processing Performance

Track these metrics per processing stage:

```python
import time
from contextlib import contextmanager

@contextmanager
def stage_timer(stage_name: str):
    start = time.perf_counter()
    yield
    elapsed = time.perf_counter() - start

    # Emit to Prometheus
    stage_duration.labels(stage=stage_name).observe(elapsed)

    if elapsed > STAGE_THRESHOLDS.get(stage_name, 60):
        logger.warning(f"Stage {stage_name} took {elapsed:.1f}s (threshold: {STAGE_THRESHOLDS[stage_name]}s)")

# Usage
with stage_timer("audio_extract"):
    audio_path = await extract_audio(source_path)

with stage_timer("transcription"):
    transcript = await transcribe(audio_path)

with stage_timer("highlight_detection"):
    highlights = detect_highlights(transcript)

with stage_timer("clip_export"):
    clips = await export_clips(source_path, highlights, output_dir)
```

Set alerting thresholds:
- Audio extraction: > 10s for a 10-minute video
- Transcription (CPU): > 90s for a 10-minute video
- Transcription (GPU): > 20s for a 10-minute video
- Clip export: > 45s per clip (CPU), > 5s per clip (GPU)
- Total pipeline: > 120s (free tier), > 40s (scaled)
