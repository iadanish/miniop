# MiniOp Circuit Breaker Implementation

## Why Circuit Breakers

MiniOp depends on external services: AI inference endpoints, cloud storage backends, and payment processors. When one of these services fails, continuing to send requests wastes resources, fills queues, and degrades the entire system. A circuit breaker detects failures and stops traffic to failing services, allowing them to recover while MiniOp serves degraded but functional responses.

## Circuit Breaker States

```
         ┌──────────────────────────────────────────────────┐
         │                                                  │
         ▼                                                  │
   ┌───────────┐   failure_threshold    ┌───────────┐      │
   │  CLOSED   │───────────────────────▶│   OPEN    │      │
   │ (normal)  │                        │ (blocked) │      │
   └───────────┘                        └─────┬─────┘      │
         ▲                                    │             │
         │              success_threshold      │             │
         │              ┌─────────────┐        │             │
         └──────────────│ HALF-OPEN   │◀───────┘             │
           success      │  (probe)    │  timeout             │
                        └─────────────┘─────────────────────┘
```

## Core Implementation

```python
# minio/circuit_breaker.py
import time
import threading
import logging
from enum import Enum
from dataclasses import dataclass, field
from typing import Callable, Optional
from contextlib import contextmanager

logger = logging.getLogger("minio.circuit_breaker")

class CircuitState(Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"

@dataclass
class CircuitBreakerConfig:
    failure_threshold: int = 5
    success_threshold: int = 3
    timeout: float = 30.0
    half_open_max_calls: int = 1
    excluded_exceptions: tuple = ()

@dataclass
class CircuitBreakerStats:
    failures: int = 0
    successes: int = 0
    consecutive_failures: int = 0
    consecutive_successes: int = 0
    last_failure_time: float = 0
    last_success_time: float = 0
    total_calls: int = 0
    rejected_calls: int = 0
    state_transitions: list = field(default_factory=list)

class CircuitBreaker:
    def __init__(self, name: str, config: CircuitBreakerConfig = None):
        self.name = name
        self.config = config or CircuitBreakerConfig()
        self.state = CircuitState.CLOSED
        self.stats = CircuitBreakerStats()
        self._lock = threading.RLock()
        self._half_open_calls = 0
    
    def call(self, func: Callable, *args, **kwargs):
        with self._lock:
            if self.state == CircuitState.OPEN:
                if self._should_attempt_reset():
                    self._transition_to(CircuitState.HALF_OPEN)
                else:
                    self.stats.rejected_calls += 1
                    raise CircuitOpenError(
                        f"Circuit breaker '{self.name}' is OPEN. "
                        f"Retry after {self._time_until_retry():.0f}s"
                    )
            
            if self.state == CircuitState.HALF_OPEN:
                if self._half_open_calls >= self.config.half_open_max_calls:
                    self.stats.rejected_calls += 1
                    raise CircuitOpenError(
                        f"Circuit breaker '{self.name}' is HALF_OPEN. "
                        f"Probe in progress."
                    )
                self._half_open_calls += 1
        
        try:
            result = func(*args, **kwargs)
            self._on_success()
            return result
        except Exception as e:
            if isinstance(e, self.config.excluded_exceptions):
                raise
            self._on_failure(e)
            raise
    
    def _on_success(self):
        with self._lock:
            self.stats.successes += 1
            self.stats.total_calls += 1
            self.stats.consecutive_successes += 1
            self.stats.consecutive_failures = 0
            self.stats.last_success_time = time.time()
            
            if self.state == CircuitState.HALF_OPEN:
                if self.stats.consecutive_successes >= self.config.success_threshold:
                    self._transition_to(CircuitState.CLOSED)
                    self._half_open_calls = 0
    
    def _on_failure(self, error: Exception):
        with self._lock:
            self.stats.failures += 1
            self.stats.total_calls += 1
            self.stats.consecutive_failures += 1
            self.stats.consecutive_successes = 0
            self.stats.last_failure_time = time.time()
            
            if self.state == CircuitState.HALF_OPEN:
                self._transition_to(CircuitState.OPEN)
                self._half_open_calls = 0
            elif self.state == CircuitState.CLOSED:
                if self.stats.consecutive_failures >= self.config.failure_threshold:
                    self._transition_to(CircuitState.OPEN)
    
    def _should_attempt_reset(self) -> bool:
        return time.time() - self.stats.last_failure_time >= self.config.timeout
    
    def _time_until_retry(self) -> float:
        elapsed = time.time() - self.stats.last_failure_time
        return max(0, self.config.timeout - elapsed)
    
    def _transition_to(self, new_state: CircuitState):
        old_state = self.state
        self.state = new_state
        self.stats.state_transitions.append({
            "from": old_state.value,
            "to": new_state.value,
            "time": time.time(),
        })
        logger.warning(
            f"Circuit breaker '{self.name}': {old_state.value} -> {new_state.value}",
            extra={
                "circuit": self.name,
                "old_state": old_state.value,
                "new_state": new_state.value,
                "failures": self.stats.consecutive_failures,
                "total_failures": self.stats.failures,
            }
        )
    
    def get_state(self) -> dict:
        with self._lock:
            return {
                "name": self.name,
                "state": self.state.value,
                "failures": self.stats.failures,
                "successes": self.stats.successes,
                "consecutive_failures": self.stats.consecutive_failures,
                "total_calls": self.stats.total_calls,
                "rejected_calls": self.stats.rejected_calls,
                "last_failure": self.stats.last_failure_time,
                "time_until_retry": self._time_until_retry() if self.state == CircuitState.OPEN else 0,
            }
    
    def reset(self):
        with self._lock:
            self.state = CircuitState.CLOSED
            self.stats = CircuitBreakerStats()
            self._half_open_calls = 0
            logger.info(f"Circuit breaker '{self.name}' manually reset")


class CircuitOpenError(Exception):
    pass
```

