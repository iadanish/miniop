# Self-Improvement Flow

## Overview

MiniOp's self-improvement pipeline is a closed-loop system where clip generation output feeds back into model fine-tuning, prompt refinement, and ranking heuristics. The system operates on two tiers: a **free tier** using batch inference and delayed feedback cycles, and a **scaled production tier** with real-time online learning and continuous deployment of improved models.

The core principle: every clip MiniOp produces is a training signal. User actions (saves, shares, skips, replays) are implicit labels. The self-improvement flow converts these implicit labels into explicit model upgrades without human annotation.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    MiniOp Self-Improvement Loop              │
│                                                             │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐              │
│  │ Ingest   │───▶│ Ranker   │───▶│ Clipper  │              │
│  │ Pipeline  │    │ Model vN │    │ Model vN │              │
│  └──────────┘    └──────────┘    └──────────┘              │
│       │               │               │                     │
│       │               ▼               ▼                     │
│       │         ┌──────────┐    ┌──────────┐               │
│       │         │ User     │    │ Analytics│               │
│       │         │ Feedback │    │ Pipeline │               │
│       │         └────┬─────┘    └────┬─────┘               │
│       │              │               │                      │
│       │              ▼               ▼                      │
│       │         ┌──────────────────────┐                    │
│       │         │ Training Data        │                    │
│       │         │ Aggregator           │                    │
│       │         └──────────┬───────────┘                    │
│       │                    │                                │
│       │                    ▼                                │
│       │         ┌──────────────────────┐                    │
│       │         │ Fine-Tune Pipeline   │                    │
│       │         │ (Anthropic / OpenAI) │                    │
│       │         └──────────┬───────────┘                    │
│       │                    │                                │
│       │                    ▼                                │
│       │         ┌──────────────────────┐                    │
│       └────────▶│ Model Registry       │                    │
│                 │ (vN+1 promotion)     │                    │
│                 └──────────────────────┘                    │
└─────────────────────────────────────────────────────────────┘
```

---

## Free Tier Implementation

### Feedback Collection

On the free tier, feedback is collected asynchronously via webhook callbacks from the frontend. No real-time stream processing — just batched event writes to PostgreSQL.

```python
# services/feedback_collector.py
from datetime import datetime
from enum import Enum
from sqlalchemy import Column, String, DateTime, Float, Integer, Enum as SAEnum
from sqlalchemy.ext.declarative import declarative_base

Base = declarative_base()

class UserAction(Enum):
    WATCHED_FULL = "watched_full"
    SKIPPED = "skipped"
    SAVED = "saved"
    SHARED = "shared"
    REPLAYED = "replayed"
    EXPORTED = "exported"

class ClipFeedback(Base):
    """Model training feedback schema.

    NOTE: ClipFeedback is the training-data view of user engagement. It
    aggregates per-clip-per-user actions into a single record suitable for
    fine-tuning export. For the real-time user-behavior tracking schema
    (event-level, higher granularity), see EngagementEvent in
    02-feedback-loops.md. Both schemas capture overlapping data but serve
    different purposes: ClipFeedback → model training, EngagementEvent →
    analytics and A/B testing.
    """
    __tablename__ = "clip_feedback"

    id = Column(String, primary_key=True)
    clip_id = Column(String, index=True, nullable=False)
    user_id = Column(String, index=True, nullable=False)
    action = Column(SAEnum(UserAction), nullable=False)
    watch_duration_ms = Column(Integer)
    total_duration_ms = Column(Integer)
    model_version = Column(String, nullable=False)
    prompt_version = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    @property
    def engagement_score(self) -> float:
        if self.action == UserAction.SKIPPED:
            return 0.0
        if self.action in (UserAction.SHARED, UserAction.EXPORTED):
            return 1.0
        if self.watch_duration_ms and self.total_duration_ms:
            return min(self.watch_duration_ms / self.total_duration_ms, 1.0)
        return 0.5
```

### Batch Training Data Export

Free tier runs a nightly cron job to export feedback data as JSONL for fine-tuning:

```python
# services/training_export.py
import json
from datetime import datetime, timedelta
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

