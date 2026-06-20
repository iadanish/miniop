# Feedback Loops

## Overview

MiniOp implements four distinct feedback loops, each operating at a different timescale and level of abstraction. These loops are not optional — they are the mechanism by which the system improves without manual intervention. Every loop produces training signals that feed into the self-improvement pipeline.

| Loop | Timescale | Signal Type | Free Tier | Production |
|------|-----------|-------------|-----------|------------|
| Engagement | Seconds | Implicit | Yes | Yes |
| Quality Rating | Minutes | Explicit | Yes | Yes |
| Creator Correction | Hours | Semi-supervised | No | Yes |
| Semantic Drift | Days | Unsupervised | No | Yes |

---

## Loop 1: Engagement Feedback

The fastest and highest-volume loop. Every user interaction with a generated clip becomes a training signal.

### Signal Collection

```python
# services/engagement_tracker.py
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

@dataclass
class EngagementEvent:
    """Real-time user behavior tracking schema.

    NOTE: EngagementEvent captures individual user interactions at event
    granularity for analytics, A/B testing, and real-time scoring. For the
    model training feedback schema (aggregated per-clip-per-user), see
    ClipFeedback in 01-self-improvement-flow.md. Both schemas capture
    overlapping data but serve different purposes: EngagementEvent →
    analytics and live scoring, ClipFeedback → fine-tuning export.
    """
    clip_id: str
    user_id: str
    session_id: str
    event_type: str  # "play", "pause", "seek", "complete", "skip", "share", "save"
    timestamp: datetime = field(default_factory=datetime.utcnow)
    position_ms: int = 0
    duration_ms: int = 0
    metadata: dict = field(default_factory=dict)

    @property
    def weight(self) -> float:
        weights = {
            "play": 0.1,
            "complete": 0.4,
            "replay": 0.6,
            "save": 0.8,
            "share": 1.0,
            "skip": -0.3,
            "skip_early": -0.5,  # skipped within first 3 seconds
        }
        base = weights.get(self.event_type, 0.0)

        # Boost for watch-through percentage
        if self.duration_ms > 0 and self.event_type == "complete":
            watch_ratio = min(self.position_ms / self.duration_ms, 1.0)
            if watch_ratio > 0.9:
                base *= 1.2

        return base
```

### Free Tier: Polling-Based Collection

Free tier uses a simple REST endpoint with client-side batching:

```javascript
// frontend/src/feedback/batchSender.js
class EngagementBatchSender {
  constructor(endpoint, batchSize = 10, flushIntervalMs = 5000) {
    this.endpoint = endpoint;
    this.batch = [];
    this.batchSize = batchSize;
    this.flushInterval = setInterval(() => this.flush(), flushIntervalMs);
  }

  track(event) {
    this.batch.push({
      ...event,
      clientTimestamp: Date.now(),
      url: window.location.href,
    });
    if (this.batch.length >= this.batchSize) {
      this.flush();
    }
  }

  async flush() {
    if (this.batch.length === 0) return;
    const events = [...this.batch];
    this.batch = [];

    try {
      await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
      });
    } catch (err) {
      // Re-queue on failure (bounded)
      this.batch = [...events.slice(-50), ...this.batch];
    }
  }
}

export const engagementSender = new EngagementBatchSender("/api/v1/engagement");
```

Server-side aggregation for free tier:

```python
# services/engagement_aggregator.py
from collections import defaultdict
from sqlalchemy import func

def compute_clip_engagement_score(session, clip_id: str, window_hours: int = 24) -> dict:
    cutoff = datetime.utcnow() - timedelta(hours=window_hours)

    events = (
        session.query(EngagementEvent)
        .filter(
            EngagementEvent.clip_id == clip_id,
            EngagementEvent.timestamp >= cutoff,
        )
        .all()
    )

    if not events:
        return {"score": 0.0, "sample_size": 0, "confidence": 0.0}

    total_weight = sum(e.weight for e in events)
    unique_users = len(set(e.user_id for e in events))
    avg_weight = total_weight / len(events)

    # Confidence increases with sample size (sigmoid curve)
    import math
    confidence = 1 / (1 + math.exp(-0.01 * (unique_users - 50)))

    return {
        "score": max(0.0, min(1.0, (avg_weight + 0.5))),  # normalize to [0, 1]
        "sample_size": len(events),
        "unique_users": unique_users,
        "confidence": confidence,
    }
```