## Circuit Breaker Registry

```python
# minio/circuit_breakers.py
from minio.circuit_breaker import CircuitBreaker, CircuitBreakerConfig

# AI Inference — most likely to fail, aggressive breaker
AI_INFERENCE_CB = CircuitBreaker(
    name="ai_inference",
    config=CircuitBreakerConfig(
        failure_threshold=3,
        success_threshold=2,
        timeout=60.0,
        half_open_max_calls=1,
    ),
)

# Primary storage — critical path, conservative breaker
STORAGE_PRIMARY_CB = CircuitBreaker(
    name="storage_primary",
    config=CircuitBreakerConfig(
        failure_threshold=10,
        success_threshold=5,
        timeout=30.0,
        half_open_max_calls=2,
    ),
)

# Backup storage — secondary path, moderate breaker
STORAGE_BACKUP_CB = CircuitBreaker(
    name="storage_backup",
    config=CircuitBreakerConfig(
        failure_threshold=5,
        success_threshold=3,
        timeout=45.0,
        half_open_max_calls=1,
    ),
)

# Webhook delivery — non-critical, lenient breaker
WEBHOOK_CB = CircuitBreaker(
    name="webhook_delivery",
    config=CircuitBreakerConfig(
        failure_threshold=10,
        success_threshold=3,
        timeout=120.0,
        half_open_max_calls=1,
    ),
)

# Payment processor — critical, conservative
PAYMENT_CB = CircuitBreaker(
    name="payment_processor",
    config=CircuitBreakerConfig(
        failure_threshold=3,
        success_threshold=2,
        timeout=60.0,
        half_open_max_calls=1,
    ),
)

REGISTRY = {
    "ai_inference": AI_INFERENCE_CB,
    "storage_primary": STORAGE_PRIMARY_CB,
    "storage_backup": STORAGE_BACKUP_CB,
    "webhook_delivery": WEBHOOK_CB,
    "payment_processor": PAYMENT_CB,
}
```

## Integration with Services

### AI Inference with Circuit Breaker