def export_training_batch(
    database_url: str,
    output_path: str,
    days_back: int = 7,
    min_engagement: float = 0.6,
):
    engine = create_engine(database_url)
    Session = sessionmaker(bind=engine)
    session = Session()

    cutoff = datetime.utcnow() - timedelta(days=days_back)
    feedbacks = (
        session.query(ClipFeedback)
        .filter(ClipFeedback.created_at >= cutoff)
        .all()
    )

    training_examples = []
    for fb in feedbacks:
        if fb.engagement_score < min_engagement:
            continue
        training_examples.append({
            "messages": [
                {
                    "role": "system",
                    "content": "You are a video clip ranker. Score clips by viral potential.",
                },
                {
                    "role": "user",
                    "content": f"Rate this clip segment from video {fb.clip_id}.",
                },
                {
                    "role": "assistant",
                    "content": json.dumps({
                        "score": fb.engagement_score,
                        "model_version": fb.model_version,
                    }),
                },
            ]
        })

    with open(output_path, "w") as f:
        for ex in training_examples:
            f.write(json.dumps(ex) + "\n")

    return len(training_examples)
```

Run this via a scheduled task:

```bash
# Crontab (free tier — single server)
0 2 * * * cd /opt/minio && python -m services.training_export \
  --database-url postgresql://minio:password@localhost:5432/minio \
  --output-path /data/training/$(date +\%Y-\%m-\%d).jsonl \
  --days-back 7
```

### Fine-Tuning with Anthropic

Submit the exported JSONL to Anthropic's fine-tuning API:

```python
# services/finetune_launcher.py
import anthropic

def launch_finetune(
    training_file_path: str,
    model_name: str = "claude-sonnet-4-20250514",
    suffix: str = "minio-ranker",
):
    client = anthropic.Anthropic()

    with open(training_file_path, "rb") as f:
        upload = client.files.create(file=f, purpose="fine-tune")

    job = client.fine_tuning.jobs.create(
        training_file=upload.id,
        model=model_name,
        suffix=suffix,
        hyperparameters={
            "n_epochs": 3,
            "batch_size": 8,
            "learning_rate_multiplier": 0.2,
        },
    )
    return job.id
```

### Model Promotion Gate

Before deploying a fine-tuned model, validate it against a held-out test set:

```python
# services/model_evaluator.py
def evaluate_model(
    model_id: str,
    test_set_path: str,
    baseline_model: str = "claude-sonnet-4-20250514",
    min_improvement: float = 0.03,
) -> dict:
    client = anthropic.Anthropic()
    test_cases = load_jsonl(test_set_path)

    baseline_scores = []
    candidate_scores = []

    for case in test_cases:
        baseline_resp = client.messages.create(
            model=baseline_model,
            messages=case["messages"][:2],
            max_tokens=256,
        )
        candidate_resp = client.messages.create(
            model=model_id,
            messages=case["messages"][:2],
            max_tokens=256,
        )
        baseline_scores.append(score_response(baseline_resp, case))
        candidate_scores.append(score_response(candidate_resp, case))

    baseline_avg = sum(baseline_scores) / len(baseline_scores)
    candidate_avg = sum(candidate_scores) / len(candidate_scores)
    improvement = candidate_avg - baseline_avg

    return {
        "baseline_score": baseline_avg,
        "candidate_score": candidate_avg,
        "improvement": improvement,
        "promote": improvement >= min_improvement,
    }
```

---

## Scaled Production Tier

### Real-Time Feedback Stream

In production, feedback events flow through Kafka instead of direct DB writes:

```yaml
# docker-compose.kafka.yml
services:
  kafka:
    image: confluentinc/cp-kafka:7.6.0
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_NUM_PARTITIONS: 12
      KAFKA_DEFAULT_REPLICATION_FACTOR: 1
      KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092
    ports:
      - "9092:9092"
```

```python
# services/stream_feedback.py
from kafka import KafkaProducer, KafkaConsumer
import json

