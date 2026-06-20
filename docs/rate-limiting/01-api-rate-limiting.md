# API Rate Limiting

MiniOp applies rate limiting at the API gateway layer to protect backend services from overload, ensure fair resource allocation across tenants, and prevent cascading failures during traffic spikes. This document covers the architecture, configuration, and operational procedures for the rate limiting subsystem.

## Architecture Overview

Rate limiting in MiniOp is implemented as a middleware layer that sits between the ingress controller and the application servers. The system uses a sliding window counter algorithm backed by Redis for distributed state. Every inbound HTTP request passes through the rate limiter before reaching any application logic.

```
Client → Nginx Ingress → Rate Limit Middleware → Application Server
                              ↕
                         Redis Cluster
                      (sliding window state)
```

The middleware extracts the API key from the `Authorization` header (Bearer token) or the `X-Api-Key` header, resolves the associated tenant and tier, then evaluates the request against the tenant's configured limits. If the request exceeds the limit, the middleware returns `429 Too Many Requests` with `Retry-After` and `X-RateLimit-*` headers.

## Sliding Window Counter Algorithm

MiniOp uses a sliding window counter rather than a fixed window to prevent the burst-at-boundary problem. Each window is divided into 1-minute sub-windows. The counter maintains the count for the current sub-window and a weighted portion of the previous sub-window based on how far into the current window we are.

```python
# rate_limit/sliding_window.py
import time
import redis

class SlidingWindowRateLimiter:
    def __init__(self, redis_client: redis.Redis, window_seconds: int = 60):
        self.redis = redis_client
        self.window = window_seconds

    def is_allowed(self, key: str, limit: int) -> tuple[bool, dict]:
        now = time.time()
        current_window = int(now // self.window) * self.window
        previous_window = current_window - self.window
        elapsed = now - current_window
        weight = 1 - (elapsed / self.window)

        pipe = self.redis.pipeline()
        pipe.get(f"ratelimit:{key}:{previous_window}")
        pipe.get(f"ratelimit:{key}:{current_window}")
        pipe.incr(f"ratelimit:{key}:{current_window}")
        pipe.expire(f"ratelimit:{key}:{current_window}", self.window * 2)
        results = pipe.execute()

        prev_count = int(results[0] or 0)
        curr_count = int(results[1] or 0)
        effective_count = prev_count * weight + curr_count

        remaining = max(0, int(limit - effective_count))
        reset_at = current_window + self.window

        return effective_count < limit, {
            "X-RateLimit-Limit": str(limit),
            "X-RateLimit-Remaining": str(remaining),
            "X-RateLimit-Reset": str(int(reset_at)),
        }
```

## Middleware Integration (FastAPI)

```python
# middleware/rate_limit.py
from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from rate_limit.sliding_window import SlidingWindowRateLimiter

class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, limiter: SlidingWindowRateLimiter, get_limits):
        super().__init__(app)
        self.limiter = limiter
        self.get_limits = get_limits  # async fn(api_key) -> (limit, window)

    async def dispatch(self, request: Request, call_next):
        api_key = request.headers.get("X-Api-Key") or ""
        if api_key.startswith("Bearer "):
            api_key = api_key[7:]

        if not api_key:
            return await call_next(request)  # auth middleware handles this

        limit, window = await self.get_limits(api_key)
        key = f"{api_key}:{request.url.path}"
        allowed, headers = self.limiter.is_allowed(key, limit)

        if not allowed:
            raise HTTPException(
                status_code=429,
                detail="Rate limit exceeded",
                headers={**headers, "Retry-After": headers["X-RateLimit-Reset"]}
            )

        response = await call_next(request)
        for k, v in headers.items():
            response.headers[k] = v
        return response
```

Register the middleware in your application factory:

```python
# main.py
from fastapi import FastAPI
from middleware.rate_limit import RateLimitMiddleware
from rate_limit.sliding_window import SlidingWindowRateLimiter
import redis.asyncio as aioredis

app = FastAPI()

@app.on_event("startup")
async def setup_rate_limiter():
    redis_client = aioredis.from_url("redis://redis-cluster:6379/0")
    limiter = SlidingWindowRateLimiter(redis_client, window_seconds=60)
    app.add_middleware(
        RateLimitMiddleware,
        limiter=limiter,
        get_limits=get_tenant_limits,
    )
```

## Endpoint-Specific Limits

