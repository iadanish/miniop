# MiniOp Retry Logic and Backoff Strategies

## Retry Philosophy

MiniOp processes video files that can take minutes to render. Blindly retrying wastes compute and extends queue times. This document defines retry policies that balance reliability with resource efficiency — retrying transient failures quickly while avoiding wasted work on permanent errors.

## Retry Policy Framework

### Core Retry Decorator

```python
# minio/retry.py
import time
import random
import logging
from functools import wraps
from typing import Callable, Tuple, Type, Optional
from minio.errors import APIError

logger = logging.getLogger("minio.retry")

class RetryPolicy:
    def __init__(
        self,
        max_attempts: int = 3,
        base_delay: float = 1.0,
        max_delay: float = 60.0,
        exponential_base: float = 2.0,
        jitter: bool = True,
        retryable_exceptions: Tuple[Type[Exception], ...] = (Exception,),
        retryable_status_codes: Tuple[int, ...] = (429, 500, 502, 503, 504),
    ):
        self.max_attempts = max_attempts
        self.base_delay = base_delay
        self.max_delay = max_delay
        self.exponential_base = exponential_base
        self.jitter = jitter
        self.retryable_exceptions = retryable_exceptions
        self.retryable_status_codes = retryable_status_codes

    def get_delay(self, attempt: int, retry_after: Optional[int] = None) -> float:
        if retry_after:
            return float(retry_after)
        delay = min(
            self.base_delay * (self.exponential_base ** attempt),
            self.max_delay,
        )
        if self.jitter:
            delay = delay * (0.5 + random.random() * 0.5)
        return delay

    def is_retryable(self, exception: Exception) -> bool:
        if isinstance(exception, APIError):
            if not exception.retryable:
                return False
            return exception.status in self.retryable_status_codes
        return isinstance(exception, self.retryable_exceptions)

def retry(policy: RetryPolicy):
    def decorator(func: Callable):
        @wraps(func)
        def wrapper(*args, **kwargs):
            last_exception = None
            for attempt in range(policy.max_attempts):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    last_exception = e
                    if not policy.is_retryable(e):
                        logger.info(
                            f"Non-retryable error on attempt {attempt + 1}",
                            extra={"error": str(e), "func": func.__name__}
                        )
                        raise
                    if attempt == policy.max_attempts - 1:
                        break
                    retry_after = getattr(e, 'retry_after', None)
                    delay = policy.get_delay(attempt, retry_after)
                    logger.warning(
                        f"Retry {attempt + 1}/{policy.max_attempts} after {delay:.1f}s",
                        extra={
                            "error": str(e),
                            "func": func.__name__,
                            "delay": delay,
                            "attempt": attempt + 1,
                        }
                    )
                    time.sleep(delay)
            raise last_exception
        return wrapper
    return decorator
```

### Predefined Policies

```python
# minio/retry_policies.py
from minio.retry import RetryPolicy

# Fast retry for API calls (e.g., auth token refresh, metadata fetch)
API_RETRY = RetryPolicy(
    max_attempts=3,
    base_delay=0.5,
    max_delay=5.0,
    exponential_base=2.0,
    retryable_status_codes=(429, 500, 502, 503, 504),
)

# Storage operations (upload/download) — longer delays, more attempts
STORAGE_RETRY = RetryPolicy(
    max_attempts=5,
    base_delay=2.0,
    max_delay=30.0,
    exponential_base=2.0,
    retryable_status_codes=(429, 500, 502, 503, 504),
)

# AI inference — expensive, retry cautiously
AI_INFERENCE_RETRY = RetryPolicy(
    max_attempts=2,
    base_delay=5.0,
    max_delay=60.0,
    exponential_base=3.0,
    retryable_status_codes=(429, 500, 502, 503),
)

# Database operations
DB_RETRY = RetryPolicy(
    max_attempts=3,
    base_delay=0.2,
    max_delay=2.0,
    exponential_base=2.0,
    retryable_exceptions=(
        ConnectionError,
        TimeoutError,
        # Add sqlalchemy specific exceptions
    ),
)

# Video processing — never retry (expensive, stateful)
VIDEO_PROCESSING_RETRY = RetryPolicy(
    max_attempts=1,
    base_delay=0,
    max_delay=0,
)
```