producer = KafkaProducer(
    bootstrap_servers=["kafka:9092"],
    value_serializer=lambda v: json.dumps(v).encode(),
)

def publish_feedback(event: dict):
    producer.send("clip-feedback", value=event)
    producer.flush()

def consume_feedback_batch(group_id: str, batch_size: int = 1000):
    consumer = KafkaConsumer(
        "clip-feedback",
        bootstrap_servers=["kafka:9092"],
        group_id=group_id,
        auto_offset_reset="earliest",
        max_poll_records=batch_size,
    )
    batch = []
    for message in consumer:
        batch.append(json.loads(message.value))
        if len(batch) >= batch_size:
            yield batch
            batch = []
    if batch:
        yield batch
```

### Online Learning Pipeline

Production uses a continuous training loop with model A/B testing:

```python
# services/online_trainer.py
import asyncio
from dataclasses import dataclass

@dataclass
class ModelCandidate:
    model_id: str
    traffic_split: float  # 0.0 to 1.0
    eval_window_hours: int = 24
    min_sample_size: int = 500

async def run_ab_test(candidate: ModelCandidate, baseline: str):
    from services.stream_feedback import consume_feedback_batch

    baseline_engagement = []
    candidate_engagement = []

    async for batch in consume_feedback_batch(group_id="ab-test-evaluator"):
        for event in batch:
            if event["model_version"] == baseline:
                baseline_engagement.append(event["engagement_score"])
            elif event["model_version"] == candidate.model_id:
                candidate_engagement.append(event["engagement_score"])

        if len(candidate_engagement) >= candidate.min_sample_size:
            break

    from scipy import stats
    t_stat, p_value = stats.ttest_ind(baseline_engagement, candidate_engagement)
    candidate_mean = sum(candidate_engagement) / len(candidate_engagement)
    baseline_mean = sum(baseline_engagement) / len(baseline_engagement)

    return {
        "candidate_mean": candidate_mean,
        "baseline_mean": baseline_mean,
        "p_value": p_value,
        "promote": p_value < 0.05 and candidate_mean > baseline_mean,
        "samples": len(candidate_engagement),
    }
```

### Model Registry

All model versions are tracked in a registry with rollback capability:

```python
# services/model_registry.py
from sqlalchemy import Column, String, DateTime, Boolean, Float, JSON
from datetime import datetime

class ModelVersion(Base):
    __tablename__ = "model_registry"

    model_id = Column(String, primary_key=True)
    model_type = Column(String, nullable=False)  # "ranker" | "clipper" | "highlight"
    base_model = Column(String, nullable=False)
    training_file = Column(String)
    eval_score = Column(Float)
    is_active = Column(Boolean, default=False)
    config = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow)
    activated_at = Column(DateTime)
    deactivated_at = Column(DateTime)

def promote_model(session, model_id: str):
    model = session.query(ModelVersion).get(model_id)
    if not model or not model.eval_score:
        raise ValueError(f"Model {model_id} not found or not evaluated")

    current = (
        session.query(ModelVersion)
        .filter_by(model_type=model.model_type, is_active=True)
        .first()
    )
    if current:
        current.is_active = False
        current.deactivated_at = datetime.utcnow()

    model.is_active = True
    model.activated_at = datetime.utcnow()
    session.commit()

def rollback_model(session, model_type: str):
    current = (
        session.query(ModelVersion)
        .filter_by(model_type=model_type, is_active=True)
        .first()
    )
    previous = (
        session.query(ModelVersion)
        .filter_by(model_type=model_type)
        .order_by(ModelVersion.activated_at.desc())
        .offset(1)
        .first()
    )
    if not previous:
        raise ValueError("No previous model to rollback to")

    current.is_active = False
    current.deactivated_at = datetime.utcnow()
    previous.is_active = True
    previous.activated_at = datetime.utcnow()
    session.commit()
