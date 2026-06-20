# MiniOp Error Handling Guide

## Error Taxonomy

MiniOp categorizes errors by their origin and recoverability. Proper classification drives the correct recovery strategy — retrying a permanent error wastes resources, while failing fast on a transient one loses work unnecessarily.

### Error Categories

| Category | Examples | Recoverable | Strategy |
|---|---|---|---|
| Transient | Network timeout, 503, connection reset | Yes | Retry with backoff |
| Rate Limit | 429 Too Many Requests | Yes | Respect Retry-After header |
| Resource | OOM, disk full, connection pool exhausted | Partially | Degrade gracefully |
| Validation | Invalid file format, corrupt video | No | Reject with clear message |
| Authorization | Expired token, insufficient permissions | Partially | Refresh credentials once |
| Permanent | 404, 410 Gone, schema mismatch | No | Fail fast, log, alert |

## Error Handling Architecture

```
┌──────────┐    ┌──────────────┐    ┌─────────────────┐
│  Client  │───▶│  API Gateway │───▶│  Error Handler  │
└──────────┘    └──────────────┘    └────────┬────────┘
                                             │
                    ┌────────────────────────┼────────────────────────┐
                    │                        │                        │
              ┌─────▼──────┐          ┌──────▼──────┐          ┌─────▼──────┐
              │ Transient  │          │  Permanent  │          │  Resource  │
              │   Retry    │          │  Fail Fast  │          │  Degrade   │
              └─────┬──────┘          └──────┬──────┘          └─────┬──────┘
                    │                        │                        │
              ┌─────▼──────┐          ┌──────▼──────┐          ┌─────▼──────┐
              │  DLQ after │          │  Error log  │          │  Shed load │
              │  3 retries │          │  + alert    │          │  + fallback│
              └────────────┘          └─────────────┘          └────────────┘
```

## Application-Level Error Handling

### API Error Response Format

```python
# minio/errors.py
from dataclasses import dataclass
from enum import Enum
from typing import Optional
import uuid

class ErrorCode(Enum):
    # Client errors (4xx)
    INVALID_FILE_FORMAT = "INVALID_FILE_FORMAT"
    FILE_TOO_LARGE = "FILE_TOO_LARGE"
    QUOTA_EXCEEDED = "QUOTA_EXCEEDED"
    INVALID_PARAMETERS = "INVALID_PARAMETERS"
    AUTHENTICATION_REQUIRED = "AUTHENTICATION_REQUIRED"
    INSUFFICIENT_PERMISSIONS = "INSUFFICIENT_PERMISSIONS"
    
    # Transient errors (5xx)
    PROCESSING_FAILED = "PROCESSING_FAILED"
    STORAGE_UNAVAILABLE = "STORAGE_UNAVAILABLE"
    QUEUE_FULL = "QUEUE_FULL"
    AI_SERVICE_UNAVAILABLE = "AI_SERVICE_UNAVAILABLE"
    
    # Rate limiting
    RATE_LIMITED = "RATE_LIMITED"

@dataclass
class APIError:
    code: ErrorCode
    message: str
    status: int
    retryable: bool
    request_id: str = ""
    details: Optional[dict] = None
    retry_after: Optional[int] = None

    def __post_init__(self):
        if not self.request_id:
            self.request_id = str(uuid.uuid4())

    def to_response(self) -> dict:
        body = {
            "error": {
                "code": self.code.value,
                "message": self.message,
                "request_id": self.request_id,
                "retryable": self.retryable,
            }
        }
        if self.details:
            body["error"]["details"] = self.details
        if self.retry_after:
            body["error"]["retry_after"] = self.retry_after
        return body

ERROR_MAP = {
    ErrorCode.INVALID_FILE_FORMAT: 400,
    ErrorCode.FILE_TOO_LARGE: 413,
    ErrorCode.QUOTA_EXCEEDED: 429,
    ErrorCode.INVALID_PARAMETERS: 400,
    ErrorCode.AUTHENTICATION_REQUIRED: 401,
    ErrorCode.INSUFFICIENT_PERMISSIONS: 403,
    ErrorCode.PROCESSING_FAILED: 500,
    ErrorCode.STORAGE_UNAVAILABLE: 503,
    ErrorCode.QUEUE_FULL: 503,
    ErrorCode.AI_SERVICE_UNAVAILABLE: 503,
    ErrorCode.RATE_LIMITED: 429,
}
```

### Global Exception Handler

