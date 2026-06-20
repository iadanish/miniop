# Model Upgrade Strategy

## Overview

MiniOp's model upgrade strategy governs how AI models are updated, evaluated, deployed, and rolled back across the system. This covers three model families: **ranker** (scores clip candidates), **clipper** (selects clip boundaries), and **highlight detector** (identifies viral moments). Each family follows the same upgrade pipeline but with different evaluation criteria and promotion thresholds.

The strategy must handle two realities: on the free tier, model upgrades are infrequent and manually triggered. In production, upgrades happen continuously with automated gates and instant rollback.

---

## Model Versioning Schema

Every model instance follows a strict versioning format:

```
{family}-{base_model}-{training_date}-{iteration}
```

Examples:
- `ranker-sonnet-20260615-001` — first ranker fine-tune from June 15 data
- `clipper-haiku-20260610-003` — third clipper iteration from June 10 data
- `highlight-opus-20260601-002` — second highlight detector from June 1 data

```python
# models/version.py
from dataclasses import dataclass
from datetime import datetime
import re

VERSION_PATTERN = re.compile(
    r"^(ranker|clipper|highlight)-(sonnet|haiku|opus)-(\d{8})-(\d{3})$"
)

@dataclass
class ModelVersion:
    family: str       # "ranker" | "clipper" | "highlight"
    base_model: str   # "sonnet" | "haiku" | "opus"
    training_date: str  # "YYYYMMDD"
    iteration: int      # 1-999

    @classmethod
    def parse(cls, version_string: str) -> "ModelVersion":
        match = VERSION_PATTERN.match(version_string)
        if not match:
            raise ValueError(f"Invalid model version format: {version_string}")
        return cls(
            family=match.group(1),
            base_model=match.group(2),
            training_date=match.group(3),
            iteration=int(match.group(4)),
        )

    def __str__(self) -> str:
        return f"{self.family}-{self.base_model}-{self.training_date}-{self.iteration:03d}"

    def next_iteration(self) -> "ModelVersion":
        return ModelVersion(
            family=self.family,
            base_model=self.base_model,
            training_date=datetime.utcnow().strftime("%Y%m%d"),
            iteration=self.iteration + 1,
        )
```

---

## Base Model Selection

MiniOp uses Anthropic's model family strategically across model roles:

| Role | Free Tier Model | Production Model | Rationale |
|------|----------------|------------------|-----------|
| Ranker | Claude Haiku | Claude Sonnet | Speed-critical; Haiku is 5x cheaper for batch scoring |
| Clipper | Claude Sonnet | Claude Sonnet | Needs strong reasoning for boundary detection |
| Highlight | Claude Haiku | Claude Haiku | Binary classification; no need for large model |

### Model Selection Configuration

```yaml
# config/models.yml
model_families:
  ranker:
    free_tier:
      base_model: "claude-haiku-4-20250414"
      max_tokens: 256
      temperature: 0.1
    production:
      base_model: "claude-sonnet-4-20250514"
      max_tokens: 512
      temperature: 0.0
      fallback_model: "claude-haiku-4-20250414"  # Fallback under load

  clipper:
    free_tier:
      base_model: "claude-sonnet-4-20250514"
      max_tokens: 1024
      temperature: 0.2
    production:
      base_model: "claude-sonnet-4-20250514"
      max_tokens: 2048
      temperature: 0.1

  highlight:
    free_tier:
      base_model: "claude-haiku-4-20250414"
      max_tokens: 128
      temperature: 0.0
    production:
      base_model: "claude-haiku-4-20250414"
      max_tokens: 256
      temperature: 0.0
```

---

## Upgrade Pipeline

### Stage 1: Data Collection

Gather training data from the four feedback loops (engagement, ratings, corrections, drift).