### Production: Kafka Stream Processing

```python
# services/engagement_stream_processor.py
from kafka import KafkaConsumer
import json
from collections import defaultdict
import time

class EngagementStreamProcessor:
    def __init__(self, bootstrap_servers: list[str], window_seconds: int = 300):
        self.consumer = KafkaConsumer(
            "engagement-events",
            bootstrap_servers=bootstrap_servers,
            group_id="engagement-processor",
            value_deserializer=lambda m: json.loads(m),
        )
        self.window_seconds = window_seconds
        self.windows: dict[str, list] = defaultdict(list)

    def process(self):
        for message in self.consumer:
            event = message.value
            clip_id = event["clip_id"]
            now = time.time()

            # Expire old events
            self.windows[clip_id] = [
                e for e in self.windows[clip_id]
                if now - e["timestamp_epoch"] < self.window_seconds
            ]

            self.windows[clip_id].append(event)

            # Trigger aggregation when window has enough events
            if len(self.windows[clip_id]) >= 100:
                self._flush_window(clip_id)

    def _flush_window(self, clip_id: str):
        events = self.windows.pop(clip_id, [])
        score = self._aggregate(events)
        self._emit_score(clip_id, score)

    def _aggregate(self, events: list) -> float:
        if not events:
            return 0.0
        weights = [EngagementEvent(**e).weight for e in events]
        return sum(weights) / len(weights)

    def _emit_score(self, clip_id: str, score: float):
        from kafka import KafkaProducer
        producer = KafkaProducer(
            bootstrap_servers=self.consumer.config["bootstrap_servers"],
            value_serializer=lambda v: json.dumps(v).encode(),
        )
        producer.send("clip-scores", value={"clip_id": clip_id, "score": score, "ts": time.time()})
        producer.flush()
```

---

## Loop 2: Quality Rating (Explicit)

Users can rate clip quality on a 1-5 scale. This is lower volume but higher signal per event.

### API Endpoint

```python
# api/v1/ratings.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/v1/ratings")

class RatingRequest(BaseModel):
    clip_id: str
    score: int = Field(ge=1, le=5)
    reason: str | None = Field(None, max_length=500)
    tags: list[str] = Field(default_factory=list)  # ["too_short", "wrong_moment", "bad_cut"]

@router.post("/")
async def submit_rating(req: RatingRequest, user=Depends(get_current_user)):
    from services.db import get_session
    from models.clip_rating import ClipRating

    with get_session() as session:
        rating = ClipRating(
            clip_id=req.clip_id,
            user_id=user.id,
            score=req.score,
            reason=req.reason,
            tags=req.tags,
        )
        session.add(rating)
        session.commit()

        # Emit to feedback pipeline
        from services.engagement_tracker import publish_event
        publish_event({
            "type": "quality_rating",
            "clip_id": req.clip_id,
            "score": req.score,
            "tags": req.tags,
            "model_version": get_active_model_version("clipper"),
        })

    return {"status": "ok"}
```

### Rating Aggregation for Training