```python
# minio/services/ai_service.py
import httpx
from minio.circuit_breakers import AI_INFERENCE_CB
from minio.circuit_breaker import CircuitOpenError
from minio.errors import APIError, ErrorCode

class AIService:
    def __init__(self, base_url: str, fallback_url: str = None):
        self.primary_url = base_url
        self.fallback_url = fallback_url
        self.client = httpx.Client(timeout=120)
    
    def extract_clips(self, video_url: str, options: dict) -> dict:
        try:
            return AI_INFERENCE_CB.call(
                self._call_inference, self.primary_url, video_url, options
            )
        except CircuitOpenError:
            if self.fallback_url:
                return self._call_fallback(video_url, options)
            raise APIError(
                code=ErrorCode.AI_SERVICE_UNAVAILABLE,
                message="AI service circuit breaker open, no fallback available",
                status=503,
                retryable=True,
                retry_after=60,
            )
    
    def _call_inference(self, base_url: str, video_url: str, options: dict) -> dict:
        response = self.client.post(
            f"{base_url}/v1/extract-clips",
            json={"video_url": video_url, **options},
        )
        if response.status_code >= 500:
            raise Exception(f"Inference error: {response.status_code}")
        response.raise_for_status()
        return response.json()
    
    def _call_fallback(self, video_url: str, options: dict) -> dict:
        try:
            return self._call_inference(self.fallback_url, video_url, options)
        except Exception:
            raise APIError(
                code=ErrorCode.AI_SERVICE_UNAVAILABLE,
                message="Both primary and fallback AI services unavailable",
                status=503,
                retryable=True,
                retry_after=120,
            )
```

### Storage with Circuit Breaker

```python
# minio/services/storage.py
import boto3
from botocore.exceptions import EndpointConnectionError, ClientError
from minio.circuit_breakers import STORAGE_PRIMARY_CB, STORAGE_BACKUP_CB
from minio.circuit_breaker import CircuitOpenError
from minio.errors import APIError, ErrorCode

class StorageService:
    def __init__(self, primary_config: dict, backup_config: dict = None):
        self.primary = boto3.client('s3', **primary_config)
        self.backup = boto3.client('s3', **backup_config) if backup_config else None
    
    def upload(self, bucket: str, key: str, data: bytes, content_type: str):
        try:
            return STORAGE_PRIMARY_CB.call(
                self._do_upload, self.primary, bucket, key, data, content_type
            )
        except CircuitOpenError:
            if self.backup:
                return self._upload_to_backup(bucket, key, data, content_type)
            raise APIError(
                code=ErrorCode.STORAGE_UNAVAILABLE,
                message="Primary storage circuit open, no backup configured",
                status=503,
                retryable=True,
                retry_after=30,
            )
        except (EndpointConnectionError, ClientError) as e:
            if self.backup:
                return self._upload_to_backup(bucket, key, data, content_type)
            raise
    
    def _do_upload(self, client, bucket, key, data, content_type):
        try:
            client.put_object(
                Bucket=bucket, Key=key, Body=data, ContentType=content_type,
            )
        except (EndpointConnectionError, ClientError) as e:
            raise Exception(f"Storage error: {e}")
    
    def _upload_to_backup(self, bucket, key, data, content_type):
        try:
            return STORAGE_BACKUP_CB.call(
                self._do_upload, self.backup, bucket, key, data, content_type
            )
        except CircuitOpenError:
            raise APIError(
                code=ErrorCode.STORAGE_UNAVAILABLE,
                message="Both primary and backup storage unavailable",
                status=503,
                retryable=True,
                retry_after=60,
            )
```

## Monitoring and Alerting

```python
# minio/monitoring/circuit_metrics.py
from prometheus_client import Gauge, Counter
from minio.circuit_breakers import REGISTRY
import time

CIRCUIT_STATE = Gauge(
    'minio_circuit_breaker_state',
    'Circuit breaker state (0=closed, 1=open, 2=half_open)',
    ['circuit']
)

CIRCUIT_FAILURES = Counter(
    'minio_circuit_breaker_failures_total',
    'Total failures per circuit breaker',
    ['circuit']
)

CIRCUIT_REJECTIONS = Counter(
    'minio_circuit_breaker_rejections_total',
    'Total rejected calls per circuit breaker',
    ['circuit']
)

STATE_MAP = {"closed": 0, "open": 1, "half_open": 2}

def update_circuit_metrics():
    for name, cb in REGISTRY.items():
        state = cb.get_state()
        CIRCUIT_STATE.labels(circuit=name).set(STATE_MAP[state["state"]])
        
        if state["state"] == "open":
            send_alert(
                severity="warning",
                message=f"Circuit breaker '{name}' is OPEN. "
                        f"Rejected {state['rejected_calls']} calls."
            )
```

### Alert Rules