```

### Infrastructure as Code

Production model training runs on dedicated GPU instances via Terraform:

```hcl
# infra/training.tf
resource "aws_instance" "training_node" {
  ami           = "ami-0abcdef1234567890"
  instance_type = "g5.2xlarge"

  tags = {
    Name        = "minio-training-${var.environment}"
    Environment = var.environment
    Purpose     = "model-finetuning"
  }

  root_block_device {
    volume_size = 200
    volume_type = "gp3"
  }

  user_data = templatefile("${path.module}/scripts/setup_training.sh", {
    anthropic_api_key = var.anthropic_api_key
    database_url      = var.database_url
  })
}
```

---

## Improvement Metrics

Track these metrics to measure self-improvement velocity:

| Metric | Free Tier Target | Production Target |
|--------|-----------------|-------------------|
| Feedback-to-training lag | 7 days | < 4 hours |
| Model evaluation cycles | 1/week | Continuous |
| Clip engagement improvement | +3% per quarter | +1% per week |
| False positive rate (bad clips promoted) | < 5% | < 1% |
| Rollback frequency | < 1/month | < 1/week |

---

## Anthropic Benchmark Tracking

Anthropic's published benchmarks set the target ceiling for autonomous agent performance. MiniOp tracks four key metrics aligned with these benchmarks to measure self-improvement velocity and ensure the system approaches human-level capability before claiming autonomous operation.

### Agent Code-Writing Rate (Target: 80%+)

Anthropic's SWE-bench results show Claude achieving 80%+ on code-writing tasks. MiniOp tracks the percentage of generated clip code, metadata, and deployment configs produced autonomously (without human edits) versus requiring manual correction.

```python
# services/benchmark_tracker.py
from sqlalchemy import Column, String, DateTime, Float, Integer, Boolean
from datetime import datetime

class AgentCodeWritingMetric(Base):
    __tablename__ = "agent_code_writing_metrics"

    id = Column(String, primary_key=True)
    task_id = Column(String, index=True, nullable=False)
    agent_type = Column(String, nullable=False)  # "clipper", "ranker", "deploy"
    total_lines_generated = Column(Integer, nullable=False)
    lines_accepted_unchanged = Column(Integer, nullable=False)
    lines_edited_by_human = Column(Integer, nullable=False)
    autonomy_rate = Column(Float, nullable=False)  # accepted / total
    model_version = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

def compute_autonomy_rate(session, agent_type: str, window_days: int = 30) -> float:
    cutoff = datetime.utcnow() - timedelta(days=window_days)
    metrics = (
        session.query(AgentCodeWritingMetric)
        .filter(
            AgentCodeWritingMetric.agent_type == agent_type,
            AgentCodeWritingMetric.created_at >= cutoff,
        )
        .all()
    )
    if not metrics:
        return 0.0
    total_lines = sum(m.total_lines_generated for m in metrics)
    accepted_lines = sum(m.lines_accepted_unchanged for m in metrics)
    return accepted_lines / total_lines if total_lines > 0 else 0.0
```

### Task Success Rates (Target: 76%+)

Anthropic benchmarks show Claude achieving 76%+ on complex agentic tasks. MiniOp tracks end-to-end task success across the clip pipeline — from video ingestion through deployment — measuring how often a task completes without human intervention.

```python
# services/task_success_tracker.py
class TaskSuccessMetric(Base):
    __tablename__ = "task_success_metrics"

    id = Column(String, primary_key=True)
    task_type = Column(String, nullable=False)  # "full_pipeline", "clip_gen", "deploy"
    success = Column(Boolean, nullable=False)
    required_human_intervention = Column(Boolean, default=False)
    failure_stage = Column(String)  # NULL on success
    failure_reason = Column(String)
    model_version = Column(String, nullable=False)
    latency_ms = Column(Integer)
    created_at = Column(DateTime, default=datetime.utcnow)