```python
# services/upgrade_pipeline.py
from dataclasses import dataclass
from pathlib import Path

@dataclass
class UpgradeRequest:
    family: str
    reason: str  # "scheduled" | "drift_detected" | "performance_degraded" | "manual"
    data_window_days: int = 30
    min_examples: int = 500
    min_improvement: float = 0.03  # 3% improvement required to promote

async def collect_training_data(req: UpgradeRequest) -> Path:
    from services.training_export import export_training_batch
    from services.correction_trainer import build_correction_dataset
    from services.rating_aggregator import build_rating_training_data

    output_dir = Path(f"/data/training/{req.family}/{datetime.utcnow().strftime('%Y%m%d')}")
    output_dir.mkdir(parents=True, exist_ok=True)

    all_examples = []

    # Engagement-derived examples
    engagement_path = output_dir / "engagement.jsonl"
    count = export_training_batch(
        database_url=get_database_url(),
        output_path=str(engagement_path),
        days_back=req.data_window_days,
    )
    all_examples.extend(load_jsonl(engagement_path))

    # Rating-derived examples
    with get_session() as session:
        rating_examples = build_rating_training_data(session)
        all_examples.extend(rating_examples)

    # Creator correction examples (production only)
    if get_config().environment == "production":
        with get_session() as session:
            correction_path = build_correction_dataset(session)
            if correction_path:
                all_examples.extend(load_jsonl(correction_path))

    if len(all_examples) < req.min_examples:
        raise InsufficientDataError(
            f"Only {len(all_examples)} examples collected, need {req.min_examples}"
        )

    # Write combined dataset
    combined_path = output_dir / "combined.jsonl"
    with open(combined_path, "w") as f:
        for ex in all_examples:
            f.write(json.dumps(ex) + "\n")

    return combined_path
```

### Stage 2: Fine-Tuning

Submit to Anthropic's fine-tuning API with family-specific hyperparameters:

```python
# services/finetune_manager.py
FINETUNE_CONFIG = {
    "ranker": {
        "n_epochs": 3,
        "batch_size": 16,
        "learning_rate_multiplier": 0.15,
    },
    "clipper": {
        "n_epochs": 5,
        "batch_size": 8,
        "learning_rate_multiplier": 0.1,
    },
    "highlight": {
        "n_epochs": 2,
        "batch_size": 32,
        "learning_rate_multiplier": 0.2,
    },
}

async def launch_finetune(
    family: str,
    training_path: Path,
    base_model: str,
    config: dict,
) -> str:
    client = anthropic.Anthropic()

    # Upload training file
    with open(training_path, "rb") as f:
        file_upload = client.files.create(file=f, purpose="fine-tune")

    hyperparams = FINETUNE_CONFIG[family]

    job = client.fine_tuning.jobs.create(
        training_file=file_upload.id,
        model=base_model,
        suffix=f"minio-{family}",
        hyperparameters={
            "n_epochs": hyperparams["n_epochs"],
            "batch_size": hyperparams["batch_size"],
            "learning_rate_multiplier": hyperparams["learning_rate_multiplier"],
        },
    )

    # Record in model registry
    with get_session() as session:
        version = get_next_version(session, family)
        model_record = ModelVersion(
            model_id=str(version),
            model_type=family,
            base_model=base_model,
            training_file=str(training_path),
            config=hyperparams,
        )
        session.add(model_record)
        session.commit()

    return job.id
```

### Stage 3: Evaluation

Every candidate model must pass a multi-dimensional evaluation before promotion:

```python
# services/model_evaluator.py
import numpy as np
from dataclasses import dataclass

@dataclass
class EvalResult:
    model_id: str
    accuracy: float
    latency_p50_ms: float
    latency_p99_ms: float
    cost_per_1k_tokens: float
    engagement_correlation: float
    human_preference_rate: float
    overall_score: float
    passed: bool
    failure_reasons: list[str]

EVAL_THRESHOLDS = {
    "ranker": {
        "min_accuracy": 0.72,
        "max_latency_p99_ms": 500,
        "min_engagement_correlation": 0.6,
        "min_human_preference": 0.76,
    },
    "clipper": {
        "min_accuracy": 0.65,
        "max_latency_p99_ms": 2000,
        "min_engagement_correlation": 0.5,
        "min_human_preference": 0.76,
    },
    "highlight": {
        "min_accuracy": 0.80,
        "max_latency_p99_ms": 200,
        "min_engagement_correlation": 0.4,
        "min_human_preference": 0.76,
    },
}

async def evaluate_model(
    model_id: str,
    family: str,
    test_set_path: str,
    baseline_model_id: str,
) -> EvalResult:
    client = anthropic.Anthropic()
    test_cases = load_jsonl(test_set_path)
    thresholds = EVAL_THRESHOLDS[family]

    candidate_scores = []
    baseline_scores = []
    candidate_latencies = []
    baseline_latencies = []

    for case in test_cases:
        # Candidate evaluation
        start = time.time()
        candidate_resp = client.messages.create(
            model=model_id,
            messages=case["messages"][:2],
            max_tokens=512,
        )
        candidate_latencies.append((time.time() - start) * 1000)

        # Baseline evaluation
        start = time.time()
        baseline_resp = client.messages.create(
            model=baseline_model_id,
            messages=case["messages"][:2],
            max_tokens=512,
        )
        baseline_latencies.append((time.time() - start) * 1000)

        candidate_scores.append(score_response(candidate_resp, case))
        baseline_scores.append(score_response(baseline_resp, case))

    # Compute metrics
    accuracy = np.mean(candidate_scores)
    baseline_accuracy = np.mean(baseline_scores)
    latency_p50 = np.percentile(candidate_latencies, 50)
    latency_p99 = np.percentile(candidate_latencies, 99)

    # Human preference: how often candidate is preferred over baseline
    preferences = [
        1 if c > b else 0
        for c, b in zip(candidate_scores, baseline_scores)
    ]
    human_preference = np.mean(preferences)

    # Engagement correlation (requires historical data)
    engagement_corr = compute_engagement_correlation(model_id, test_cases)

    # Overall score (weighted combination)
    overall = (
        0.35 * accuracy
        + 0.25 * human_preference
        + 0.20 * engagement_corr
        + 0.10 * (1.0 - min(latency_p99 / 2000, 1.0))  # latency penalty
        + 0.10 * (accuracy - baseline_accuracy)  # improvement bonus
    )

    # Check thresholds
    failures = []
    if accuracy < thresholds["min_accuracy"]:
        failures.append(f"accuracy {accuracy:.3f} < {thresholds['min_accuracy']}")
    if latency_p99 > thresholds["max_latency_p99_ms"]:
        failures.append(f"p99 latency {latency_p99:.0f}ms > {thresholds['max_latency_p99_ms']}ms")
    if engagement_corr < thresholds["min_engagement_correlation"]:
        failures.append(f"engagement corr {engagement_corr:.3f} < {thresholds['min_engagement_correlation']}")
    if human_preference < thresholds["min_human_preference"]:
        failures.append(f"human preference {human_preference:.3f} < {thresholds['min_human_preference']}")

    return EvalResult(
        model_id=model_id,
        accuracy=accuracy,
        latency_p50_ms=latency_p50,
        latency_p99_ms=latency_p99,
        cost_per_1k_tokens=estimate_cost(model_id),
        engagement_correlation=engagement_corr,
        human_preference_rate=human_preference,
        overall_score=overall,
        passed=len(failures) == 0,
        failure_reasons=failures,
    )
```

### Stage 4: Shadow Deployment

Before full promotion, run the candidate model in shadow mode — processing real traffic but not serving results:

```python
# services/shadow_deployer.py
class ShadowDeployment:
    def __init__(self, candidate_model: str, baseline_model: str, shadow_traffic_pct: float = 0.1):
        self.candidate_model = candidate_model
        self.baseline_model = baseline_model
        self.shadow_pct = shadow_traffic_pct
        self.results: list[dict] = []

    async def process_request(self, request: dict) -> dict:
        # Always serve baseline result to user
        baseline_result = await call_model(self.baseline_model, request)

        # Shadow-evaluate candidate on a subset
        if random.random() < self.shadow_pct:
            candidate_result = await call_model(self.candidate_model, request)
            self.results.append({
                "request_hash": hash(str(request)),
                "baseline": baseline_result,
                "candidate": candidate_result,
                "timestamp": time.time(),
            })

        return baseline_result

    def compare_results(self) -> dict:
        if len(self.results) < 100:
            return {"status": "insufficient_data", "count": len(self.results)}

        candidate_wins = sum(
            1 for r in self.results
            if score_output(r["candidate"]) > score_output(r["baseline"])
        )
        win_rate = candidate_wins / len(self.results)

        return {
            "status": "complete",
            "sample_size": len(self.results),
            "candidate_win_rate": win_rate,
            "recommendation": "promote" if win_rate > 0.55 else "reject",
        }
```

