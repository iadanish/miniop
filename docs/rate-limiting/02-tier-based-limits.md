# Tier-Based Rate Limits

MiniOp implements tier-based rate limiting to align API consumption with each customer's subscription plan. Limits scale from a generous free tier suitable for prototyping to enterprise tiers that support high-throughput video processing pipelines. This document defines the tier structure, configuration, dynamic limit resolution, and migration procedures.

## Tier Definitions

MiniOp has four tiers. Limits are enforced per API key per rolling 60-second window unless otherwise noted.

| Tier | Requests/min | Clip operations/min | Concurrent jobs | Burst allowance |
|---|---|---|---|---|
| **Free** | 60 | 2 | 1 | 10 requests above limit for 10s |
| **Starter** | 300 | 10 | 3 | 30 requests above limit for 10s |
| **Pro** | 1,200 | 40 | 10 | 100 requests above limit for 10s |
| **Enterprise** | 6,000 | 200 | 50 | Custom |

Clip operations include `/api/v1/clip`, `/api/v1/transcribe`, `/api/v1/batch`, and `/api/v1/clip/{id}/export`. All other endpoints count against the general request limit.

Burst allowance permits short spikes above the per-minute limit. The burst window is 10 seconds. If a free-tier user sends 10 requests in 1 second, they consume their burst budget and are then throttled to the per-minute rate.

## Database Schema

Tiers and their limits are stored in PostgreSQL. The `rate_limit_tiers` table is the source of truth:

```sql
CREATE TABLE rate_limit_tiers (
    tier_id         SERIAL PRIMARY KEY,
    tier_name       VARCHAR(50) UNIQUE NOT NULL,
    requests_per_min    INTEGER NOT NULL,
    clip_ops_per_min    INTEGER NOT NULL,
    concurrent_jobs     INTEGER NOT NULL,
    burst_allowance     INTEGER NOT NULL,
    burst_window_sec    INTEGER NOT NULL DEFAULT 10,
    daily_clip_limit    INTEGER,
    max_upload_size_mb  INTEGER NOT NULL DEFAULT 500,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO rate_limit_tiers (tier_name, requests_per_min, clip_ops_per_min, concurrent_jobs, burst_allowance, daily_clip_limit, max_upload_size_mb)
VALUES
    ('free',       60,   2,   1,  10,   10,   500),
    ('starter',    300,  10,  3,  30,   100,  2000),
    ('pro',        1200, 40,  10, 100,  1000, 5000),
    ('enterprise', 6000, 200, 50, 0,    NULL, 20000);
```

The `api_keys` table references the tier:

```sql
CREATE TABLE api_keys (
    key_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key     VARCHAR(64) UNIQUE NOT NULL,
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    tier_id     INTEGER NOT NULL REFERENCES rate_limit_tiers(tier_id),
    is_active   BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_api_keys_key ON api_keys(api_key);
```

## Limit Resolution Pipeline

When a request arrives, the middleware resolves the effective limits through this pipeline:

1. Extract API key from the request header
2. Look up the key in a local in-memory cache (TTL: 60 seconds)
3. On cache miss, query PostgreSQL for the key's tier
4. Check for tenant-level overrides (enterprise custom limits)
5. Return the effective limits

```python
# services/limit_resolver.py
import asyncpg
from functools import lru_cache
from cachetools import TTLCache

class LimitResolver:
    def __init__(self, pool: asyncpg.Pool):
        self.pool = pool
        self._cache = TTLCache(maxsize=10_000, ttl=60)

    async def resolve(self, api_key: str) -> dict:
        if api_key in self._cache:
            return self._cache[api_key]

        async with self.pool.acquire() as conn:
            row = await conn.fetchrow("""
                SELECT
                    r.requests_per_min,
                    r.clip_ops_per_min,
                    r.concurrent_jobs,
                    r.burst_allowance,
                    r.burst_window_sec,
                    r.daily_clip_limit,
                    r.max_upload_size_mb,
                    o.requests_per_min AS override_rpm,
                    o.clip_ops_per_min AS override_clip
                FROM api_keys ak
                JOIN rate_limit_tiers r ON ak.tier_id = r.tier_id
                LEFT JOIN rate_limit_overrides o ON ak.tenant_id = o.tenant_id
                WHERE ak.api_key = $1 AND ak.is_active = TRUE
            """, api_key)

            if not row:
                return None

            limits = {
                "requests_per_min": row["override_rpm"] or row["requests_per_min"],
                "clip_ops_per_min": row["override_clip"] or row["clip_ops_per_min"],
                "concurrent_jobs": row["concurrent_jobs"],
                "burst_allowance": row["burst_allowance"],
                "burst_window_sec": row["burst_window_sec"],
                "daily_clip_limit": row["daily_clip_limit"],
                "max_upload_size_mb": row["max_upload_size_mb"],
            }
            self._cache[api_key] = limits
            return limits
```

## Per-Endpoint Limit Enforcement

The rate limiter maintains separate counters for general requests and clip operations. A single request can consume from both counters if the endpoint is a clip operation.