def compute_task_success_rate(session, task_type: str, window_days: int = 30) -> dict:
    cutoff = datetime.utcnow() - timedelta(days=window_days)
    tasks = (
        session.query(TaskSuccessMetric)
        .filter(
            TaskSuccessMetric.task_type == task_type,
            TaskSuccessMetric.created_at >= cutoff,
        )
        .all()
    )
    if not tasks:
        return {"success_rate": 0.0, "autonomous_rate": 0.0, "sample_size": 0}
    successes = sum(1 for t in tasks if t.success)
    autonomous = sum(1 for t in tasks if t.success and not t.required_human_intervention)
    return {
        "success_rate": successes / len(tasks),
        "autonomous_rate": autonomous / len(tasks),
        "sample_size": len(tasks),
        "p50_latency_ms": sorted(t.latency_ms for t in tasks)[len(tasks) // 2],
    }
```

### Bug Catch Rate (Target: 33%+)

Anthropic's research shows Claude catching 33%+ of bugs in code review. MiniOp tracks how many bugs the automated PR review agents catch before human review — measured against bugs found later in production or by humans.

```python
# services/bug_catch_tracker.py
class BugCatchMetric(Base):
    __tablename__ = "bug_catch_metrics"

    id = Column(String, primary_key=True)
    bug_id = Column(String, index=True, nullable=False)
    caught_by = Column(String, nullable=False)  # "ai_review", "human_review", "production"
    severity = Column(String, nullable=False)  # "critical", "high", "medium", "low"
    pr_number = Column(Integer)
    agent_type = Column(String)  # "code-quality", "security-audit"
    model_version = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)

def compute_bug_catch_rate(session, window_days: int = 30) -> dict:
    cutoff = datetime.utcnow() - timedelta(days=window_days)
    bugs = (
        session.query(BugCatchMetric)
        .filter(BugCatchMetric.created_at >= cutoff)
        .all()
    )
    if not bugs:
        return {"catch_rate": 0.0, "total_bugs": 0}
    ai_caught = sum(1 for b in bugs if b.caught_by == "ai_review")
    return {
        "catch_rate": ai_caught / len(bugs),
        "total_bugs": len(bugs),
        "ai_caught": ai_caught,
        "human_caught": sum(1 for b in bugs if b.caught_by == "human_review"),
        "production_found": sum(1 for b in bugs if b.caught_by == "production"),
    }
```

### Research Taste Improvement (51% → 64% Better Than Human)

Anthropic's research taste benchmark shows Claude improving from 51% to 64% preference over human judgment. MiniOp tracks human preference rates on clip selection — how often users prefer AI-generated clips over manually curated alternatives.

```python
# services/taste_tracker.py
class TastePreferenceMetric(Base):
    __tablename__ = "taste_preference_metrics"

    id = Column(String, primary_key=True)
    video_id = Column(String, index=True, nullable=False)
    ai_clip_id = Column(String, nullable=False)
    human_clip_id = Column(String, nullable=False)
    user_id = Column(String, nullable=False)
    preferred = Column(String, nullable=False)  # "ai" | "human" | "equal"
    model_version = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

def compute_taste_preference_rate(session, window_days: int = 30) -> dict:
    cutoff = datetime.utcnow() - timedelta(days=window_days)
    prefs = (
        session.query(TastePreferenceMetric)
        .filter(TastePreferenceMetric.created_at >= cutoff)
        .all()
    )
    if not prefs:
        return {"ai_preference_rate": 0.0, "sample_size": 0}
    ai_wins = sum(1 for p in prefs if p.preferred == "ai")
    human_wins = sum(1 for p in prefs if p.preferred == "human")
    total = ai_wins + human_wins
    return {
        "ai_preference_rate": ai_wins / total if total > 0 else 0.0,
        "human_preference_rate": human_wins / total if total > 0 else 0.0,
        "equal_rate": sum(1 for p in prefs if p.preferred == "equal") / len(prefs),
        "sample_size": len(prefs),
    }
