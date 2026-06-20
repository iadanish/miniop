# Whisper Transcription Pipeline

## Overview

MiniOp uses OpenAI's Whisper models as the foundation of its transcription pipeline. Every video uploaded to the platform is transcribed into timestamped text segments that feed downstream clip detection, virality scoring, and subtitle generation. The pipeline must handle everything from a 30-second TikTok to a 3-hour podcast episode, and it must do so under two distinct operational modes: a free-tier self-hosted path (using whisper-base or whisper-small for lower VRAM requirements) and a horizontally scaled production path (using whisper-large-v3 for maximum accuracy).

## Architecture

The transcription pipeline follows a single flow regardless of tier:

```
Video Upload → Audio Extraction (FFmpeg) → Chunking → Whisper Inference → Timestamp Alignment → Segment Merging → Output
```

The difference lies in how each stage is executed. Free tier runs everything on a single machine with GPU. Production tier splits each stage into independently scalable microservices connected by a message queue.

## Audio Extraction

Before Whisper can process anything, the audio track must be extracted and normalized. FFmpeg handles this:

```bash
ffmpeg -i input.mp4 -vn -acodec pcm_s16le -ar 16000 -ac 1 -f wav output.wav
```

Key parameters:
- `-vn`: Strip video track entirely. Whisper does not need it.
- `-ar 16000`: Resample to 16kHz. This is Whisper's native sample rate. Resampling to anything else wastes compute on internal conversion.
- `-ac 1`: Mono channel. Stereo doubles data with zero transcription benefit.
- `-f wav`: Raw PCM WAV avoids codec decompression overhead in the Python pipeline.

For production, this runs as a sidecar container in a Kubernetes pod:

```yaml
containers:
  - name: audio-extractor
    image: minio/audio-extractor:latest
    resources:
      requests:
        cpu: "500m"
        memory: "256Mi"
      limits:
        cpu: "2"
        memory: "1Gi"
    env:
      - name: MAX_CONCURRENT
        value: "4"
```

## Whisper Inference

### Free Tier: Local GPU

Install and run Whisper base or small (lower VRAM, fits on Colab T4):

```bash
pip install openai-whisper==20231117
```

```python
import whisper
import torch

model = whisper.load_model("small", device="cuda")

result = model.transcribe(
    "output.wav",
    language="en",
    word_timestamps=True,
    condition_on_previous_text=True,
    compression_ratio_threshold=2.4,
    no_speech_threshold=0.6,
    beam_size=5,
    best_of=5,
)

segments = result["segments"]
for seg in segments:
    print(f"[{seg['start']:.2f} → {seg['end']:.2f}] {seg['text']}")
```

Critical parameters:

- `word_timestamps=True`: Enables word-level timing. Without this, you only get segment-level timestamps, which are too coarse for precise clip boundaries.
- `condition_on_previous_text=True`: Uses prior transcript context to improve accuracy on ambiguous phrases. Disable this only if segments are truly independent (different speakers, different topics).
- `no_speech_threshold=0.6`: Segments below this probability are marked as silence. The default 0.6 is aggressive; tune down to 0.4 for content with heavy background noise or music.
- `beam_size=5` and `best_of=5`: Both increase quality at the cost of speed. On a single RTX 3090, this roughly doubles inference time compared to defaults. For a 1-hour video, expect ~8-12 minutes of processing.

Hardware requirements for free tier:
- Minimum: NVIDIA GPU with 10GB VRAM (RTX 3080 or equivalent)
- Recommended: RTX 3090/4090 or A100 with 24GB+ VRAM
- CPU inference is technically possible but 10-20x slower. Not viable for production use.

### Production: Whisper Server

In production, run Whisper as a persistent gRPC service behind a load balancer. Use `faster-whisper` (CTranslate2 backend) for 4x speed improvement over vanilla Whisper:

```python
from faster_whisper import WhisperModel

model = WhisperModel("large-v3", device="cuda", compute_type="float16")

segments, info = model.transcribe(
    "output.wav",
    beam_size=5,
    best_of=5,
    word_timestamps=True,
    condition_on_previous_text=True,
    vad_filter=True,
    vad_parameters=dict(
        min_silence_duration_ms=500,
        speech_pad_ms=200,
    ),
)
```

`vad_filter=True` is the key production optimization. It uses Silero VAD to skip silence detection entirely, reducing processing time by 30-50% on typical podcast content.

Deploy as a FastAPI service:

```python
from fastapi import FastAPI, UploadFile
from faster_whisper import WhisperModel

app = FastAPI()
model = WhisperModel("large-v3", device="cuda", compute_type="float16")

@app.post("/transcribe")
async def transcribe(file: UploadFile):
    audio_path = f"/tmp/{file.filename}"
    with open(audio_path, "wb") as f:
        f.write(await file.read())

    segments, info = model.transcribe(
        audio_path,
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
    )

    return {
        "language": info.language,
        "segments": [
            {
                "start": s.start,
                "end": s.end,
                "text": s.text,
                "words": [
                    {"word": w.word, "start": w.start, "end": w.end}
                    for w in (s.words or [])
                ],
            }
            for s in segments
        ],
    }
```

Kubernetes deployment with GPU scheduling:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: whisper-server
spec:
  replicas: 3
  selector:
    matchLabels:
      app: whisper-server
  template:
    spec:
      containers:
        - name: whisper
          image: minio/whisper-server:latest
          resources:
            requests:
              nvidia.com/gpu: "1"
              memory: "8Gi"
            limits:
              nvidia.com/gpu: "1"
              memory: "16Gi"
          ports:
            - containerPort: 8000
          readinessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 30
            periodSeconds: 10
```

Scale horizontally based on queue depth:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: whisper-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: whisper-server
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: External
      external:
        metric:
          name: rabbitmq_queue_messages_ready
          selector:
            matchLabels:
              queue: transcription
        target:
          type: AverageValue
          averageValue: "5"
```

## Segment Post-Processing

Raw Whisper output needs cleaning before it reaches clip analysis.

### Gap Merging

Whisper often splits a single sentence across multiple segments. Merge segments with gaps under 300ms:

```python
def merge_segments(segments: list[dict], max_gap: float = 0.3) -> list[dict]:
    merged = [segments[0].copy()]
    for seg in segments[1:]:
        prev = merged[-1]
        gap = seg["start"] - prev["end"]
        if gap < max_gap:
            prev["end"] = seg["end"]
            prev["text"] += " " + seg["text"]
            prev["words"].extend(seg.get("words", []))
        else:
            merged.append(seg.copy())
    return merged
```

### Speaker Diarization

For multi-speaker content (interviews, panels), overlay speaker labels using pyannote.audio:

```python
from pyannote.audio import Pipeline

pipeline = Pipeline.from_pretrained(
    "pyannote/speaker-diarization-3.1",
    use_auth_token="YOUR_HF_TOKEN",
)

diarization = pipeline("output.wav")

for turn, _, speaker in diarization.itertracks(yield_label=True):
    print(f"[{turn.start:.1f} → {turn.end:.1f}] {speaker}")
```

Align diarization with Whisper segments by matching timestamp overlap. Assign each Whisper segment to the speaker whose diarization window covers the majority of that segment.

## Output Format

The final transcription output is a JSON structure consumed by the clip analysis pipeline:

```json
{
  "video_id": "abc123",
  "language": "en",
  "duration_seconds": 3720,
  "segments": [
    {
      "id": 0,
      "start": 0.0,
      "end": 4.2,
      "text": "Welcome back to the show everybody.",
      "speaker": "SPEAKER_00",
      "words": [
        {"word": "Welcome", "start": 0.0, "end": 0.4},
        {"word": "back", "start": 0.5, "end": 0.8}
      ],
      "no_speech_prob": 0.12,
      "avg_logprob": -0.23
    }
  ]
}
```

## Cost and Performance Benchmarks

| Metric | Free Tier (RTX 3090) | Production (A100, faster-whisper) |
|---|---|---|
| 1-hour video processing | 8-12 min | 2-3 min |
| Concurrent videos | 1 | 6-8 per GPU |
| VRAM usage | 10-12 GB | 6-8 GB (float16) |
| Monthly throughput (single GPU) | ~150 hours | ~800 hours |

## Error Handling

Common failures and mitigations:

- **CUDA OOM**: Reduce `batch_size` or switch to `compute_type="int8_float16"` for 40% VRAM reduction at minor quality loss.
- **Corrupt audio**: Catch `ffmpeg` exit code 1 and return a structured error. Do not silently pass empty WAV files to Whisper.
- **Language misdetection**: For known-language content, set `language="en"` explicitly. Auto-detection adds latency and fails on code-switched content.
- **Hallucination loops**: Whisper sometimes enters repetitive text loops on silence or music. Detect via compression ratio check: if the output text compression ratio exceeds 2.4, flag the segment as unreliable.