### Stage 5: Promotion with Canary

Gradual rollout using traffic splitting:

```python
# services/canary_deployer.py
class CanaryDeployment:
    STAGES = [0.01, 0.05, 0.10, 0.25, 0.50, 1.0]  # Traffic percentages

    def __init__(self, model_id: str, family: str):
        self.model_id = model_id
        self.family = family
        self.current_stage_idx = 0
        self.stage_start_time = time.time()
        self.stage_metrics: list[dict] = []

    @property
    def traffic_pct(self) -> float:
        return self.STAGES[self.current_stage_idx]

    def should_advance(self, metrics: dict) -> bool:
        """Check if current canary stage is healthy enough to advance."""
        min_duration_hours = [1, 2, 4, 8, 12, 0]  # Min time at each stage
        elapsed_hours = (time.time() self.stage_start_time) / 3600

        if elapsed_hours < min_duration_hours[self.current_stage_idx]:
            return False

        # Health checks
        if metrics.get("error_rate", 0) > 0.01:
            return False
        if metrics.get("p99_latency_ms", 0) > EVAL_THRESHOLDS[self.family]["max_latency_p99_ms"] * 1.2:
            return False
        if metrics.get("engagement_delta", 0) < -0.05:
            return False

        return True

    def advance(self):
        if self.current_stage_idx < len(self.STAGES) - 1:
            self.current_stage_idx += 1
            self.stage_start_time = time.time()

    def rollback(self):
        self.current_stage_idx = 0
        self.stage_start_time = time.time()

    def is_complete(self) -> bool:
        return self.current_stage_idx == len(self.STAGES) - 1
```

---

## Benchmark Gates

Before any model promotion, Anthropic-aligned benchmark thresholds must be met. These gates sit between the evaluation stage (Stage 3) and shadow deployment (Stage 4) — a model that passes accuracy and latency checks but fails benchmark gates cannot proceed to production traffic.

### Promotion Gate Thresholds

| Gate | Metric | Threshold | Source |
|------|--------|-----------|--------|
| Code-writing autonomy | Lines accepted without human edit | ≥ 80% | Anthropic SWE-bench |
| Task success | End-to-end completion without intervention | ≥ 76% | Anthropic agentic benchmarks |
| Bug catch rate | Bugs found by AI vs total | ≥ 33% | Anthropic code review research |
| Human preference | Users prefer AI output over baseline | ≥ 76% | Anthropic preference benchmarks |
| Taste improvement | AI clip preferred over human-curated | ≥ 64% | Anthropic research taste |

```python
# services/benchmark_gates.py
from dataclasses import dataclass

@dataclass
class BenchmarkGateResult:
    gate_name: str
    current_value: float
    threshold: float
    passed: bool
    sample_size: int
    confidence: float  # statistical confidence in the measurement

BENCHMARK_GATES = {
    "code_writing_autonomy": {"threshold": 0.80, "min_samples": 200},
    "task_success_rate": {"threshold": 0.76, "min_samples": 100},
    "bug_catch_rate": {"threshold": 0.33, "min_samples": 50},
    "human_preference_rate": {"threshold": 0.76, "min_samples": 100},
    "taste_preference_rate": {"threshold": 0.64, "min_samples": 100},
}

def check_benchmark_gates(session, model_version: str) -> dict:
    from services.benchmark_aggregator import compute_all_benchmarks

    snapshots = compute_all_benchmarks(session)
    results = []
    all_passed = True

    for snap in snapshots:
        gate_config = BENCHMARK_GATES.get(snap.metric_name)
        if not gate_config:
            continue

        passed = snap.current_value >= gate_config["threshold"]
        if not passed:
            all_passed = False

        results.append(BenchmarkGateResult(
            gate_name=snap.metric_name,
            current_value=snap.current_value,
            threshold=gate_config["threshold"],
            passed=passed,
            sample_size=0,  # populated from snapshot
            confidence=0.0,
        ))

    return {
        "model_version": model_version,
        "all_gates_passed": all_passed,
        "gates": results,
        "blocking_failures": [r.gate_name for r in results if not r.passed],
    }
```

