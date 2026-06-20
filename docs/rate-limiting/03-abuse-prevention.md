# Abuse Prevention

Rate limiting handles normal traffic shaping, but determined abusers work around per-minute limits by distributing requests across multiple API keys, rotating IPs, or exploiting business logic. This document covers MiniOp's abuse detection and prevention systems that operate above the rate limiter.

## Threat Model

MiniOp faces these abuse categories:

| Threat | Example | Impact |
|---|---|---|
| **Key sharing** | Free-tier key shared across a team of 50 | Revenue loss, resource exhaustion |
| **Credential stuffing** | Attacker tries leaked API keys from other services | Account compromise |
| **Quota laundering** | Creating many free accounts to get aggregate capacity | Bypasses tier limits |
| **Resource exhaustion** | Submitting maximum-length videos repeatedly | GPU worker starvation |
| **Scraping** | Rapidly reading all project metadata | Data exfiltration |
| **Token farming** | Automated signups to collect free trial credits | Financial loss |

## Abuse Detection Service

The abuse detection service runs as a separate worker that consumes an event stream from the API gateway. It evaluates requests against a rule engine and takes automated actions when abuse is detected.

```
API Gateway → Kafka → Abuse Detection Worker → Action Executor
                                                ↓
                                           Redis / PostgreSQL
                                          (state + decisions)
```

```python
# abuse/detector.py
from dataclasses import dataclass
from enum import Enum

class AbuseAction(Enum):
    WARN = "warn"
    THROTTLE = "throttle"
    BLOCK_TEMPORARY = "block_temporary"
    BLOCK_PERMANENT = "block_permanent"
    REQUIRE_CAPTCHA = "require_captcha"
    ESCALATE = "escalate"

@dataclass
class AbuseSignal:
    rule_name: str
    api_key: str
    tenant_id: str
    confidence: float  # 0.0 to 1.0
    action: AbuseAction
    metadata: dict

class AbuseDetector:
    def __init__(self, rules: list):
        self.rules = rules

    async def evaluate(self, event: dict) -> list[AbuseSignal]:
        signals = []
        for rule in self.rules:
            signal = await rule.check(event)
            if signal:
                signals.append(signal)

        signals.sort(key=lambda s: s.confidence, reverse=True)
        return signals
```

## Rule 1: Key Sharing Detection

Detect when a single API key is used from many distinct IP addresses or user agents within a short period. Normal usage from a single developer or small team produces 1-3 distinct IPs. Key sharing produces 10+.

```python
# abuse/rules/key_sharing.py
import redis.asyncio as aioredis
from datetime import datetime

class KeySharingRule:
    NAME = "key_sharing"
    THRESHOLD = 10  # distinct IPs in the window
    WINDOW_SEC = 3600

    def __init__(self, redis: aioredis.Redis):
        self.redis = redis

    async def check(self, event: dict) -> AbuseSignal | None:
        api_key = event["api_key"]
        ip = event["client_ip"]
        now = int(datetime.utcnow().timestamp())
        window_start = now - self.WINDOW_SEC

        key = f"abuse:ips:{api_key}"
        pipe = self.redis.pipeline()
        pipe.zadd(key, {ip: now})
        pipe.zremrangebyscore(key, 0, window_start)
        pipe.zcard(key)
        pipe.expire(key, self.WINDOW_SEC * 2)
        results = await pipe.execute()

        distinct_ips = results[2]
        if distinct_ips >= self.THRESHOLD:
            confidence = min(1.0, (distinct_ips - self.THRESHOLD) / self.THRESHOLD + 0.5)
            return AbuseSignal(
                rule_name=self.NAME,
                api_key=api_key,
                tenant_id=event["tenant_id"],
                confidence=confidence,
                action=AbuseAction.THROTTLE,
                metadata={"distinct_ips": distinct_ips, "threshold": self.THRESHOLD},
            )
        return None
```

## Rule 2: Quota Laundering Detection

Detect when multiple API keys from the same IP or device fingerprint all belong to free-tier accounts created recently. This catches automated signup scripts.