## Service-Specific Retry Implementations

### Upload Service

```python
# minio/services/upload.py
import boto3
from botocore.config import Config
from minio.retry_policies import STORAGE_RETRY

def create_s3_client(endpoint, access_key, secret_key):
    config = Config(
        retries={
            'max_attempts': 5,
            'mode': 'adaptive',
        },
        max_pool_connections=50,
        connect_timeout=10,
        read_timeout=60,
    )
    return boto3.client(
        's3',
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=config,
    )

def upload_with_retry(s3_client, bucket: str, key: str, data: bytes, content_type: str):
    from minio.retry import retry
    from minio.errors import APIError, ErrorCode
    
    @retry(STORAGE_RETRY)
    def _upload():
        try:
            s3_client.put_object(
                Bucket=bucket,
                Key=key,
                Body=data,
                ContentType=content_type,
            )
        except Exception as e:
            raise APIError(
                code=ErrorCode.STORAGE_UNAVAILABLE,
                message=str(e),
                status=503,
                retryable=True,
                retry_after=5,
            )
    
    return _upload()
```

### AI Inference Service

```python
# minio/services/ai_inference.py
import httpx
from minio.retry import retry, RetryPolicy
from minio.errors import APIError, ErrorCode

AI_RETRY = RetryPolicy(
    max_attempts=3,
    base_delay=10.0,
    max_delay=120.0,
    exponential_base=2.0,
    retryable_status_codes=(429, 500, 502, 503),
)

class AIInferenceClient:
    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url
        self.client = httpx.Client(
            timeout=httpx.Timeout(connect=10, read=300, write=10, pool=10),
            headers={"Authorization": f"Bearer {api_key}"},
        )
    
    def extract_clips(self, video_url: str, options: dict) -> dict:
        @retry(AI_RETRY)
        def _call():
            response = self.client.post(
                f"{self.base_url}/v1/extract-clips",
                json={"video_url": video_url, **options},
            )
            if response.status_code == 429:
                retry_after = int(response.headers.get("Retry-After", 30))
                raise APIError(
                    code=ErrorCode.RATE_LIMITED,
                    message="AI service rate limited",
                    status=429,
                    retryable=True,
                    retry_after=retry_after,
                )
            if response.status_code >= 500:
                raise APIError(
                    code=ErrorCode.AI_SERVICE_UNAVAILABLE,
                    message=f"AI service error: {response.status_code}",
                    status=response.status_code,
                    retryable=True,
                    retry_after=15,
                )
            response.raise_for_status()
            return response.json()
        
        return _call()
```

## Job-Level Retry with Dead Letter Queue

