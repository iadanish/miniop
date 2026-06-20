# Cost Tracking

MiniOp processes video content through multiple cloud services — transcription, AI analysis, encoding, storage, and delivery. Without granular cost tracking, a single viral upload can silently burn through your budget. This document covers how to implement per-request, per-user, and per-feature cost accounting from free-tier prototypes to production scale.

## Architecture Overview

Every billable operation in MiniOp emits a cost event. Cost events flow through a unified tracking pipeline:

```
[Service Call] → [Cost Calculator] → [Event Bus] → [Cost Store] → [Dashboard/API]
```

The cost calculator is a thin wrapper around each service client that captures the unit price, quantity, and metadata before or after the call completes.

## Free Tier: Local SQLite Tracking

For development and free-tier deployments, store cost events in a local SQLite database. No external dependencies required.

### Schema

```sql
-- cost_tracking.sql
CREATE TABLE IF NOT EXISTS cost_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    request_id TEXT NOT NULL,
    user_id TEXT,
    service TEXT NOT NULL,         -- 'openai_whisper', 'openai_gpt4v', 'cloudflare_stream', 'r2_storage', 'cloudflare_cdn'
    operation TEXT NOT NULL,       -- 'transcribe', 'analyze', 'encode', 'store', 'deliver'
    units REAL NOT NULL,           -- seconds of audio, tokens, GB, requests
    unit_type TEXT NOT NULL,       -- 'seconds', 'tokens', 'gb', 'requests'
    unit_price REAL NOT NULL,      -- cost per unit in USD
    total_cost REAL NOT NULL,      -- units * unit_price
    metadata TEXT                  -- JSON blob with extra context
);

CREATE INDEX idx_cost_events_request ON cost_events(request_id);
CREATE INDEX idx_cost_events_user ON cost_events(user_id);
CREATE INDEX idx_cost_events_timestamp ON cost_events(timestamp);
CREATE INDEX idx_cost_events_service ON cost_events(service);
```

### Python Cost Tracker

```python
# minio/cost/tracker.py
import sqlite3
import json
import uuid
from datetime import datetime
from contextlib import contextmanager
from dataclasses import dataclass, asdict
from typing import Optional

@dataclass
class CostEvent:
    request_id: str
    user_id: Optional[str]
    service: str
    operation: str
    units: float
    unit_type: str
    unit_price: float
    total_cost: float
    metadata: Optional[dict] = None

class CostTracker:
    def __init__(self, db_path: str = "minio_costs.db"):
        self.db_path = db_path
        self._init_db()

    def _init_db(self):
        with self._conn() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS cost_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
                    request_id TEXT NOT NULL,
                    user_id TEXT,
                    service TEXT NOT NULL,
                    operation TEXT NOT NULL,
                    units REAL NOT NULL,
                    unit_type TEXT NOT NULL,
                    unit_price REAL NOT NULL,
                    total_cost REAL NOT NULL,
                    metadata TEXT
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_request ON cost_events(request_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_user ON cost_events(user_id)")

    @contextmanager
    def _conn(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def record(self, event: CostEvent):
        with self._conn() as conn:
            conn.execute(
                """INSERT INTO cost_events
                   (request_id, user_id, service, operation, units, unit_type, unit_price, total_cost, metadata)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (event.request_id, event.user_id, event.service, event.operation,
                 event.units, event.unit_type, event.unit_price, event.total_cost,
                 json.dumps(event.metadata) if event.metadata else None)
            )

    def get_request_cost(self, request_id: str) -> float:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT SUM(total_cost) as total FROM cost_events WHERE request_id = ?",
                (request_id,)
            ).fetchone()
            return row["total"] or 0.0

    def get_user_costs(self, user_id: str, since: Optional[str] = None) -> list[dict]:
        query = "SELECT * FROM cost_events WHERE user_id = ?"
        params = [user_id]
        if since:
            query += " AND timestamp >= ?"
            params.append(since)
        with self._conn() as conn:
            rows = conn.execute(query, params).fetchall()
            return [dict(r) for r in rows]

    def get_daily_summary(self, date: str) -> list[dict]:
        """Returns cost breakdown by service for a given date (YYYY-MM-DD)."""
        with self._conn() as conn:
            rows = conn.execute("""
                SELECT service, operation, COUNT(*) as count,
                       SUM(units) as total_units, SUM(total_cost) as total_cost
                FROM cost_events
                WHERE date(timestamp) = ?
                GROUP BY service, operation
                ORDER BY total_cost DESC
            """, (date,)).fetchall()
            return [dict(r) for r in rows]
```