```python
# services/rating_aggregator.py
def build_rating_training_data(session, min_ratings: int = 5) -> list[dict]:
    """Convert explicit ratings into fine-tuning examples for the clipper model."""

    from sqlalchemy import func

    clips_with_ratings = (
        session.query(
            ClipRating.clip_id,
            func.avg(ClipRating.score).label("avg_score"),
            func.count(ClipRating.id).label("rating_count"),
        )
        .group_by(ClipRating.clip_id)
        .having(func.count(ClipRating.id) >= min_ratings)
        .all()
    )

    training_data = []
    for clip in clips_with_ratings:
        clip_data = session.query(Clip).get(clip.clip_id)
        if not clip_data:
            continue

        # High-rated clips become positive examples
        if clip.avg_score >= 4.0:
            training_data.append({
                "messages": [
                    {"role": "system", "content": CLIPPER_SYSTEM_PROMPT},
                    {"role": "user", "content": f"Find the best moment in this transcript:\n{clip_data.transcript}"},
                    {"role": "assistant", "content": json.dumps({
                        "start": clip_data.start_time,
                        "end": clip_data.end_time,
                        "reason": clip_data.generation_reason,
                    })},
                ]
            })
        # Low-rated clips with specific tags become negative examples with corrections
        elif clip.avg_score <= 2.0:
            training_data.append({
                "messages": [
                    {"role": "system", "content": CLIPPER_SYSTEM_PROMPT},
                    {"role": "user", "content": f"Find the best moment in this transcript:\n{clip_data.transcript}"},
                    {"role": "assistant", "content": json.dumps({
                        "start": clip_data.start_time,
                        "end": clip_data.end_time,
                        "avoid": True,
                        "failure_reasons": get_aggregated_tags(clip.clip_id),
                    })},
                ]
            })

    return training_data
```

---

## Loop 3: Creator Correction (Production Only)

Content creators who upload videos can directly correct clip boundaries. This is the highest-quality signal because creators know their content best.

### Correction API

```python
# api/v1/corrections.py
from pydantic import BaseModel
from datetime import timedelta

class ClipCorrection(BaseModel):
    original_clip_id: str
    corrected_start_ms: int
    corrected_end_ms: int
    reason: str  # "better_hook", "wrong_boundary", "missing_context", "too_long"
    approved: bool  # True = creator approves this clip with corrections, False = reject entirely

@router.post("/api/v1/corrections/")
async def submit_correction(req: ClipCorrection, creator=Depends(get_creator)):
    original = await get_clip(req.original_clip_id)
    if original.video.creator_id != creator.id:
        raise HTTPException(403, "Only the video creator can correct clips")

    correction = CreatorCorrection(
        original_clip_id=req.original_clip_id,
        corrected_start_ms=req.corrected_start_ms,
        corrected_end_ms=req.corrected_end_ms,
        reason=req.reason,
        approved=req.approved,
        creator_id=creator.id,
    )

    await save_correction(correction)

    if req.approved:
        # Create a new "golden" clip from the correction
        golden_clip = Clip(
            video_id=original.video_id,
            start_time=req.corrected_start_ms,
            end_time=req.corrected_end_ms,
            source="creator_correction",
            parent_clip_id=req.original_clip_id,
        )
        await save_clip(golden_clip)

        # Emit high-weight training signal
        await emit_training_signal({
            "type": "creator_correction",
            "original": {"start": original.start_time, "end": original.end_time},
            "corrected": {"start": req.corrected_start_ms, "end": req.corrected_end_ms},
            "reason": req.reason,
            "weight": 2.0,  # Creator corrections weighted 2x vs user feedback
        })

    return {"status": "ok", "golden_clip_id": golden_clip.id if req.approved else None}
```

### Correction-Driven Fine-Tuning