```python
# minio/services/job_executor.py
import redis
import json
import time
import logging
from minio.errors import APIError

logger = logging.getLogger("minio.job_executor")

class JobExecutor:
    MAX_RETRIES = 3
    RETRY_DELAYS = [60, 300, 900]  # 1 min, 5 min, 15 min
    
    def __init__(self, redis_client: redis.Redis):
        self.redis = redis_client
    
    def execute(self, job_id: str):
        job_data = self.redis.hgetall(f"job:{job_id}")
        if not job_data:
            logger.error(f"Job {job_id} not found")
            return
        
        attempt = int(job_data.get(b"attempt", 0))
        
        try:
            self._process_job(job_id, job_data)
            self.redis.hset(f"job:{job_id}", mapping={
                "status": "completed",
                "completed_at": time.time(),
            })
            self.redis.lrem("jobs:processing", 0, job_id)
            logger.info(f"Job {job_id} completed (attempt {attempt + 1})")
            
        except APIError as e:
            if e.retryable and attempt < self.MAX_RETRIES:
                self._schedule_retry(job_id, attempt, e)
            else:
                self._move_to_dlq(job_id, attempt, e)
                
        except Exception as e:
            if attempt < self.MAX_RETRIES:
                self._schedule_retry(job_id, attempt, e)
            else:
                self._move_to_dlq(job_id, attempt, e)
    
    def _schedule_retry(self, job_id: str, attempt: int, error: Exception):
        delay = self.RETRY_DELAYS[min(attempt, len(self.RETRY_DELAYS) - 1)]
        retry_at = time.time() + delay
        
        self.redis.hset(f"job:{job_id}", mapping={
            "status": "retrying",
            "attempt": attempt + 1,
            "last_error": str(error),
            "retry_at": retry_at,
        })
        self.redis.zadd("jobs:retry", {job_id: retry_at})
        self.redis.lrem("jobs:processing", 0, job_id)
        
        logger.warning(
            f"Job {job_id} scheduled for retry {attempt + 1}/{self.MAX_RETRIES} "
            f"at {retry_at} (delay {delay}s): {error}"
        )
    
    def _move_to_dlq(self, job_id: str, attempt: int, error: Exception):
        self.redis.hset(f"job:{job_id}", mapping={
            "status": "dead_letter",
            "attempt": attempt + 1,
            "last_error": str(error),
            "failed_at": time.time(),
        })
        self.redis.lrem("jobs:processing", 0, job_id)
        self.redis.rpush("jobs:dead_letter", job_id)
        
        logger.error(
            f"Job {job_id} moved to DLQ after {attempt + 1} attempts: {error}"
        )
        
        # Alert on DLQ growth
        dlq_size = self.redis.llen("jobs:dead_letter")
        if dlq_size > 10:
            self._alert_dlq_growth(dlq_size)
    
    def _process_job(self, job_id: str, job_data: dict):
        # Actual processing logic
        pass
    
    def _alert_dlq_growth(self, size: int):
        from minio.monitoring.alerts import send_alert
        send_alert(
            severity="warning",
            message=f"Dead letter queue size: {size} jobs",
        )
```

### Retry Queue Consumer

```python
# minio/workers/retry_consumer.py
import time
import redis
import logging
from minio.services.job_executor import JobExecutor

logger = logging.getLogger("minio.retry_consumer")

def run_retry_consumer(redis_client: redis.Redis, executor: JobExecutor):
    """Processes jobs from the retry queue when their delay expires."""
    logger.info("Retry consumer started")
    
    while True:
        try:
            # Get jobs whose retry time has arrived
            now = time.time()
            jobs = redis_client.zrangebyscore("jobs:retry", 0, now, start=0, num=10)
            
            if not jobs:
                time.sleep(1)
                continue
            
            for job_id in jobs:
                job_id = job_id.decode() if isinstance(job_id, bytes) else job_id
                
                # Atomically move from retry set to processing list
                pipe = redis_client.pipeline()
                pipe.zrem("jobs:retry", job_id)
                pipe.lpush("jobs:processing", job_id)
                pipe.hset(f"job:{job_id}", "status", "processing")
                pipe.execute()
                
                logger.info(f"Retrying job {job_id}")
                executor.execute(job_id)
                
        except redis.ConnectionError:
            logger.error("Redis connection lost, waiting 5s...")
            time.sleep(5)
        except Exception as e:
            logger.error(f"Retry consumer error: {e}")
            time.sleep(1)
```

## External Service Retry Patterns

### Webhook Delivery with Exponential Backoff