### Integrating with Service Calls

Wrap each billable service to emit cost events automatically:

```python
# minio/cost/wrappers.py
import uuid
from minio.cost.tracker import CostTracker, CostEvent

# Current pricing (verify against provider dashboards)
PRICING = {
    "openai_whisper":     {"unit_type": "seconds", "price": 0.006 / 60},   # $0.006/min
    "openai_gpt4v":       {"unit_type": "tokens",  "price": 0.01 / 1000},  # $0.01/1K tokens
    "cloudflare_stream":  {"unit_type": "seconds", "price": 0.005 / 60},   # $0.005/min (Cloudflare Stream)
    "r2_storage":         {"unit_type": "gb",       "price": 0.015},        # $0.015/GB/month (Cloudflare R2)
    "cloudflare_cdn":     {"unit_type": "gb",       "price": 0.00},         # $0 egress (Cloudflare R2 zero egress)
}

tracker = CostTracker()

def track_transcription(audio_duration_seconds: float, request_id: str, user_id: str = None) -> CostEvent:
    pricing = PRICING["openai_whisper"]
    event = CostEvent(
        request_id=request_id,
        user_id=user_id,
        service="openai_whisper",
        operation="transcribe",
        units=audio_duration_seconds,
        unit_type=pricing["unit_type"],
        unit_price=pricing["price"],
        total_cost=audio_duration_seconds * pricing["price"],
        metadata={"duration_seconds": audio_duration_seconds}
    )
    tracker.record(event)
    return event

def track_encoding(duration_seconds: float, resolution: str, request_id: str, user_id: str = None) -> CostEvent:
    pricing = PRICING["cloudflare_stream"]
    event = CostEvent(
        request_id=request_id,
        user_id=user_id,
        service="cloudflare_stream",
        operation="encode",
        units=duration_seconds,
        unit_type=pricing["unit_type"],
        unit_price=pricing["price"],
        total_cost=duration_seconds * pricing["price"],
        metadata={"resolution": resolution}
    )
    tracker.record(event)
    return event

def track_storage(gb: float, request_id: str, user_id: str = None) -> CostEvent:
    pricing = PRICING["r2_storage"]
    event = CostEvent(
        request_id=request_id,
        user_id=user_id,
        service="r2_storage",
        operation="store",
        units=gb,
        unit_type=pricing["unit_type"],
        unit_price=pricing["price"],
        total_cost=gb * pricing["price"],
    )
    tracker.record(event)
    return event
```

### Usage in the Processing Pipeline

```python
# minio/pipeline/process.py
import uuid
from minio.cost.wrappers import track_transcription, track_encoding, track_storage

def process_video(video_path: str, user_id: str) -> dict:
    request_id = str(uuid.uuid4())

    # Step 1: Transcribe
    audio_duration = get_audio_duration(video_path)
    transcript = whisper_transcribe(video_path)
    track_transcription(audio_duration, request_id, user_id)

    # Step 2: AI analysis (clip selection)
    clips = gpt4v_analyze(transcript, video_path)

    # Step 3: Encode clips
    for clip in clips:
        encoded = mediaconvert_encode(video_path, clip["start"], clip["end"])
        track_encoding(clip["end"] - clip["start"], "1080p", request_id, user_id)

    # Step 4: Store
    total_size_gb = sum(c["size_bytes"] for c in encoded) / (1024**3)
    track_storage(total_size_gb, request_id, user_id)

    return {"request_id": request_id, "clips": len(clips), "cost": tracker.get_request_cost(request_id)}
```

## Production: PostgreSQL + TimescaleDB

At scale, move from SQLite to PostgreSQL with TimescaleDB hypertables for time-series cost data.

### Schema

```sql
-- production_cost_tracking.sql
CREATE TABLE cost_events (
    id BIGSERIAL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    request_id UUID NOT NULL,
    user_id TEXT,
    service TEXT NOT NULL,
    operation TEXT NOT NULL,
    units DOUBLE PRECISION NOT NULL,
    unit_type TEXT NOT NULL,
    unit_price DOUBLE PRECISION NOT NULL,
    total_cost DOUBLE PRECISION NOT NULL,
    metadata JSONB,
    PRIMARY KEY (id, timestamp)
);

SELECT create_hypertable('cost_events', 'timestamp', chunk_time_interval => INTERVAL '1 day');

CREATE INDEX idx_cost_request ON cost_events (request_id, timestamp DESC);
CREATE INDEX idx_cost_user ON cost_events (user_id, timestamp DESC);
CREATE INDEX idx_cost_service ON cost_events (service, timestamp DESC);
```