```python
# services/correction_trainer.py
def build_correction_dataset(session, min_corrections: int = 20) -> str:
    """Build a high-quality dataset from creator corrections."""

    corrections = (
        session.query(CreatorCorrection)
        .filter(CreatorCorrection.approved == True)
        .all()
    )

    examples = []
    for corr in corrections:
        original = session.query(Clip).get(corr.original_clip_id)
        video = session.query(Video).get(original.video_id)

        # Pair: same input, but corrected output
        examples.append({
            "messages": [
                {"role": "system", "content": CLIPPER_SYSTEM_PROMPT},
                {"role": "user", "content": f"Find the most engaging clip from:\n{video.transcript}"},
                {
                    "role": "assistant",
                    "content": json.dumps({
                        "start_ms": corr.corrected_start_ms,
                        "end_ms": corr.corrected_end_ms,
                        "reasoning": f"Creator correction: {corr.reason}",
                    }),
                },
            ]
        })

    output_path = f"/data/training/corrections_{datetime.utcnow().strftime('%Y%m%d')}.jsonl"
    with open(output_path, "w") as f:
        for ex in examples:
            f.write(json.dumps(ex) + "\n")

    return output_path
```

---

## Loop 4: Semantic Drift Detection (Production Only)

Over time, the distribution of content changes. A model trained on 2024 gaming content will degrade on 2026 political commentary. This loop detects distribution shifts and triggers retraining.

### Embedding Distribution Monitoring

```python
# services/drift_detector.py
import numpy as np
from scipy.spatial.distance import cosine
from sklearn.cluster import MiniBatchKMeans

class SemanticDriftDetector:
    def __init__(self, reference_embeddings_path: str, n_clusters: int = 50):
        self.reference_embeddings = np.load(reference_embeddings_path)
        self.reference_kmeans = MiniBatchKMeans(n_clusters=n_clusters)
        self.reference_kmeans.fit(self.reference_embeddings)
        self.reference_distribution = self._cluster_distribution(self.reference_embeddings)

    def _cluster_distribution(self, embeddings: np.ndarray) -> np.ndarray:
        labels = self.reference_kmeans.predict(embeddings)
        dist = np.bincount(labels, minlength=self.reference_kmeans.n_clusters)
        return dist / dist.sum()

    def detect_drift(self, new_embeddings: np.ndarray, threshold: float = 0.15) -> dict:
        new_distribution = self._cluster_distribution(new_embeddings)

        # Jensen-Shannon divergence
        from scipy.spatial.distance import jensenshannon
        js_divergence = jensenshannon(self.reference_distribution, new_distribution)

        # Per-cluster drift
        cluster_drift = np.abs(new_distribution - self.reference_distribution)
        drifted_clusters = np.where(cluster_drift > 0.05)[0]

        return {
            "js_divergence": float(js_divergence),
            "is_drifting": js_divergence > threshold,
            "drifted_clusters": drifted_clusters.tolist(),
            "new_distribution": new_distribution.tolist(),
            "reference_distribution": self.reference_distribution.tolist(),
        }
```

### Drift-Triggered Retraining

```python
# services/drift_retrainer.py
async def monitor_and_retrain(poll_interval_hours: int = 24):
    detector = SemanticDriftDetector("/data/reference/embeddings.npy")

    while True:
        # Fetch recent content embeddings
        recent = await fetch_recent_embeddings(hours=48)
        if len(recent) < 100:
            await asyncio.sleep(poll_interval_hours * 3600)
            continue

        drift_result = detector.detect_drift(np.array(recent))

        if drift_result["is_drifting"]:
            logger.warning(f"Semantic drift detected: JS={drift_result['js_divergence']:.4f}")

            # Trigger retraining pipeline
            await trigger_retraining({
                "reason": "semantic_drift",
                "drift_score": drift_result["js_divergence"],
                "drifted_clusters": drift_result["drifted_clusters"],
            })

            # Update reference distribution
            detector.reference_distribution = drift_result["new_distribution"]

        await asyncio.sleep(poll_interval_hours * 3600)
```

---

## Feedback Loop Interaction

The four loops interact. Engagement signals validate quality ratings. Creator corrections override engagement signals when they conflict. Semantic drift can invalidate all accumulated feedback if the content domain shifts.

### Priority Resolution