```python
# rate_limit/tier_enforcer.py
class TierRateEnforcer:
    def __init__(self, sliding_window: SlidingWindowRateLimiter):
        self.sw = sliding_window

    def check_limits(self, api_key: str, path: str, limits: dict) -> tuple[bool, dict]:
        # Always check general request limit
        general_key = f"rpm:{api_key}"
        general_allowed, general_headers = self.sw.is_allowed(
            general_key, limits["requests_per_min"]
        )

        if not general_allowed:
            return False, general_headers

        # Check clip operation limit if applicable
        if self._is_clip_endpoint(path):
            clip_key = f"clip:{api_key}"
            clip_allowed, clip_headers = self.sw.is_allowed(
                clip_key, limits["clip_ops_per_min"]
            )
            if not clip_allowed:
                return False, clip_headers

        return True, general_headers

    def _is_clip_endpoint(self, path: str) -> bool:
        clip_prefixes = ["/api/v1/clip", "/api/v1/transcribe", "/api/v1/batch"]
        return any(path.startswith(p) for p in clip_prefixes)
```

## Concurrent Job Limiting

Beyond request rate limits, MiniOp tracks concurrent active jobs per API key. This prevents a single tenant from monopolizing GPU workers for video processing.

```python
# services/concurrent_limiter.py
import redis.asyncio as aioredis

class ConcurrentJobLimiter:
    def __init__(self, redis: aioredis.Redis):
        self.redis = redis

    async def acquire(self, api_key: str, max_concurrent: int) -> bool:
        key = f"concurrent:{api_key}"
        current = await self.redis.get(key)
        if current and int(current) >= max_concurrent:
            return False
        await self.redis.incr(key)
        await self.redis.expire(key, 3600)  # safety TTL
        return True

    async def release(self, api_key: str):
        key = f"concurrent:{api_key}"
        current = await self.redis.get(key)
        if current and int(current) > 0:
            await self.redis.decr(key)
```

Usage in the clip processing endpoint:

```python
@app.post("/api/v1/clip")
async def create_clip(request: Request, body: ClipRequest):
    api_key = extract_api_key(request)
    limits = await limit_resolver.resolve(api_key)

    if not await concurrent_limiter.acquire(api_key, limits["concurrent_jobs"]):
        raise HTTPException(
            status_code=429,
            detail=f"Concurrent job limit ({limits['concurrent_jobs']}) reached"
        )

    try:
        job = await process_clip(body)
        return job
    finally:
        await concurrent_limiter.release(api_key)
```

## Daily Quota Enforcement

Free and Starter tiers have daily clip operation quotas. This prevents sustained abuse even within per-minute limits.

```python
# services/daily_quota.py
class DailyQuotaChecker:
    def __init__(self, redis: aioredis.Redis):
        self.redis = redis

    async def check_and_increment(self, api_key: str, daily_limit: int | None) -> bool:
        if daily_limit is None:
            return True  # unlimited

        today = datetime.utcnow().strftime("%Y-%m-%d")
        key = f"daily:{api_key}:{today}"

        pipe = self.redis.pipeline()
        pipe.incr(key)
        pipe.expire(key, 86400)
        results = await pipe.execute()

        return results[0] <= daily_limit

    async def get_remaining(self, api_key: str, daily_limit: int | None) -> int | None:
        if daily_limit is None:
            return None

        today = datetime.utcnow().strftime("%Y-%m-%d")
        key = f"daily:{api_key}:{today}"
        used = int(await self.redis.get(key) or 0)
        return max(0, daily_limit - used)
```

## Tier Migration

When a customer upgrades or downgrades, the change takes effect immediately. The system updates the `api_keys` tier reference and purges the cached limits.

```sql
-- Upgrade a tenant's API key to pro tier
UPDATE api_keys
SET tier_id = (SELECT tier_id FROM rate_limit_tiers WHERE tier_name = 'pro'),
    updated_at = NOW()
WHERE tenant_id = 'a1b2c3d4-...';
```

```python
# Admin endpoint for tier changes
@app.post("/admin/tenants/{tenant_id}/tier")
async def change_tier(tenant_id: str, new_tier: str, admin: AdminUser = Depends(require_admin)):
    async with pool.acquire() as conn:
        await conn.execute("""
            UPDATE api_keys
            SET tier_id = (SELECT tier_id FROM rate_limit_tiers WHERE tier_name = $1),
                updated_at = NOW()
            WHERE tenant_id = $2
        """, new_tier, tenant_id)

    # Purge cache for all keys belonging to this tenant
    keys_to_purge = [k for k in limit_resolver._cache if k.startswith(tenant_id)]
    for k in keys_to_purge:
        del limit_resolver._cache[k]

    return {"status": "ok", "new_tier": new_tier}
```

## Enterprise Custom Limits

Enterprise tenants can have overrides stored in a separate table. The limit resolver checks this table first and falls back to tier defaults.

```sql
CREATE TABLE rate_limit_overrides (
    tenant_id       UUID PRIMARY KEY REFERENCES tenants(id),
    requests_per_min    INTEGER,
    clip_ops_per_min    INTEGER,
    concurrent_jobs     INTEGER,
    daily_clip_limit    INTEGER,
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

## Client-Side Rate Limit Handling

Clients should respect rate limit headers and implement exponential backoff:

```python
# client/rate_aware_client.py
import httpx
import asyncio

class RateAwareClient:
    def __init__(self, api_key: str, base_url: str):
        self.client = httpx.AsyncClient(
            base_url=base_url,
            headers={"X-Api-Key": api_key},
        )

    async def request(self, method: str, path: str, **kwargs) -> httpx.Response:
        for attempt in range(5):
            response = await self.client.request(method, path, **kwargs)

            if response.status_code != 429:
                return response

            retry_after = int(response.headers.get("Retry-After", 1))
            await asyncio.sleep(retry_after)

        raise Exception("Rate limit retries exhausted")
```

## Next Steps

- Review [Abuse Prevention](./03-abuse-prevention.md) for detecting patterns that bypass tier limits