### Aggregation Views

```sql
-- Hourly rollup for dashboards
CREATE MATERIALIZED VIEW cost_hourly AS
SELECT
    time_bucket('1 hour', timestamp) AS hour,
    service,
    operation,
    COUNT(*) AS request_count,
    SUM(total_cost) AS total_cost,
    AVG(total_cost) AS avg_cost,
    SUM(units) AS total_units
FROM cost_events
GROUP BY hour, service, operation
WITH NO DATA;

-- Refresh on a schedule (via pg_cron or application scheduler)
-- SELECT cron.schedule('refresh-cost-hourly', '*/5 * * * *', 'REFRESH MATERIALIZED VIEW CONCURRENTLY cost_hourly');

-- Daily user summary
CREATE MATERIALIZED VIEW cost_daily_users AS
SELECT
    time_bucket('1 day', timestamp) AS day,
    user_id,
    COUNT(*) AS request_count,
    SUM(total_cost) AS total_cost
FROM cost_events
WHERE user_id IS NOT NULL
GROUP BY day, user_id
WITH NO DATA;
```

### Event Emission via Redis Streams

For high-throughput production, decouple cost recording from the request path:

```python
# minio/cost/async_tracker.py
import json
import redis

class AsyncCostTracker:
    def __init__(self, redis_url: str = "redis://localhost:6379"):
        self.redis = redis.from_url(redis_url)
        self.stream = "minio:cost_events"

    def emit(self, event: dict):
        self.redis.xadd(self.stream, {"payload": json.dumps(event)}, maxlen=50000)

# Consumer (runs as a separate worker)
def consume_cost_events():
    r = redis.from_url("redis://localhost:6379")
    conn = get_pg_connection()
    while True:
        entries = r.xread({"minio:cost_events": "$"}, count=100, block=5000)
        for stream, messages in entries:
            for msg_id, data in messages:
                event = json.loads(data["payload"])
                conn.execute(
                    """INSERT INTO cost_events
                       (request_id, user_id, service, operation, units, unit_type, unit_price, total_cost, metadata)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (event["request_id"], event.get("user_id"), event["service"],
                     event["operation"], event["units"], event["unit_type"],
                     event["unit_price"], event["total_cost"], json.dumps(event.get("metadata")))
                )
            conn.commit()
```

## Per-Request Cost Breakdown API

Expose cost data so users can see what each video processing job cost:

```python
# minio/api/costs.py
from fastapi import APIRouter, Depends
from minio.auth import get_current_user

router = APIRouter(prefix="/costs", tags=["costs"])

@router.get("/requests/{request_id}")
async def get_request_costs(request_id: str):
    events = tracker.get_request_cost_detail(request_id)
    return {
        "request_id": request_id,
        "total_cost": sum(e["total_cost"] for e in events),
        "breakdown": [
            {"service": e["service"], "operation": e["operation"], "cost": e["total_cost"]}
            for e in events
        ]
    }

@router.get("/users/me/summary")
async def get_my_costs(
    period: str = "30d",
    user = Depends(get_current_user)
):
    since = calculate_since(period)
    costs = tracker.get_user_costs(user.id, since=since)
    total = sum(c["total_cost"] for c in costs)
    by_service = {}
    for c in costs:
        by_service.setdefault(c["service"], 0.0)
        by_service[c["service"]] += c["total_cost"]
    return {"user_id": user.id, "period": period, "total_cost": round(total, 4), "by_service": by_service}
```

## Free Tier vs Production Summary

| Aspect | Free Tier | Production |
|--------|-----------|------------|
| Storage | SQLite file | PostgreSQL + TimescaleDB |
| Ingestion | Synchronous | Redis Streams async |
| Retention | Unlimited (small data) | 90 days hot, archive to R2 |
| Aggregation | On-query | Materialized views (5-min refresh) |
| Cost per event | ~$0 | ~$0.000003 (Redis + PG) |
| Dashboard | Local Grafana | Grafana Cloud or Metabase |

## Key Metrics to Track

1. **Cost per video processed** — total pipeline cost / video count
2. **Cost per user per day** — identifies heavy users
3. **Service cost distribution** — which service dominates spend
4. **Clip yield ratio** — clips produced / video processed (higher = better value)
5. **Storage accumulation rate** — GB/day to predict R2 growth