```python
# minio/middleware/error_handler.py
import logging
import traceback
from fastapi import Request
from fastapi.responses import JSONResponse
from minio.errors import APIError, ErrorCode, ERROR_MAP

logger = logging.getLogger("minio.error_handler")

async def error_handler_middleware(request: Request, call_next):
    try:
        return await call_next(request)
    except APIError as e:
        e.request_id = request.state.request_id
        logger.warning(
            "API error",
            extra={
                "error_code": e.code.value,
                "status": e.status,
                "request_id": e.request_id,
                "path": request.url.path,
                "retryable": e.retryable,
            }
        )
        return JSONResponse(
            status_code=e.status,
            content=e.to_response(),
            headers={"Retry-After": str(e.retry_after)} if e.retry_after else {},
        )
    except ValueError as e:
        return JSONResponse(
            status_code=400,
            content=APIError(
                code=ErrorCode.INVALID_PARAMETERS,
                message=str(e),
                status=400,
                retryable=False,
                request_id=request.state.request_id,
            ).to_response(),
        )
    except Exception as e:
        logger.error(
            "Unhandled exception",
            exc_info=True,
            extra={"request_id": request.state.request_id, "path": request.url.path},
        )
        return JSONResponse(
            status_code=500,
            content=APIError(
                code=ErrorCode.PROCESSING_FAILED,
                message="An internal error occurred",
                status=500,
                retryable=True,
                request_id=request.state.request_id,
            ).to_response(),
        )
```

### Video Processing Error Handling

```python
# minio/services/video_processor.py
import subprocess
import logging
from pathlib import Path
from minio.errors import APIError, ErrorCode

logger = logging.getLogger("minio.video_processor")

class VideoProcessingError(Exception):
    def __init__(self, message: str, code: ErrorCode, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable

def process_video(input_path: Path, output_path: Path, options: dict) -> dict:
    try:
        result = subprocess.run(
            [
                "ffmpeg",
                "-i", str(input_path),
                "-c:v", "libx264",
                "-preset", options.get("preset", "medium"),
                "-crf", str(options.get("quality", 23)),
                "-c:a", "aac",
                "-b:a", "128k",
                "-movflags", "+faststart",
                "-y",
                str(output_path),
            ],
            capture_output=True,
            timeout=600,
            check=True,
        )
        return {"status": "success", "output": str(output_path)}
    except FileNotFoundError:
        raise VideoProcessingError(
            "ffmpeg not found on system",
            code=ErrorCode.PROCESSING_FAILED,
            retryable=False,
        )
    except subprocess.TimeoutExpired:
        raise VideoProcessingError(
            "Video processing timed out (>600s)",
            code=ErrorCode.PROCESSING_FAILED,
            retryable=True,
        )
    except subprocess.CalledProcessError as e:
        error_output = e.stderr.decode("utf-8", errors="replace")
        if "Invalid data found" in error_output or "Invalid argument" in error_output:
            raise VideoProcessingError(
                "Corrupt or unsupported video format",
                code=ErrorCode.INVALID_FILE_FORMAT,
                retryable=False,
            )
        if "No space left" in error_output:
            raise VideoProcessingError(
                "Disk full during processing",
                code=ErrorCode.PROCESSING_FAILED,
                retryable=True,
            )
        raise VideoProcessingError(
            f"ffmpeg failed: {error_output[:200]}",
            code=ErrorCode.PROCESSING_FAILED,
            retryable=True,
        )

def handle_video_error(job_id: str, error: Exception):
    if isinstance(error, VideoProcessingError):
        if error.retryable:
            raise APIError(
                code=error.code,
                message=str(error),
                status=ERROR_MAP[error.code],
                retryable=True,
                retry_after=30,
            )
        else:
            raise APIError(
                code=error.code,
                message=str(error),
                status=ERROR_MAP[error.code],
                retryable=False,
            )
    raise APIError(
        code=ErrorCode.PROCESSING_FAILED,
        message="Unexpected processing error",
        status=500,
        retryable=True,
    )
```

## Storage Error Handling

```python
# minio/services/storage.py
import boto3
from botocore.exceptions import ClientError, EndpointConnectionError
from minio.errors import APIError, ErrorCode
import logging

logger = logging.getLogger("minio.storage")

class StorageService:
    def __init__(self, endpoint, access_key, secret_key):
        self.client = boto3.client(
            's3',
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
        )

    def upload(self, bucket: str, key: str, data: bytes, content_type: str):
        try:
            self.client.put_object(
                Bucket=bucket,
                Key=key,
                Body=data,
                ContentType=content_type,
            )
        except EndpointConnectionError:
            raise APIError(
                code=ErrorCode.STORAGE_UNAVAILABLE,
                message="Cannot connect to storage backend",
                status=503,
                retryable=True,
                retry_after=10,
            )
        except ClientError as e:
            error_code = e.response["Error"]["Code"]
            if error_code == "NoSuchBucket":
                self._ensure_bucket(bucket)
                raise APIError(
                    code=ErrorCode.STORAGE_UNAVAILABLE,
                    message="Storage bucket created, retry upload",
                    status=503,
                    retryable=True,
                    retry_after=5,
                )
            if error_code == "EntityTooLarge":
                raise APIError(
                    code=ErrorCode.FILE_TOO_LARGE,
                    message="File exceeds maximum upload size",
                    status=413,
                    retryable=False,
                )
            logger.error(f"S3 error: {e}", extra={"bucket": bucket, "key": key})
            raise APIError(
                code=ErrorCode.STORAGE_UNAVAILABLE,
                message="Storage operation failed",
                status=503,
                retryable=True,
                retry_after=15,
            )

    def _ensure_bucket(self, bucket: str):
        try:
            self.client.create_bucket(Bucket=bucket)
        except ClientError:
            pass
```

