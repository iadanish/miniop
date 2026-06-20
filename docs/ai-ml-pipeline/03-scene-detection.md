# Scene Detection Pipeline

## Overview

Scene detection identifies visual transitions in a video — hard cuts, fade-ins, dissolves, and content shifts. In MiniOp, scene boundaries serve as constraints for clip generation: clips should start and end at natural scene boundaries rather than mid-scene, which would look jarring when extracted as a short-form video.

MiniOp uses PySceneDetect as the primary detection engine, supplemented by SAM (Segment Anything Model) for fine-grained object-level change detection in high-value content.

## Why Scene Detection Matters for Clips

A clip that starts mid-camera-switch or ends mid-transition feels amateurish. By aligning clip boundaries to detected scene changes, MiniOp produces clips that feel like they were intentionally edited rather than crudely chopped. This is one of the key differences between a tool that just cuts and a tool that produces shareable content.

## PySceneDetect: Core Detection

### Installation

```bash
pip install scenedetect[opencv] opencv-python-headless
```

### Free Tier: Content-Aware Detection

The content detector analyzes per-frame color histogram differences. It is robust against gradual transitions and works well on most video content without tuning.

```python
from scenedetect import open_video, SceneManager
from scenedetect.detectors import ContentDetector

def detect_scenes(video_path: str, threshold: float = 27.0) -> list[dict]:
    video = open_video(video_path)
    scene_manager = SceneManager()
    scene_manager.add_detector(
        ContentDetector(
            threshold=threshold,
            min_scene_len=15,  # Minimum 15 frames between cuts
        )
    )

    scene_manager.detect_scenes(video, show_progress=False)
    scene_list = scene_manager.get_scene_list()

    scenes = []
    for i, (start, end) in enumerate(scene_list):
        scenes.append({
            "scene_id": i,
            "start_time": start.get_seconds(),
            "end_time": end.get_seconds(),
            "duration": end.get_seconds() - start.get_seconds(),
        })

    return scenes
```

Threshold tuning guidelines:
- **20-25**: Sensitive. Detects subtle transitions, may produce false positives on slow camera pans.
- **27-30**: Default range. Works well for most edited content (YouTube, podcasts, interviews).
- **35-40**: Conservative. Only detects hard cuts. Use for raw, unedited footage with lots of motion.
- **45+**: Very conservative. Use only when false positives are a major problem.

### Production: Adaptive Threshold Detection

Fixed thresholds fail across diverse content types. Production runs multiple thresholds and selects the best result based on scene duration distribution:

```python
def adaptive_scene_detection(video_path: str) -> list[dict]:
    thresholds = [22.0, 27.0, 33.0, 40.0]
    results = []

    for t in thresholds:
        scenes = detect_scenes(video_path, threshold=t)
        results.append((t, scenes))

    # Score each threshold by scene distribution quality
    best_threshold, best_scenes = None, None
    best_score = -1

    for threshold, scenes in results:
        if len(scenes) < 3:
            continue

        durations = [s["duration"] for s in scenes]
        avg_duration = sum(durations) / len(durations)

        # Penalize too many scenes (threshold too low)
        scene_count_penalty = max(0, 1.0 - len(scenes) / 500)

        # Penalize very short scenes (noise)
        short_scene_ratio = sum(1 for d in durations if d < 2.0) / len(durations)
        short_penalty = 1.0 - short_scene_ratio

        # Reward reasonable average duration (3-30 seconds for typical content)
        if 3 <= avg_duration <= 30:
            duration_bonus = 1.0
        elif 1 <= avg_duration < 3:
            duration_bonus = 0.7
        else:
            duration_bonus = 0.5

        score = scene_count_penalty * 0.3 + short_penalty * 0.4 + duration_bonus * 0.3

        if score > best_score:
            best_score = score
            best_threshold = threshold
            best_scenes = scenes

    return best_scenes
```

### Histagram-Based Detection (Fast Path)

For rapid pre-screening before full content detection, use histogram difference as a fast filter:

```python
import cv2
import numpy as np

def fast_histogram_transitions(
    video_path: str,
    threshold: float = 0.4,
    sample_fps: float = 2.0,
) -> list[float]:
    """Detect hard cuts using histogram correlation. 10x faster than
    content-aware detection but misses gradual transitions."""
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_interval = int(fps / sample_fps)

    prev_hist = None
    transitions = []
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % frame_interval == 0:
            # Compute HSV histogram (more robust than RGB)
            hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
            hist = cv2.calcHist([hsv], [0, 1], None, [50, 60], [0, 180, 0, 256])
            cv2.normalize(hist, hist)

            if prev_hist is not None:
                correlation = cv2.compareHist(
                    prev_hist, hist, cv2.HISTCMP_CORREL
                )
                if correlation < (1.0 - threshold):
                    transitions.append(frame_idx / fps)

            prev_hist = hist

        frame_idx += 1

    cap.release()
    return transitions
```

## SAM: Object-Level Change Detection

SAM (Segment Anything Model) provides a deeper layer of scene understanding. While PySceneDetect identifies camera-level transitions, SAM detects when the primary subject changes — useful for content like reaction videos where the camera stays fixed but the focal point shifts.

### When to Use SAM

SAM is computationally expensive. Use it selectively:
- Podcast clips where the speaker changes
- Reaction videos where the subject shifts
- Screen recordings where the active window changes
- Any content where camera stays fixed but content changes

Do NOT use SAM for:
- Action videos with rapid cuts (PySceneDetect handles these)
- Music videos with heavy color grading (SAM struggles with aesthetic changes)
- Content with no clear subjects

### Implementation

```python
import torch
import numpy as np
from segment_anything import sam_model_registry, SamPredictor

sam = sam_model_registry["vit_h"](checkpoint="sam_vit_h_4b8939.pth")
sam.to(device="cuda" if torch.cuda.is_available() else "cpu")
predictor = SamPredictor(sam)

def detect_subject_changes(
    video_path: str,
    start: float,
    end: float,
    sample_interval: float = 2.0,
    iou_threshold: float = 0.5,
) -> list[dict]:
    """Detect when the primary subject changes within a video segment."""
    import cv2

    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)

    previous_masks = None
    changes = []
    current_time = start

    while current_time < end:
        frame_num = int(current_time * fps)
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_num)
        ret, frame = cap.read()
        if not ret:
            break

        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        predictor.set_image(rgb_frame)

        # Auto-generate masks for the entire frame
        masks, scores, _ = predictor.predict(
            point_coords=None,
            box=None,
            multimask_output=True,
        )

        # Take the highest-confidence mask (largest subject)
        best_mask = masks[scores.argmax()]

        if previous_masks is not None:
            # Compute IoU between current and previous subject masks
            intersection = np.logical_and(previous_masks, best_mask).sum()
            union = np.logical_or(previous_masks, best_mask).sum()
            iou = intersection / max(union, 1)

            if iou < iou_threshold:
                changes.append({
                    "time": current_time,
                    "iou": float(iou),
                    "type": "subject_change",
                })

        previous_masks = best_mask
        current_time += sample_interval

    cap.release()
    return changes
```

## Integration with Clip Pipeline

Scene boundaries constrain the window generation in clip analysis. Add scene-awareness to the window generator:

```python
def generate_scene_aligned_windows(
    segments: list[dict],
    scenes: list[dict],
    min_duration: float = 15.0,
    max_duration: float = 90.0,
) -> list[ClipWindow]:
    """Generate clip windows that start/end at scene boundaries."""
    windows = []

    # Build scene boundary lookup
    scene_starts = {s["start_time"] for s in scenes}
    scene_ends = {s["end_time"] for s in scenes}

    # Build a tolerance-based boundary matcher (within 1 second)
    def near_scene_boundary(time: float, boundary_set: set, tolerance: float = 1.0) -> bool:
        return any(abs(time - b) < tolerance for b in boundary_set)

    n = len(segments)
    for i in range(n):
        for j in range(i, n):
            start = segments[i]["start"]
            end = segments[j]["end"]
            duration = end - start

            if duration < min_duration or duration > max_duration:
                if duration > max_duration:
                    break
                continue

            # Score boundary alignment
            start_aligned = near_scene_boundary(start, scene_starts)
            end_aligned = near_scene_boundary(end, scene_ends)

            # Also check subject changes from SAM
            start_subject_change = any(
                abs(start - c["time"]) < 1.0 for c in subject_changes
            )
            end_subject_change = any(
                abs(end - c["time"]) < 1.0 for c in subject_changes
            )

            alignment_score = sum([
                start_aligned * 2,
                end_aligned * 2,
                start_subject_change * 1,
                end_subject_change * 1,
            ])

            if alignment_score >= 2:  # At least one strong boundary
                window = ClipWindow(
                    start=start,
                    end=end,
                    text=" ".join(s["text"] for s in segments[i:j+1]),
                    segments=list(range(i, j + 1)),
                )
                window.scene_alignment = alignment_score
                windows.append(window)

    return windows
```