```python
# abuse/rules/quota_laundering.py
class QuotaLaunderingRule:
    NAME = "quota_laundering"
    MAX_FREE_KEYS_PER_IP = 3
    SIGNUP_WINDOW_DAYS = 7

    def __init__(self, db_pool, redis: aioredis.Redis):
        self.pool = db_pool
        self.redis = redis

    async def check(self, event: dict) -> AbuseSignal | None:
        ip = event["client_ip"]
        api_key = event["api_key"]

        async with self.pool.acquire() as conn:
            count = await conn.fetchval("""
                SELECT COUNT(DISTINCT ak.key_id)
                FROM api_keys ak
                JOIN rate_limit_tiers r ON ak.tier_id = r.tier_id
                JOIN tenants t ON ak.tenant_id = t.id
                WHERE t.signup_ip = $1
                  AND r.tier_name = 'free'
                  AND ak.created_at > NOW() - INTERVAL '%s days'
            """ % self.SIGNUP_WINDOW_DAYS, ip)

        if count > self.MAX_FREE_KEYS_PER_IP:
            return AbuseSignal(
                rule_name=self.NAME,
                api_key=api_key,
                tenant_id=event["tenant_id"],
                confidence=min(1.0, (count - self.MAX_FREE_KEYS_PER_IP) / 3 + 0.6),
                action=AbuseAction.BLOCK_TEMPORARY,
                metadata={"free_keys_from_ip": count},
            )
        return None
```

## Rule 3: Resource Exhaustion Detection

Detect tenants submitting an unusually high volume of long-video clip operations. A single 4-hour video costs as much GPU time as 48 five-minute clips.

```python
# abuse/rules/resource_exhaustion.py
class ResourceExhaustionRule:
    NAME = "resource_exhaustion"
    MAX_DAILY_GPU_SECONDS = 7200  # 2 hours of GPU time per day (free tier)

    def __init__(self, redis: aioredis.Redis):
        self.redis = redis

    async def check(self, event: dict) -> AbuseSignal | None:
        if event["path"] != "/api/v1/clip":
            return None

        api_key = event["api_key"]
        video_duration_sec = event.get("video_duration_sec", 0)
        tier = event.get("tier", "free")

        daily_limit = {
            "free": 7200,
            "starter": 36000,
            "pro": 144000,
            "enterprise": None,
        }.get(tier)

        if daily_limit is None:
            return None

        today = datetime.utcnow().strftime("%Y-%m-%d")
        key = f"abuse:gpu:{api_key}:{today}"

        pipe = self.redis.pipeline()
        pipe.incrby(key, video_duration_sec)
        pipe.expire(key, 86400)
        results = await pipe.execute()

        total_gpu_sec = results[0]
        if total_gpu_sec > daily_limit:
            return AbuseSignal(
                rule_name=self.NAME,
                api_key=api_key,
                tenant_id=event["tenant_id"],
                confidence=0.9,
                action=AbuseAction.THROTTLE,
                metadata={"daily_gpu_seconds": total_gpu_sec, "limit": daily_limit},
            )
        return None
```

## Action Executor

When abuse signals are detected, the action executor enforces the response:

```python
# abuse/executor.py
class AbuseActionExecutor:
    def __init__(self, redis: aioredis.Redis, db_pool, notification_service):
        self.redis = redis
        self.pool = db_pool
        self.notifier = notification_service

    async def execute(self, signal: AbuseSignal):
        if signal.action == AbuseAction.THROTTLE:
            # Reduce the tenant's rate limit to 20% of normal for 1 hour
            key = f"throttle:{signal.api_key}"
            await self.redis.setex(key, 3600, "0.2")
            await self._log_action(signal, "Throttled to 20% for 1 hour")

        elif signal.action == AbuseAction.BLOCK_TEMPORARY:
            # Block the API key for 24 hours
            key = f"blocked:{signal.api_key}"
            await self.redis.setex(key, 86400, signal.rule_name)
            await self._log_action(signal, "Blocked for 24 hours")

        elif signal.action == AbuseAction.BLOCK_PERMANENT:
            # Disable the key in the database
            async with self.pool.acquire() as conn:
                await conn.execute(
                    "UPDATE api_keys SET is_active = FALSE WHERE api_key = $1",
                    signal.api_key,
                )
            await self._log_action(signal, "Permanently blocked")

        elif signal.action == AbuseAction.REQUIRE_CAPTCHA:
            key = f"captcha:{signal.api_key}"
            await self.redis.setex(key, 3600, "1")
            await self._log_action(signal, "CAPTCHA required for 1 hour")

        elif signal.action == AbuseAction.ESCALATE:
            await self.notifier.send_alert(
                channel="abuse-escalation",
                message=f"Abuse detected: {signal.rule_name} on key {signal.api_key[:8]}... "
                        f"(confidence: {signal.confidence:.0%})",
                metadata=signal.metadata,
            )

    async def _log_action(self, signal: AbuseSignal, description: str):
        async with self.pool.acquire() as conn:
            await conn.execute("""
                INSERT INTO abuse_actions (api_key, tenant_id, rule_name, action, confidence, metadata, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, NOW())
            """, signal.api_key, signal.tenant_id, signal.rule_name,
                signal.action.value, signal.confidence, json.dumps(signal.metadata))
```

## Throttling Integration in the Rate Limiter

The rate limiter checks for active throttle overrides before evaluating limits:

```python
# In the middleware's limit resolution
async def get_effective_limit(self, api_key: str, base_limit: int) -> int:
    throttle_factor = await self.redis.get(f"throttle:{api_key}")
    if throttle_factor:
        return int(base_limit * float(throttle_factor))
    return base_limit
```

## IP Reputation and Blocking

Maintain an IP blocklist for known bad actors. Integrate with external threat intelligence feeds:

```python
# abuse/ip_reputation.py
import ipaddress

class IPReputationChecker:
    def __init__(self, redis: aioredis.Redis):
        self.redis = redis

    async def is_blocked(self, ip: str) -> bool:
        # Check exact IP
        if await self.redis.sismember("blocked:ips", ip):
            return True

        # Check CIDR ranges
        blocked_ranges = await self.redis.smembers("blocked:cidrs")
        ip_obj = ipaddress.ip_address(ip)
        for cidr in blocked_ranges:
            if ip_obj in ipaddress.ip_network(cidr.decode()):
                return True

        return False

    async def block_ip(self, ip: str, duration_sec: int = 86400):
        await self.redis.sadd("blocked:ips", ip)
        await self.redis.expire(f"blocked:ips", duration_sec)

    async def block_cidr(self, cidr: str):
        await self.redis.sadd("blocked:cidrs", cidr)
```

## CAPTCHA Enforcement

For requests flagged with `REQUIRE_CAPTCHA`, the API returns a challenge that the client must solve before proceeding:

```python
@app.middleware("http")
async def captcha_check(request: Request, call_next):
    api_key = extract_api_key(request)
    if not api_key:
        return await call_next(request)

    captcha_required = await redis.get(f"captcha:{api_key}")
    if captcha_required:
        captcha_token = request.headers.get("X-Captcha-Token")
        if not captcha_token:
            return JSONResponse(
                status_code=403,
                content={
                    "error": "captcha_required",
                    "captcha_site_key": CAPTCHA_SITE_KEY,
                    "message": "Complete the CAPTCHA to continue",
                },
            )
        if not await verify_captcha(captcha_token):
            return JSONResponse(status_code=403, content={"error": "captcha_invalid"})

        await redis.delete(f"captcha:{api_key}")

    return await call_next(request)
```

## Abuse Event Schema

All abuse events are stored in PostgreSQL for audit and analysis:

```sql
CREATE TABLE abuse_actions (
    id          BIGSERIAL PRIMARY KEY,
    api_key     VARCHAR(64) NOT NULL,
    tenant_id   UUID NOT NULL,
    rule_name   VARCHAR(100) NOT NULL,
    action      VARCHAR(50) NOT NULL,
    confidence  REAL NOT NULL,
    metadata    JSONB,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_abuse_actions_tenant ON abuse_actions(tenant_id, created_at);
CREATE INDEX idx_abuse_actions_api_key ON abuse_actions(api_key, created_at);
```

## Monitoring Abuse Trends

Query abuse patterns to identify emerging threats:

```sql
-- Top 10 tenants by abuse actions in the last 7 days
SELECT tenant_id, COUNT(*) as abuse_count,
       array_agg(DISTINCT rule_name) as triggered_rules
FROM abuse_actions
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY tenant_id
ORDER BY abuse_count DESC
LIMIT 10;

-- Abuse actions per rule per day
SELECT rule_name, DATE(created_at) as day, COUNT(*) as count
FROM abuse_actions
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY rule_name, DATE(created_at)
ORDER BY day DESC, count DESC;
```

Set up a Grafana dashboard with these queries and alert when any rule triggers more than 50 times per hour:

```yaml
# alerts/abuse.yml
groups:
  - name: abuse_detection
    rules:
      - alert: AbuseSpike
        expr: |
          sum by (rule_name) (
            increase(abuse_actions_total[1h])
          ) > 50
        for: 15m
        labels:
          severity: critical
        annotations:
          summary: "Abuse rule {{ $labels.rule_name }} triggered >50 times in 1 hour"
```

## Manual Override and Appeal Process

When a legitimate user is incorrectly flagged, administrators can lift blocks:

```bash
# Unthrottle a specific API key
redis-cli DEL "throttle:sk_live_abc123..."

# Unblock a temporarily blocked key
redis-cli DEL "blocked:sk_live_abc123..."

# Remove CAPTCHA requirement
redis-cli DEL "captcha:sk_live_abc123..."

# Re-enable a permanently disabled key
psql -c "UPDATE api_keys SET is_active = TRUE WHERE api_key = 'sk_live_abc123...';"
```

Log all manual overrides for audit:

```sql
CREATE TABLE abuse_manual_overrides (
    id          BIGSERIAL PRIMARY KEY,
    api_key     VARCHAR(64) NOT NULL,
    admin_user  VARCHAR(100) NOT NULL,
    reason      TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
```