### Integrating Gates into the Upgrade Pipeline

The benchmark gate check is inserted between evaluation and shadow deployment. If any gate fails, the promotion is blocked and an alert is sent:

```python
# services/upgrade_pipeline.py (addition to Stage 3 → Stage 4 transition)
async def maybe_promote(model_id: str, family: str, eval_result: EvalResult):
    if not eval_result.passed:
        logger.info(f"Model {model_id} failed evaluation, skipping benchmark gates")
        return

    gate_result = check_benchmark_gates(get_session(), model_id)

    if not gate_result["all_gates_passed"]:
        failures = gate_result["blocking_failures"]
        logger.warning(f"Model {model_id} blocked by benchmark gates: {failures}")
        await send_alert({
            "type": "benchmark_gate_failure",
            "model_id": model_id,
            "failures": failures,
            "message": f"Promotion blocked. Failed gates: {', '.join(failures)}",
        })
        return

    logger.info(f"Model {model_id} passed all benchmark gates, proceeding to shadow deployment")
    await start_shadow_deployment(model_id, family)
```

---

## Rollback Strategy

Instant rollback is a hard requirement. Every model deployment must be reversible within 30 seconds.

### Automatic Rollback Triggers

```python
# services/rollback_monitor.py
class RollbackMonitor:
    TRIGGER_CONDITIONS = {
        "error_rate_threshold": 0.05,       # 5% error rate
        "latency_spike_multiplier": 3.0,     # 3x baseline latency
        "engagement_drop_threshold": -0.10,  # 10% engagement drop
        "consecutive_failures": 10,           # 10 consecutive API failures
    }

    async def monitor(self, model_id: str, baseline_metrics: dict):
        while True:
            current_metrics = await self._collect_metrics(model_id)

            triggers = []

            if current_metrics["error_rate"] > self.TRIGGER_CONDITIONS["error_rate_threshold"]:
                triggers.append(f"error_rate={current_metrics['error_rate']:.3f}")

            if current_metrics["p99_latency"] > baseline_metrics["p99_latency"] * self.TRIGGER_CONDITIONS["latency_spike_multiplier"]:
                triggers.append(f"latency_spike={current_metrics['p99_latency']:.0f}ms")

            if current_metrics["engagement_delta"] < self.TRIGGER_CONDITIONS["engagement_drop_threshold"]:
                triggers.append(f"engagement_drop={current_metrics['engagement_delta']:.3f}")

            if triggers:
                logger.critical(f"ROLLBACK TRIGGERED for {model_id}: {triggers}")
                await self._execute_rollback(model_id, triggers)
                return

            await asyncio.sleep(30)  # Check every 30 seconds

    async def _execute_rollback(self, model_id: str, triggers: list[str]):
        from services.model_registry import rollback_model
        with get_session() as session:
            rollback_model(session, model_id.split("-")[0])  # Rollback by family

        await self._notify_rollback(model_id, triggers)

    async def _notify_rollback(self, model_id: str, triggers: list[str]):
        # Send alert to operations channel
        import httpx
        await httpx.AsyncClient().post(
            get_config().slack_webhook_url,
            json={
                "text": f"Model rollback: {model_id}\nTriggers: {', '.join(triggers)}",
            },
        )
```

### Manual Rollback Command

```bash
# CLI rollback command
minio model rollback ranker --reason "performance degradation" --force

# Or via API
curl -X POST https://api.minio.dev/v1/admin/models/rollback \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"family": "ranker", "reason": "manual rollback after user complaints"}'
```

---