```yaml
# prometheus/alerts/circuit_breaker.yml
groups:
- name: circuit-breaker
  rules:
  - alert: CircuitBreakerOpen
    expr: minio_circuit_breaker_state == 1
    for: 1m
    labels:
      severity: warning
    annotations:
      summary: "Circuit breaker {{ $labels.circuit }} is OPEN"
      
  - alert: CircuitBreakerRejectionsHigh
    expr: rate(minio_circuit_breaker_rejections_total[5m]) > 10
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "Circuit breaker {{ $labels.circuit }} rejecting >10 calls/sec"
      
  - alert: CircuitBreakerFlapping
    expr: changes(minio_circuit_breaker_state[10m]) > 5
    labels:
      severity: warning
    annotations:
      summary: "Circuit breaker {{ $labels.circuit }} flapping (state changes >5 in 10m)"
```

## Health Check Endpoint

```python
# minio/api/routes/health.py
from fastapi import APIRouter
from minio.circuit_breakers import REGISTRY

router = APIRouter()

@router.get("/health")
async def health_check():
    circuits = {}
    all_healthy = True
    
    for name, cb in REGISTRY.items():
        state = cb.get_state()
        circuits[name] = state
        if state["state"] == "open":
            all_healthy = False
    
    return {
        "status": "healthy" if all_healthy else "degraded",
        "circuits": circuits,
    }

@router.get("/health/circuits/{name}")
async def circuit_health(name: str):
    if name not in REGISTRY:
        return {"error": f"Unknown circuit: {name}"}, 404
    return REGISTRY[name].get_state()

@router.post("/admin/circuits/{name}/reset")
async def reset_circuit(name: str):
    if name not in REGISTRY:
        return {"error": f"Unknown circuit: {name}"}, 404
    REGISTRY[name].reset()
    return {"status": "reset", "circuit": name}
```

## Free Tier Configuration

The free tier uses the same circuit breaker code with more conservative settings since there's no fallback infrastructure:

```python
# minio/config.py
def get_circuit_config():
    tier = os.getenv("MINIO_TIER", "free")
    
    if tier == "free":
        return {
            "ai_inference": CircuitBreakerConfig(
                failure_threshold=2,  # Fail fast
                success_threshold=2,
                timeout=120.0,  # Wait longer before retry
            ),
            "storage_primary": CircuitBreakerConfig(
                failure_threshold=5,
                success_threshold=3,
                timeout=60.0,
            ),
        }
    else:
        return {
            "ai_inference": CircuitBreakerConfig(
                failure_threshold=3,
                success_threshold=2,
                timeout=60.0,
            ),
            "storage_primary": CircuitBreakerConfig(
                failure_threshold=10,
                success_threshold=5,
                timeout=30.0,
            ),
            "storage_backup": CircuitBreakerConfig(
                failure_threshold=5,
                success_threshold=3,
                timeout=45.0,
            ),
        }
```

## Testing Circuit Breakers

```python
# tests/test_circuit_breaker.py
import pytest
import time
from minio.circuit_breaker import CircuitBreaker, CircuitBreakerConfig, CircuitOpenError

def test_circuit_opens_after_threshold():
    cb = CircuitBreaker("test", CircuitBreakerConfig(failure_threshold=3, timeout=0.1))
    
    for _ in range(3):
        with pytest.raises(ValueError):
            cb.call(lambda: (_ for _ in ()).throw(ValueError("fail")))
    
    assert cb.state.value == "open"
    
    with pytest.raises(CircuitOpenError):
        cb.call(lambda: "ok")

def test_circuit_half_open_after_timeout():
    cb = CircuitBreaker("test", CircuitBreakerConfig(
        failure_threshold=2, timeout=0.1, success_threshold=2
    ))
    
    for _ in range(2):
        with pytest.raises(ValueError):
            cb.call(lambda: (_ for _ in ()).throw(ValueError("fail")))
    
    time.sleep(0.15)
    
    # Should transition to half-open and allow one call
    result = cb.call(lambda: "ok")
    assert result == "ok"
    assert cb.state.value == "half_open"

def test_circuit_closes_after_success_threshold():
    cb = CircuitBreaker("test", CircuitBreakerConfig(
        failure_threshold=2, timeout=0.01, success_threshold=2
    ))
    
    for _ in range(2):
        with pytest.raises(ValueError):
            cb.call(lambda: (_ for _ in ()).throw(ValueError("fail")))
    
    time.sleep(0.02)
    
    cb.call(lambda: "ok")
    cb.call(lambda: "ok")
    
    assert cb.state.value == "closed"
```