```python
# services/feedback_resolver.py
def resolve_conflicting_signals(clip_id: str, session) -> dict:
    """When loops disagree, determine the authoritative signal."""

    engagement = compute_clip_engagement_score(session, clip_id)
    rating = get_aggregate_rating(session, clip_id)
    correction = get_creator_correction(session, clip_id)

    # Creator corrections always win
    if correction and correction.approved:
        return {
            "signal": "creator_approved",
            "weight": 2.0,
            "start_ms": correction.corrected_start_ms,
            "end_ms": correction.corrected_end_ms,
        }

    if correction and not correction.approved:
        return {"signal": "creator_rejected", "weight": -2.0}

    # Explicit ratings override engagement when available
    if rating and rating["count"] >= 5:
        if rating["avg"] <= 2.0:
            return {"signal": "low_quality", "weight": -1.0}
        if rating["avg"] >= 4.0:
            return {"signal": "high_quality", "weight": 1.5}

    # Fall back to engagement
    if engagement["confidence"] > 0.8:
        return {"signal": "engagement", "weight": engagement["score"]}

    return {"signal": "insufficient_data", "weight": 0.0}
```

---

## Configuration

All feedback loops are configurable per deployment:

```yaml
# config/feedback_loops.yml
feedback_loops:
  engagement:
    enabled: true
    collection_interval_ms: 5000
    batch_size: 10
    weight_multipliers:
      play: 0.1
      complete: 0.4
      replay: 0.6
      save: 0.8
      share: 1.0
      skip: -0.3

  quality_rating:
    enabled: true
    min_ratings_for_signal: 5
    rating_weight: 1.2

  creator_correction:
    enabled: true  # production only
    correction_weight: 2.0
    auto_approve_threshold: null  # null = always require manual approval

  drift_detection:
    enabled: true  # production only
    poll_interval_hours: 24
    js_divergence_threshold: 0.15
    min_embeddings_for_detection: 100
    auto_retrain: false  # true = retrain without human approval
```

---

## Benchmark Integration

Each of the four feedback loops feeds directly into Anthropic benchmark tracking. The loops produce raw signals; the benchmark system aggregates them into measurable improvement rates against Anthropic's published targets (80% code-writing autonomy, 76% task success, 33% bug catch rate, 64% taste preference).

### How Feedback Loops Feed Benchmarks

Engagement feedback (Loop 1) and quality ratings (Loop 2) generate the training data that drives the code-writing autonomy metric — clips that achieve high engagement without human edits count toward the 80% target. Creator corrections (Loop 3) provide the ground truth for taste preference tracking — when the AI clip matches the creator's correction, it registers as an AI preference win. Semantic drift detection (Loop 4) triggers retraining cycles that are measured as task success/failure events.