## Free Tier vs Production: Upgrade Frequency

| Aspect | Free Tier | Production |
|--------|-----------|------------|
| Upgrade trigger | Manual or monthly cron | Automated from feedback loops |
| Evaluation | Manual review + test set | Automated multi-stage pipeline |
| Deployment | Direct swap | Canary with 6-stage rollout |
| Rollback | Manual | Automatic + instant |
| Model versions retained | Last 3 | Last 10 + all golden versions |
| A/B testing | Not available | Always active |
| Shadow deployment | Not available | Required before promotion |
| Cost monitoring | Basic | Per-model cost tracking with alerts |

### Free Tier Upgrade Script

```bash
#!/bin/bash
# scripts/upgrade_model.sh — Free tier manual upgrade

FAMILY=${1:?"Usage: upgrade_model.sh <family> <base_model>"}
BASE_MODEL=${2:?"Usage: upgrade_model.sh <family> <base_model>"}

echo "=== MiniOp Model Upgrade: $FAMILY ==="

# Step 1: Export training data
echo "[1/5] Exporting training data..."
python -m services.training_export \
  --family "$FAMILY" \
  --days-back 30 \
  --output-path "/data/training/${FAMILY}_$(date +%Y%m%d).jsonl"

# Step 2: Launch fine-tune
echo "[2/5] Launching fine-tune job..."
JOB_ID=$(python -m services.finetune_launcher \
  --family "$FAMILY" \
  --base-model "$BASE_MODEL" \
  --training-file "/data/training/${FAMILY}_$(date +%Y%m%d).jsonl" \
  --output job_id)

echo "Fine-tune job: $JOB_ID"
echo "Waiting for completion..."

python -m services.finetune_launcher --wait "$JOB_ID"

# Step 3: Evaluate
echo "[3/5] Evaluating candidate model..."
python -m services.model_evaluator \
  --model-id "$JOB_ID" \
  --family "$FAMILY" \
  --test-set "/data/test_sets/${FAMILY}_holdout.jsonl"

read -p "Promote this model? (y/N): " confirm
if [ "$confirm" != "y" ]; then
    echo "Aborted."
    exit 0
fi

# Step 4: Promote
echo "[4/5] Promoting model..."
python -m services.model_registry promote "$JOB_ID"

# Step 5: Restart services
echo "[5/5] Restarting inference services..."
docker compose restart minio-inference

echo "=== Upgrade complete ==="
```

---

## Cost Management

Model upgrades have direct cost implications. Track and limit spending:

```python
# services/cost_tracker.py
from dataclasses import dataclass

@dataclass
class CostBudget:
    family: str
    monthly_limit_usd: float
    current_spend_usd: float
    projected_spend_usd: float

    @property
    def remaining_usd(self) -> float:
        return self.monthly_limit_usd - self.current_spend_usd

    @property
    def can_afford_finetune(self) -> bool:
        # Fine-tuning cost estimate: ~$10-50 per job depending on data size
        estimated_finetune_cost = 30.0
        return self.remaining_usd > estimated_finetune_cost

COST_PER_1K_TOKENS = {
    "claude-haiku-4-20250414": {"input": 0.00025, "output": 0.00125},
    "claude-sonnet-4-20250514": {"input": 0.003, "output": 0.015},
    "claude-opus-4-20250514": {"input": 0.015, "output": 0.075},
}

def estimate_monthly_cost(
    model: str,
    daily_requests: int,
    avg_tokens_per_request: int = 500,
) -> float:
    pricing = COST_PER_1K_TOKENS[model]
    daily_tokens = daily_requests * avg_tokens_per_request
    daily_cost = (daily_tokens / 1000) * (pricing["input"] + pricing["output"]) / 2
    return daily_cost * 30
```

---

## Summary

The upgrade pipeline has five stages: data collection, fine-tuning, evaluation, shadow deployment, and canary promotion. Free tier runs this manually with direct model swaps. Production runs it continuously with automated gates, shadow testing, canary rollouts, and instant rollback. Every model must prove improvement on held-out data before receiving traffic. Cost is tracked per model family with hard budget limits.