## Database Error Handling

```python
# minio/services/database.py
from sqlalchemy.exc import (
    OperationalError, IntegrityError, DisconnectionError,
    DBAPIError, TimeoutError as DBTimeoutError
)
from minio.errors import APIError, ErrorCode
import logging

logger = logging.getLogger("minio.database")

def handle_db_operation(operation, *args, **kwargs):
    try:
        return operation(*args, **kwargs)
    except DisconnectionError:
        raise APIError(
            code=ErrorCode.PROCESSING_FAILED,
            message="Database connection lost",
            status=503,
            retryable=True,
            retry_after=5,
        )
    except DBTimeoutError:
        raise APIError(
            code=ErrorCode.PROCESSING_FAILED,
            message="Database operation timed out",
            status=503,
            retryable=True,
            retry_after=10,
        )
    except OperationalError as e:
        if "too many connections" in str(e):
            raise APIError(
                code=ErrorCode.PROCESSING_FAILED,
                message="Database at capacity",
                status=503,
                retryable=True,
                retry_after=30,
            )
        raise APIError(
            code=ErrorCode.PROCESSING_FAILED,
            message="Database unavailable",
            status=503,
            retryable=True,
            retry_after=15,
        )
    except IntegrityError as e:
        if "unique" in str(e).lower():
            raise APIError(
                code=ErrorCode.INVALID_PARAMETERS,
                message="Resource already exists",
                status=409,
                retryable=False,
            )
        raise APIError(
            code=ErrorCode.INVALID_PARAMETERS,
            message="Data integrity violation",
            status=400,
            retryable=False,
        )
```

## Client-Side Error Handling (JavaScript SDK)

```javascript
// minio-sdk/src/errorHandler.js
class MinioError extends Error {
  constructor(response) {
    super(response.error.message);
    this.code = response.error.code;
    this.retryable = response.error.retryable;
    this.requestId = response.error.request_id;
    this.retryAfter = response.error.retry_after;
    this.status = response.status;
  }
}

async function withErrorHandling(apiCall) {
  try {
    const response = await apiCall();
    if (!response.ok) {
      const body = await response.json();
      throw new MinioError(body);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof MinioError) {
      if (error.code === 'AUTHENTICATION_REQUIRED') {
        await refreshAuth();
        return withErrorHandling(apiCall);
      }
      throw error;
    }
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      throw new MinioError({
        error: {
          code: 'STORAGE_UNAVAILABLE',
          message: 'Network error',
          retryable: true,
          request_id: crypto.randomUUID(),
          retry_after: 5,
        },
        status: 0,
      });
    }
    throw error;
  }
}

// Usage
try {
  const job = await withErrorHandling(() =>
    fetch('/api/v1/jobs', { method: 'POST', body: formData })
  );
  showSuccess(job.id);
} catch (error) {
  if (error.retryable) {
    scheduleRetry(error.retryAfter);
  } else {
    showError(error.message, error.requestId);
  }
}
```

## Error Monitoring and Alerting

```python
# minio/monitoring/errors.py
from prometheus_client import Counter, Histogram

ERROR_COUNTER = Counter(
    'minio_errors_total',
    'Total errors by code and retryability',
    ['error_code', 'retryable']
)

ERROR_LATENCY = Histogram(
    'minio_error_handling_seconds',
    'Time spent handling errors',
    buckets=[0.01, 0.05, 0.1, 0.5, 1, 5]
)

def record_error(error: APIError):
    ERROR_COUNTER.labels(
        error_code=error.code.value,
        retryable=str(error.retryable)
    ).inc()
    
    if error.code.value.startswith("PROCESSING") or error.code.value.startswith("STORAGE"):
        alert_if_threshold_exceeded(error.code.value)

def alert_if_threshold_exceeded(error_code: str):
    from prometheus_client import Gauge
    rate = ERROR_COUNTER.labels(error_code=error_code, retryable="True")._value.get()
    if rate > 10:  # More than 10 retryable errors
        send_alert(
            severity="warning",
            message=f"High rate of {error_code} errors: {rate}/min"
        )
    if rate > 100:
        send_alert(
            severity="critical",
            message=f"Error storm: {error_code} at {rate}/min"
        )
```

## Error Budget

Track error rates against SLOs:

```yaml
# prometheus/alerts.yml
groups:
- name: minio-error-budget
  rules:
  - alert: ErrorBudgetBurnRateHigh
    expr: |
      (
        sum(rate(minio_errors_total{retryable="False"}[1h]))
        /
        sum(rate(minio_api_requests_total[1h]))
      ) > 0.001
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Error rate exceeding 0.1% budget"
      
  - alert: TransientErrorSpike
    expr: |
      sum(rate(minio_errors_total{retryable="True"}[5m])) > 50
    for: 2m
    labels:
      severity: warning
    annotations:
      summary: "Transient error spike detected"
```