```

### SQL Schema

```sql
-- migrations/benchmark_tracking.sql
CREATE TABLE agent_code_writing_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id VARCHAR(64) NOT NULL,
    agent_type VARCHAR(32) NOT NULL,
    total_lines_generated INT NOT NULL,
    lines_accepted_unchanged INT NOT NULL,
    lines_edited_by_human INT NOT NULL,
    autonomy_rate FLOAT NOT NULL,
    model_version VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE task_success_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_type VARCHAR(32) NOT NULL,
    success BOOLEAN NOT NULL,
    required_human_intervention BOOLEAN DEFAULT FALSE,
    failure_stage VARCHAR(32),
    failure_reason TEXT,
    model_version VARCHAR(64) NOT NULL,
    latency_ms INT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE bug_catch_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bug_id VARCHAR(64) NOT NULL,
    caught_by VARCHAR(32) NOT NULL,
    severity VARCHAR(16) NOT NULL,
    pr_number INT,
    agent_type VARCHAR(32),
    model_version VARCHAR(64),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE taste_preference_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id VARCHAR(64) NOT NULL,
    ai_clip_id VARCHAR(64) NOT NULL,
    human_clip_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    preferred VARCHAR(16) NOT NULL,
    model_version VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_code_writing_agent_type ON agent_code_writing_metrics(agent_type, created_at);
CREATE INDEX idx_task_success_type ON task_success_metrics(task_type, created_at);
CREATE INDEX idx_bug_catch_created ON bug_catch_metrics(created_at);
CREATE INDEX idx_taste_pref_created ON taste_preference_metrics(created_at);
```

### Dashboard Queries

```sql
-- Weekly benchmark dashboard
SELECT
    'Agent Code-Writing %' AS metric,
    ROUND(SUM(lines_accepted_unchanged)::numeric / NULLIF(SUM(total_lines_generated), 0) * 100, 1) AS current_pct,
    80.0 AS target_pct,
    CASE WHEN SUM(lines_accepted_unchanged)::float / NULLIF(SUM(total_lines_generated), 0) >= 0.80 THEN 'PASS' ELSE 'FAIL' END AS status
FROM agent_code_writing_metrics
WHERE created_at >= NOW() - INTERVAL '7 days'
UNION ALL
SELECT
    'Task Success Rate %',
    ROUND(SUM(CASE WHEN success THEN 1 ELSE 0 END)::numeric / COUNT(*) * 100, 1),
    76.0,
    CASE WHEN SUM(CASE WHEN success THEN 1 ELSE 0 END)::float / COUNT(*) >= 0.76 THEN 'PASS' ELSE 'FAIL' END
FROM task_success_metrics
WHERE created_at >= NOW() - INTERVAL '7 days'
UNION ALL
SELECT
    'Bug Catch Rate %',
    ROUND(SUM(CASE WHEN caught_by = 'ai_review' THEN 1 ELSE 0 END)::numeric / COUNT(*) * 100, 1),
    33.0,
    CASE WHEN SUM(CASE WHEN caught_by = 'ai_review' THEN 1 ELSE 0 END)::float / COUNT(*) >= 0.33 THEN 'PASS' ELSE 'FAIL' END
FROM bug_catch_metrics
WHERE created_at >= NOW() - INTERVAL '7 days'
UNION ALL
SELECT
    'AI Taste Preference %',
    ROUND(SUM(CASE WHEN preferred = 'ai' THEN 1 ELSE 0 END)::numeric / NULLIF(SUM(CASE WHEN preferred IN ('ai', 'human') THEN 1 ELSE 0 END), 0) * 100, 1),
    64.0,
    CASE WHEN SUM(CASE WHEN preferred = 'ai' THEN 1 ELSE 0 END)::float / NULLIF(SUM(CASE WHEN preferred IN ('ai', 'human') THEN 1 ELSE 0 END), 0) >= 0.64 THEN 'PASS' ELSE 'FAIL' END
FROM taste_preference_metrics
WHERE created_at >= NOW() - INTERVAL '7 days';
```

---

## Summary

The self-improvement flow converts user behavior into model upgrades. Free tier uses batch exports and manual promotion gates. Production uses streaming feedback, A/B testing, and automated promotion with rollback. Both tiers enforce evaluation before deployment — no model reaches users without proving improvement on held-out data. Anthropic's benchmark targets (80% code-writing, 76% task success, 33% bug catch, 64% taste preference) provide measurable thresholds for autonomous operation.
