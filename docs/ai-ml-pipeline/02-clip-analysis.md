# Clip Analysis Pipeline

## Overview

Clip analysis is the core intelligence layer of MiniOp. Given a transcribed video with timestamped segments, this pipeline identifies which portions are most suitable for short-form clips (15-90 seconds). It combines transcript analysis, visual feature extraction, and emotion detection to score every possible segment window and surface the best candidates.

This pipeline consumes the JSON output from the Whisper transcription stage and produces a ranked list of clip candidates with metadata used by the virality scorer.

## Pipeline Stages

```
Transcript Segments → Window Generation → Feature Extraction (CLIP + FER) → Multi-Signal Scoring → Candidate Ranking
```

### Stage 1: Window Generation

Not every segment boundary makes a good clip boundary. The first step generates candidate windows that respect sentence boundaries, topic shifts, and natural pauses.

```python
from dataclasses import dataclass

@dataclass
class ClipWindow:
    start: float
    end: float
    text: str
    segments: list[int]  # indices into transcript segments

def generate_windows(
    segments: list[dict],
    min_duration: float = 15.0,
    max_duration: float = 90.0,
    step_duration: float = 5.0,
) -> list[ClipWindow]:
    windows = []
    n = len(segments)

    for i in range(n):
        for j in range(i, n):
            start = segments[i]["start"]
            end = segments[j]["end"]
            duration = end - start

            if duration < min_duration:
                continue
            if duration > max_duration:
                break

            # Check for sentence boundary alignment
            ends_at_sentence = _is_sentence_end(segments[j]["text"])
            starts_at_sentence = _is_sentence_start(segments[i]["text"])

            # Prefer windows aligned to sentence boundaries
            boundary_score = (1.0 if ends_at_sentence else 0.5) * \
                           (1.0 if starts_at_sentence else 0.5)

            if boundary_score < 0.25:
                continue

            windows.append(ClipWindow(
                start=start,
                end=end,
                text=" ".join(s["text"] for s in segments[i:j+1]),
                segments=list(range(i, j + 1)),
            ))

    return windows

def _is_sentence_end(text: str) -> bool:
    return text.rstrip().endswith((".", "!", "?", '"', "'"))

def _is_sentence_start(text: str) -> bool:
    return text[0].isupper() if text else False
```

For a 1-hour video with ~500 segments, this produces 2000-5000 candidate windows. That is too many to run through expensive visual models, so the next stage filters aggressively.

### Stage 2: Transcript Pre-Filtering

Before touching any visual model, filter windows using transcript-only signals:

```python
import re
from collections import Counter

FILLER_WORDS = {"um", "uh", "like", "you know", "basically", "literally",
                "sort of", "kind of", "i mean", "right"}

def transcript_score(window: ClipWindow, full_segments: list[dict]) -> float:
    words = window.text.lower().split()
    word_count = len(words)

    if word_count < 10:
        return 0.0

    # Filler word ratio
    filler_count = sum(1 for w in words if w in FILLER_WORDS)
    filler_ratio = filler_count / word_count

    # Question detection (questions drive engagement)
    question_count = window.text.count("?")
    has_question = question_count > 0

    # Emotional language detection
    emotional_words = {"amazing", "terrible", "shocked", "incredible",
                       "unbelievable", "worst", "best", "insane", "crazy"}
    emotional_ratio = sum(1 for w in words if w in emotional_words) / word_count

    # Sentence completeness
    sentences = re.split(r'[.!?]+', window.text)
    complete_sentences = sum(1 for s in sentences if len(s.strip().split()) >= 4)
    completeness = complete_sentences / max(len(sentences), 1)

    # Information density (unique words / total words)
    unique_ratio = len(set(words)) / word_count

    score = (
        (1.0 - filler_ratio) * 0.25
        + (1.0 if has_question else 0.0) * 0.20
        + min(emotional_ratio * 10, 1.0) * 0.20
        + completeness * 0.20
        + unique_ratio * 0.15
    )

    return score
```

Filter to the top 200-300 windows by transcript score before visual analysis. This reduces CLIP inference by 90% while retaining nearly all genuinely good clips.

### Stage 3: Visual Feature Extraction with CLIP

CLIP (Contrastive Language-Image Pre-training) computes the semantic alignment between text descriptions and video frames. This is how MiniOp determines if a clip's visual content matches its spoken content.

Extract keyframes at 1 FPS for each candidate window:

```python
import cv2
import torch
from transformers import CLIPProcessor, CLIPModel

model = CLIPModel.from_pretrained("openai/clip-vit-large-patch14")
processor = CLIPProcessor.from_pretrained("openai/clip-vit-large-patch14")

def extract_keyframes(video_path: str, start: float, end: float, fps: float = 1.0) -> list:
    cap = cv2.VideoCapture(video_path)
    video_fps = cap.get(cv2.CAP_PROP_FPS)
    frames = []

    frame_interval = video_fps / fps
    current_frame = int(start * video_fps)
    end_frame = int(end * video_fps)

    while current_frame < end_frame:
        cap.set(cv2.CAP_PROP_POS_FRAMES, current_frame)
        ret, frame = cap.read()
        if not ret:
            break
        frames.append(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        current_frame += int(frame_interval)

    cap.release()
    return frames

def compute_clip_relevance(frames: list, text: str) -> float:
    inputs = processor(
        text=[text],
        images=frames,
        return_tensors="pt",
        padding=True,
        truncation=True,
        max_length=77,
    )

    with torch.no_grad():
        outputs = model(**inputs)

    logits_per_image = outputs.logits_per_image
    similarities = logits_per_image.softmax(dim=0)

    # Average similarity across frames
    avg_similarity = similarities.mean().item()

    # Variance indicates visual diversity (higher = more dynamic)
    similarity_variance = similarities.var().item()

    return {
        "avg_relevance": avg_similarity,
        "visual_dynamics": similarity_variance,
    }
```

For free tier, run CLIP on CPU with float32. It processes ~50 frames/second on a modern CPU. For production, use GPU batching:

```python
# Production: batch multiple windows through CLIP simultaneously
def batch_clip_scoring(
    windows: list[dict],
    batch_size: int = 32,
    device: str = "cuda",
) -> list[dict]:
    model.to(device)
    results = []

    for i in range(0, len(windows), batch_size):
        batch = windows[i:i+batch_size]
        all_frames = []
        frame_counts = []

        for w in batch:
            frames = extract_keyframes(w["video_path"], w["start"], w["end"])
            all_frames.extend(frames)
            frame_counts.append(len(frames))

        inputs = processor(
            text=[w["text"][:77] for w in batch],
            images=all_frames,
            return_tensors="pt",
            padding=True,
        ).to(device)

        with torch.no_grad():
            outputs = model(**inputs)

        # Split scores back per window
        scores = outputs.logits_per_image.cpu()
        idx = 0
        for j, count in enumerate(frame_counts):
            window_scores = scores[idx:idx+count]
            results.append({
                "avg_relevance": window_scores.mean().item(),
                "visual_dynamics": window_scores.var().item(),
            })
            idx += count

    return results
```

### Stage 4: Emotion Detection with FER

Facial Expression Recognition (FER) detects emotional intensity in video frames. Clips with visible emotional reactions perform significantly better on social media.

```python
from fer import FER
import cv2

detector = FER(mtcnn=True)

def analyze_emotions(video_path: str, start: float, end: float) -> dict:
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    emotions_timeline = []
    sample_interval = int(fps * 0.5)  # Sample every 0.5 seconds

    current_frame = int(start * fps)
    end_frame = int(end * fps)

    while current_frame < end_frame:
        cap.set(cv2.CAP_PROP_POS_FRAMES, current_frame)
        ret, frame = cap.read()
        if not ret:
            break

        results = detector.detect_emotions(frame)
        if results:
            # Take the dominant face (largest bounding box)
            dominant_face = max(results, key=lambda r:
                r["box"][2] * r["box"][3])
            emotions_timeline.append({
                "frame": current_frame,
                "emotions": dominant_face["emotions"],
                "confidence": max(dominant_face["emotions"].values()),
            })

        current_frame += sample_interval

    cap.release()

    if not emotions_timeline:
        return {"emotional_intensity": 0.0, "dominant_emotion": "neutral",
                "emotion_variance": 0.0}

    # Compute metrics
    avg_emotions = {}
    for emotion in emotions_timeline[0]["emotions"]:
        values = [e["emotions"][emotion] for e in emotions_timeline]
        avg_emotions[emotion] = sum(values) / len(values)

    dominant = max(avg_emotions, key=avg_emotions.get)

    # Emotional variance: high variance = visible emotional shifts = good content
    intensities = [e["confidence"] for e in emotions_timeline]
    variance = sum((i - sum(intensities)/len(intensities))**2 for i in intensities) / len(intensities)

    return {
        "emotional_intensity": max(avg_emotions.values()),
        "dominant_emotion": dominant,
        "emotion_variance": variance,
        "emotion_breakdown": avg_emotions,
        "timeline": emotions_timeline,
    }
```

FER runs on CPU (MTCNN face detection) and processes ~3 frames/second. For a 60-second clip sampled at 2 FPS, that is ~10 seconds of processing. Acceptable for free tier. For production, replace MTCNN with RetinaFace for 5x speed improvement and better small-face detection.

### Stage 5: Multi-Signal Scoring

Combine all signals into a single clip quality score:

```python
def score_clip(
    window: ClipWindow,
    transcript_score: float,
    clip_relevance: dict,
    emotion_data: dict,
    speaker_data: dict | None = None,
) -> dict:
    # Normalize signals
    text_signal = transcript_score  # Already 0-1
    visual_signal = min(clip_relevance["avg_relevance"] * 10, 1.0)
    dynamics_signal = min(clip_relevance["visual_dynamics"] * 5, 1.0)
    emotion_signal = emotion_data["emotional_intensity"]
    emotion_shift_signal = min(emotion_data["emotion_variance"] * 20, 1.0)

    # Duration penalty: prefer 30-60 second clips
    duration = window.end - window.start
    if 30 <= duration <= 60:
        duration_bonus = 1.0
    elif 15 <= duration < 30 or 60 < duration <= 90:
        duration_bonus = 0.8
    else:
        duration_bonus = 0.5

    # Speaker consistency bonus (single-speaker clips perform better)
    speaker_bonus = 1.0
    if speaker_data:
        speakers = speaker_data.get("speakers_in_window", [])
        if len(speakers) == 1:
            speaker_bonus = 1.1
        elif len(speakers) > 2:
            speaker_bonus = 0.8

    final_score = (
        text_signal * 0.30
        + visual_signal * 0.20
        + dynamics_signal * 0.15
        + emotion_signal * 0.15
        + emotion_shift_signal * 0.10
        + duration_bonus * 0.05
        + speaker_bonus * 0.05
    )

    return {
        "clip_id": f"{window.start:.1f}_{window.end:.1f}",
        "start": window.start,
        "end": window.end,
        "duration": duration,
        "text": window.text,
        "final_score": round(final_score, 4),
        "signals": {
            "transcript": round(text_signal, 4),
            "visual_relevance": round(visual_signal, 4),
            "visual_dynamics": round(dynamics_signal, 4),
            "emotion_intensity": round(emotion_signal, 4),
            "emotion_shifts": round(emotion_shift_signal, 4),
            "duration_bonus": round(duration_bonus, 4),
            "speaker_bonus": round(speaker_bonus, 4),
        },
    }
```

## Free Tier vs Production

| Component | Free Tier | Production |
|---|---|---|
| CLIP inference | CPU, sequential | GPU, batched (32 windows/batch) |
| FER | MTCNN (~3 fps) | RetinaFace (~15 fps) |
| Window candidates | Top 100 after filter | Top 300 after filter |
| Parallelism | Single-threaded | Celery workers, 4-8 per GPU node |
| Caching | No caching | Redis cache for CLIP embeddings per video |

## Celery Task Integration (Production)

```python
from celery import Celery

app = Celery("clip_analysis", broker="redis://redis:6379/0")

@app.task(bind=True, max_retries=3, time_limit=600)
def analyze_video(self, video_id: str, transcription: dict):
    try:
        windows = generate_windows(transcription["segments"])
        windows = prefilter_by_transcript(windows, transcription["segments"])

        # Parallel CLIP scoring
        clip_results = batch_clip_scoring(windows)

        # Parallel FER analysis
        emotion_results = []
        for w in windows:
            emotion_results.append(analyze_emotions(
                w["video_path"], w["start"], w["end"]
            ))

        # Combine and rank
        scored = []
        for w, clip_r, emo_r in zip(windows, clip_results, emotion_results):
            scored.append(score_clip(w, w["transcript_score"], clip_r, emo_r))

        scored.sort(key=lambda x: x["final_score"], reverse=True)

        return {
            "video_id": video_id,
            "top_clips": scored[:20],
            "total_candidates": len(windows),
        }
    except Exception as exc:
        self.retry(exc=exc, countdown=60)
```

## Output

The clip analysis stage produces a ranked list of clip candidates consumed by both the virality scorer and the clip rendering pipeline:

```json
{
  "video_id": "abc123",
  "top_clips": [
    {
      "clip_id": "142.3_188.7",
      "start": 142.3,
      "end": 188.7,
      "duration": 46.4,
      "text": "And that's when I realized the entire business model was backwards...",
      "final_score": 0.8742,
      "signals": {
        "transcript": 0.92,
        "visual_relevance": 0.81,
        "visual_dynamics": 0.73,
        "emotion_intensity": 0.88,
        "emotion_shifts": 0.65
      }
    }
  ],
  "total_candidates": 3847,
  "processing_time_seconds": 127
}
```

## Debugging and Tuning

If clips are consistently poor quality, check these in order:

1. **Transcript score dominates**: If `signals.transcript` is always above 0.8, the transcript filter is not discriminating enough. Add topic coherence scoring via sentence-transformers embeddings.
2. **FER returns zero intensity**: Usually means faces are too small or too few. Lower the resolution threshold in MTCNN or switch to RetinaFace.
3. **CLIP relevance is uniformly high**: The text truncation to 77 tokens is losing context. Summarize each window's text before CLIP encoding.
4. **All clips are 15 seconds**: The duration bonus is too weak relative to other signals. Increase the duration_bonus weight or add a hard minimum of 25 seconds.