```python
# minio/services/webhooks.py
import httpx
import time
import logging
from minio.retry import retry, RetryPolicy

logger = logging.getLogger("minio.webhooks")

WEBHOOK_RETRY = RetryPolicy(
    max_attempts=5,
    base_delay=10.0,
    max_delay=3600.0,
    exponential_base=4.0,
    retryable_status_codes=(408, 429, 500, 502, 503, 504),
)

def deliver_webhook(url: str, payload: dict, secret: str):
    import hmac
    import hashlib
    
    signature = hmac.new(
        secret.encode(),
        json.dumps(payload).encode(),
        hashlib.sha256,
    ).hexdigest()
    
    @retry(WEBHOOK_RETRY)
    def _deliver():
        response = httpx.post(
            url,
            json=payload,
            headers={
                "X-MiniOp-Signature": signature,
                "X-MiniOp-Delivery": str(uuid.uuid4()),
            },
            timeout=30,
        )
        
        if response.status_code >= 400:
            raise APIError(
                code=ErrorCode.PROCESSING_FAILED,
                message=f"Webhook delivery failed: {response.status_code}",
                status=response.status_code,
                retryable=response.status_code in (408, 429, 500, 502, 503, 504),
                retry_after=int(response.headers.get("Retry-After", 60)),
            )
        return response
    
    return _deliver()
```

## Free Tier vs Production Configuration

```python
# minio/config.py
import os

def get_retry_config():
    tier = os.getenv("MINIO_TIER", "free")
    
    if tier == "free":
        return {
            "api_max_attempts": 2,
            "storage_max_attempts": 3,
            "ai_max_attempts": 1,
            "job_max_retries": 2,
            "retry_queue_enabled": False,  # Process inline
        }
    else:
        return {
            "api_max_attempts": 3,
            "storage_max_attempts": 5,
            "ai_max_attempts": 3,
            "job_max_retries": 3,
            "retry_queue_enabled": True,  # Dedicated retry consumer
        }
```

## Retry Metrics

```python
# minio/monitoring/retry_metrics.py
from prometheus_client import Counter, Histogram, Gauge

RETRY_ATTEMPTS = Counter(
    'minio_retry_attempts_total',
    'Total retry attempts',
    ['service', 'attempt_number']
)

RETRY_SUCCESS = Counter(
    'minio_retry_success_total',
    'Successful retries',
    ['service', 'attempt_number']
)

RETRY_EXHAUSTED = Counter(
    'minio_retry_exhausted_total',
    'Retries exhausted (moved to DLQ)',
    ['service']
)

RETRY_DELAY = Histogram(
    'minio_retry_delay_seconds',
    'Time waited before retry',
    ['service'],
    buckets=[1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600]
)

DLQ_SIZE = Gauge(
    'minio_dlq_size',
    'Current dead letter queue size'
)

def record_retry(service: str, attempt: int, success: bool):
    RETRY_ATTEMPTS.labels(service=service, attempt_number=str(attempt)).inc()
    if success:
        RETRY_SUCCESS.labels(service=service, attempt_number=str(attempt)).inc()
```

## Testing Retry Behavior

```python
# tests/test_retry.py
import pytest
from unittest.mock import patch, MagicMock
from minio.retry import retry, RetryPolicy
from minio.errors import APIError, ErrorCode

def test_retry_succeeds_on_third_attempt():
    call_count = 0
    
    @retry(RetryPolicy(max_attempts=3, base_delay=0.01))
    def flaky_function():
        nonlocal call_count
        call_count += 1
        if call_count < 3:
            raise APIError(
                code=ErrorCode.STORAGE_UNAVAILABLE,
                message="temporary failure",
                status=503,
                retryable=True,
            )
        return "success"
    
    result = flaky_function()
    assert result == "success"
    assert call_count == 3

def test_no_retry_on_permanent_error():
    call_count = 0
    
    @retry(RetryPolicy(max_attempts=3, base_delay=0.01))
    def permanent_failure():
        nonlocal call_count
        call_count += 1
        raise APIError(
            code=ErrorCode.INVALID_FILE_FORMAT,
            message="bad format",
            status=400,
            retryable=False,
        )
    
    with pytest.raises(APIError):
        permanent_failure()
    assert call_count == 1

def test_retry_exhaustion():
    call_count = 0
    
    @retry(RetryPolicy(max_attempts=2, base_delay=0.01))
    def always_fails():
        nonlocal call_count
        call_count += 1
        raise APIError(
            code=ErrorCode.STORAGE_UNAVAILABLE,
            message="always fails",
            status=503,
            retryable=True,
        )
    
    with pytest.raises(APIError):
        always_fails()
    assert call_count == 2
```