```python
# services/benchmark_aggregator.py
from datetime import datetime, timedelta
from dataclasses import dataclass

@dataclass
class BenchmarkSnapshot:
    metric_name: str
    current_value: float
    target_value: float
    trend_7d: float  # rate of change over 7 days
    trend_30d: float
    projected_target_date: datetime | None
    status: str  # "above_target", "approaching", "below", "degrading"

def compute_improvement_rate(
    session,
    metric_name: str,
    window_days: int = 30,
) -> dict:
    cutoff = datetime.utcnow() - timedelta(days=window_days)
    midpoint = datetime.utcnow() - timedelta(days=window_days // 2)

    first_half = _query_metric(session, metric_name, cutoff, midpoint)
    second_half = _query_metric(session, metric_name, midpoint, datetime.utcnow())

    if not first_half or not second_half:
        return {"rate": 0.0, "direction": "unknown", "sample_size": 0}

    delta = second_half - first_half
    daily_rate = delta / (window_days / 2)

    return {
        "rate": daily_rate,
        "direction": "improving" if delta > 0 else "degrading" if delta < 0 else "stable",
        "first_half_value": first_half,
        "second_half_value": second_half,
        "delta": delta,
        "projected_30d": second_half + daily_rate * 30,
    }

def _query_metric(session, metric_name: str, start: datetime, end: datetime) -> float:
    from sqlalchemy import func

    queries = {
        "code_writing": lambda: session.query(
            func.sum(AgentCodeWritingMetric.lines_accepted_unchanged) /
            func.nullif(func.sum(AgentCodeWritingMetric.total_lines_generated), 0)
        ).filter(
            AgentCodeWritingMetric.created_at.between(start, end)
        ).scalar(),
        "task_success": lambda: session.query(
            func.sum(func.cast(TaskSuccessMetric.success, Float)) / func.count()
        ).filter(
            TaskSuccessMetric.created_at.between(start, end)
        ).scalar(),
        "bug_catch": lambda: session.query(
            func.sum(func.cast(BugCatchMetric.caught_by == "ai_review", Float)) / func.count()
        ).filter(
            BugCatchMetric.created_at.between(start, end)
        ).scalar(),
        "taste_preference": lambda: session.query(
            func.sum(func.cast(TastePreferenceMetric.preferred == "ai", Float)) /
            func.nullif(func.sum(func.cast(
                TastePreferenceMetric.preferred.in_(["ai", "human"]), Float
            )), 0)
        ).filter(
            TastePreferenceMetric.created_at.between(start, end)
        ).scalar(),
    }
    return queries.get(metric_name, lambda: 0.0)() or 0.0

BENCHMARK_TARGETS = {
    "code_writing": 0.80,
    "task_success": 0.76,
    "bug_catch": 0.33,
    "taste_preference": 0.64,
}

def compute_all_benchmarks(session) -> list[BenchmarkSnapshot]:
    snapshots = []
    for metric_name, target in BENCHMARK_TARGETS.items():
        current = _query_metric(session, metric_name, datetime.utcnow() - timedelta(days=7), datetime.utcnow())
        rate_info = compute_improvement_rate(session, metric_name)

        if current >= target:
            status = "above_target"
        elif current >= target * 0.9:
            status = "approaching"
        elif rate_info["direction"] == "degrading":
            status = "degrading"
        else:
            status = "below"

        projected_date = None
        if rate_info["rate"] > 0 and current < target:
            days_to_target = (target - current) / rate_info["rate"]
            projected_date = datetime.utcnow() + timedelta(days=days_to_target)

        snapshots.append(BenchmarkSnapshot(
            metric_name=metric_name,
            current_value=current,
            target_value=target,
            trend_7d=rate_info.get("delta", 0),
            trend_30d=rate_info.get("projected_30d", 0),
            projected_target_date=projected_date,
            status=status,
        ))
    return snapshots
```

### Improvement Rate Alerts

When benchmark improvement stalls or degrades, the system alerts operators and pauses non-critical model promotions:

```python
# services/benchmark_alerter.py
async def check_benchmark_health(session) -> list[dict]:
    snapshots = compute_all_benchmarks(session)
    alerts = []

    for snap in snapshots:
        if snap.status == "degrading":
            alerts.append({
                "severity": "critical",
                "metric": snap.metric_name,
                "message": f"{snap.metric_name} degrading: {snap.current_value:.1%} (target: {snap.target_value:.1%})",
                "action": "block_promotions",
            })
        elif snap.status == "below" and snap.projected_target_date and snap.projected_target_date > datetime.utcnow() + timedelta(days=90):
            alerts.append({
                "severity": "warning",
                "metric": snap.metric_name,
                "message": f"{snap.metric_name} below target with >90d projection: {snap.current_value:.1%}",
                "action": "review_training_data",
            })

    if alerts:
        await send_alerts(alerts)

    return alerts
```

---

## Summary

Engagement feedback provides high-volume implicit signals. Quality ratings add explicit supervision. Creator corrections provide domain-expert overrides. Semantic drift detection ensures the model stays calibrated to current content. Together, these four loops create a self-correcting system where every user interaction improves the next clip generation. The benchmark integration layer aggregates loop signals into Anthropic-aligned metrics with improvement rate tracking and automated alerts when progress stalls.