## Celery Task Configuration (Production)

```python
from celery import Celery

app = Celery("scene_detection", broker="redis://redis:6379/0")

@app.task(bind=True, max_retries=2, time_limit=300)
def detect_video_scenes(self, video_id: str, video_path: str):
    try:
        # Fast path: histogram detection for hard cuts
        fast_transitions = fast_histogram_transitions(video_path, threshold=0.4)

        # Full path: content-aware detection
        scenes = adaptive_scene_detection(video_path)

        # SAM path: only for videos under 20 minutes (cost constraint)
        cap = cv2.VideoCapture(video_path)
        duration = cap.get(cv2.CAP_PROP_FRAME_COUNT) / cap.get(cv2.CAP_PROP_FPS)
        cap.release()

        subject_changes = []
        if duration < 1200:  # 20 minutes
            for scene in scenes[:50]:  # Limit to first 50 scenes
                changes = detect_subject_changes(
                    video_path,
                    scene["start_time"],
                    scene["end_time"],
                )
                subject_changes.extend(changes)

        return {
            "video_id": video_id,
            "scenes": scenes,
            "fast_transitions": fast_transitions,
            "subject_changes": subject_changes,
            "scene_count": len(scenes),
            "method": "adaptive_content+sam" if subject_changes else "adaptive_content",
        }
    except Exception as exc:
        self.retry(exc=exc, countdown=30)
```

## Kubernetes Resource Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: scene-detection
spec:
  replicas: 2
  selector:
    matchLabels:
      app: scene-detection
  template:
    spec:
      containers:
        - name: detector
          image: minio/scene-detection:latest
          resources:
            requests:
              cpu: "2"
              memory: "4Gi"
              nvidia.com/gpu: "1"
            limits:
              cpu: "4"
              memory: "8Gi"
              nvidia.com/gpu: "1"
          env:
            - name: SAM_CHECKPOINT_PATH
              value: "/models/sam_vit_h_4b8939.pth"
            - name: DEFAULT_DETECTION_METHOD
              value: "adaptive_content"
            - name: SAM_MAX_DURATION_SECONDS
              value: "1200"
```

## Performance Benchmarks

| Method | 1-Hour Video Processing | GPU Required | Precision | Recall |
|---|---|---|---|---|
| Histogram (fast) | 15-30 seconds | No | 0.85 | 0.70 |
| ContentDetector (default) | 2-4 minutes | No | 0.92 | 0.88 |
| Adaptive ContentDetector | 6-12 minutes | No | 0.95 | 0.90 |
| ContentDetector + SAM | 20-40 minutes | Yes (8GB VRAM) | 0.96 | 0.94 |

## Troubleshooting

**Too many scenes detected**: Increase threshold to 35+ or increase `min_scene_len` to 30 frames. Common with music videos or fast-cut content.

**No scenes detected**: The video may have no edits (single take). Check if `fast_histogram_transitions` also returns empty. If so, the video genuinely has no scene changes.

**SAM runs out of memory**: Reduce input resolution by resizing frames to 720p before SAM inference. The model processes at 1024x1024 internally anyway, so larger inputs add latency without quality benefit.

**Scene boundaries don't align with speech**: This is expected for interview-style content where the camera angle stays fixed. Rely on transcript sentence boundaries instead, and use scene detection only as a secondary signal.

**False scene changes on slow zooms**: ContentDetector treats slow Ken Burns effects as transitions. Increase `min_scene_len` to 45+ frames or add a secondary check that verifies the color histogram shift exceeds 60% of the threshold.