Not all endpoints consume the same compute. Video processing endpoints (`/api/v1/clip`) are orders of magnitude more expensive than metadata reads (`/api/v1/projects`). MiniOp applies per-endpoint cost multipliers so a single heavy request consumes more of the tenant's quota.

```yaml
# config/rate_limits.yaml
endpoint_costs:
  /api/v1/projects:
    cost: 1
  /api/v1/projects/{id}/clips:
    cost: 1
  /api/v1/clip:
    cost: 10          # video processing is expensive
  /api/v1/clip/{id}/export:
    cost: 5
  /api/v1/transcribe:
    cost: 8
  /api/v1/batch:
    cost: 20          # batch operations multiply cost
```

The middleware applies the cost multiplier before evaluating the counter:

```python
cost = endpoint_costs.get(request.url.path, 1)
key = f"{api_key}:{request.url.path}"
allowed, headers = self.limiter.is_allowed(key, limit, cost=cost)
```

The `is_allowed` method increments the counter by `cost` instead of 1:

```python
def is_allowed(self, key: str, limit: int, cost: int = 1) -> tuple[bool, dict]:
    # ... window calculation same as above ...
    pipe.incr(f"ratelimit:{key}:{current_window}", cost)
    # ... rest same, but effective_count comparison uses cost-aware logic
```

## Redis Cluster Configuration

For production deployments, run Redis in cluster mode with at least 3 masters and 3 replicas. Rate limiting is latency-sensitive — if Redis is unreachable, the middleware must fail open or closed based on your risk tolerance.

```yaml
# docker-compose.redis.yml
services:
  redis-master-1:
    image: redis:7-alpine
    command: redis-server --appendonly yes --cluster-enabled yes
    volumes:
      - redis-data-1:/data
  redis-master-2:
    image: redis:7-alpine
    command: redis-server --appendonly yes --cluster-enabled yes
    volumes:
      - redis-data-2:/data
  redis-master-3:
    image: redis:7-alpine
    command: redis-server --appendonly yes --cluster-enabled yes
    volumes:
      - redis-data-3:/data
```

Configure fail-open behavior for availability over strict enforcement:

```python
# config.py
RATE_LIMIT_FAIL_OPEN = True  # allow requests if Redis is down
RATE_LIMIT_REDIS_TIMEOUT_MS = 50  # max wait for Redis response
```

## Response Headers

Every rate-limited response includes standard headers so clients can self-throttle:

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | Maximum requests allowed in the current window |
| `X-RateLimit-Remaining` | Requests remaining in the current window |
| `X-RateLimit-Reset` | Unix timestamp when the window resets |
| `Retry-After` | Seconds until the client should retry (only on 429) |

## Monitoring and Alerting

Track these Prometheus metrics to monitor rate limiting health:

```python
# metrics.py
from prometheus_client import Counter, Histogram

rate_limit_total = Counter(
    "minio_rate_limit_decisions_total",
    "Total rate limit decisions",
    ["endpoint", "decision"]  # decision: allowed | denied
)

rate_limit_latency = Histogram(
    "minio_rate_limit_check_duration_seconds",
    "Time spent evaluating rate limits",
    buckets=[0.001, 0.005, 0.01, 0.025, 0.05, 0.1]
)
```

Set alerts when the deny rate exceeds normal baselines:

```yaml
# alerts/rate_limit.yml
groups:
  - name: rate_limiting
    rules:
      - alert: HighRateLimitDenialRate
        expr: |
          sum(rate(minio_rate_limit_decisions_total{decision="denied"}[5m]))
          / sum(rate(minio_rate_limit_decisions_total[5m])) > 0.1
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Rate limit denial rate exceeds 10%"
```

## Testing Rate Limits

Use this script to validate rate limiting behavior against a running instance:

```bash
#!/bin/bash
# scripts/test_rate_limit.sh
API_KEY="your-test-key"
ENDPOINT="http://localhost:8000/api/v1/projects"
LIMIT=100

echo "Sending $((LIMIT + 20)) requests..."
for i in $(seq 1 $((LIMIT + 20))); do
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "X-Api-Key: $API_KEY" "$ENDPOINT")
  if [ "$status" == "429" ]; then
    echo "Request $i: rate limited (429)"
  fi
done
```

## Next Steps

- Review [Tier-Based Limits](./02-tier-based-limits.md) for per-tier configuration
- Review [Abuse Prevention](./03-abuse-prevention.md) for detecting and blocking abusive patterns
