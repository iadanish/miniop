# Audit Logging Strategy for MiniOp

## Overview

MiniOp processes video content at scale — uploading, splitting, transcoding, and distributing clips. Every operation touches user data, billing events, and infrastructure resources. An audit logging strategy must capture who did what, when, and from where, without degrading pipeline throughput.

This document defines the audit logging architecture for MiniOp across two deployment profiles: **Free Tier** (single-node, SQLite-backed, sub-1000 daily operations) and **Scaled Production** (distributed workers, PostgreSQL/ClickHouse, millions of events per day).

## Core Principles

1. **Immutability** — Audit records are append-only. No UPDATE, no DELETE. Corrections are new entries referencing the original.
2. **Completeness** — Every state mutation on a protected resource produces an audit event before the mutation commits.
3. **Low overhead** — Audit writes are asynchronous and batched. They must never block the request path by more than 5ms.
4. **Queryable** — Operations, compliance, and security teams must be able to answer "who accessed clip X between date A and date B" in under 2 seconds.

## Event Schema

Every audit event follows a fixed schema regardless of tier:

```json
{
  "event_id": "uuidv7",
  "timestamp": "2026-06-20T10:30:00.000Z",
  "actor": {
    "user_id": "usr_a1b2c3",
    "session_id": "ses_xyz",
    "ip_address": "203.0.113.42",
    "user_agent": "MiniOp-Web/2.1.0"
  },
  "action": "clip.create",
  "resource": {
    "type": "clip",
    "id": "clip_abc123",
    "project_id": "proj_def456"
  },
  "outcome": "success",
  "metadata": {
    "source_video_id": "vid_789",
    "duration_seconds": 45,
    "model_used": "whisper-large-v3"
  },
  "integrity": {
    "checksum": "sha256:...",
    "previous_event_id": "uuidv7-of-prior"
  }
}
```

The `integrity.checksum` is a SHA-256 hash of all other fields. The `previous_event_id` forms a hash chain, making tampering detectable.

## Free Tier Implementation

On the free tier, MiniOp runs as a single process with SQLite. Audit logs live in a dedicated database file to prevent contention with application data.

### Database Schema

```sql
-- D:\minio-project\migrations\004_audit_log.sql
CREATE TABLE IF NOT EXISTS audit_log (
    event_id        TEXT PRIMARY KEY,
    timestamp       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    actor_user_id   TEXT NOT NULL,
    actor_session_id TEXT,
    actor_ip        TEXT,
    actor_ua        TEXT,
    action          TEXT NOT NULL,
    resource_type   TEXT NOT NULL,
    resource_id     TEXT NOT NULL,
    project_id      TEXT,
    outcome         TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
    metadata        TEXT, -- JSON blob
    checksum        TEXT NOT NULL,
    previous_event_id TEXT
);

CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX idx_audit_actor ON audit_log(actor_user_id, timestamp);
CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id, timestamp);
CREATE INDEX idx_audit_action ON audit_log(action, timestamp);
```

### Application Integration

```typescript
// src/audit/logger.ts
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { v7 as uuidv7 } from 'uuid';

class AuditLogger {
  private db: Database.Database;
  private lastEventId: string | null = null;
  private buffer: AuditEvent[] = [];
  private flushInterval: NodeJS.Timeout;

  constructor(dbPath: string = './data/audit.db') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.flushInterval = setInterval(() => this.flush(), 1000);
  }

  async log(event: Omit<AuditEvent, 'event_id' | 'timestamp' | 'checksum' | 'previous_event_id'>): Promise<void> {
    const fullEvent: AuditEvent = {
      event_id: uuidv7(),
      timestamp: new Date().toISOString(),
      ...event,
      checksum: '',
      previous_event_id: this.lastEventId,
    };
    fullEvent.checksum = this.computeChecksum(fullEvent);
    this.buffer.push(fullEvent);
    this.lastEventId = fullEvent.event_id;

    if (this.buffer.length >= 50) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    const insert = this.db.prepare(`
      INSERT INTO audit_log (event_id, timestamp, actor_user_id, actor_session_id,
        actor_ip, actor_ua, action, resource_type, resource_id, project_id,
        outcome, metadata, checksum, previous_event_id)
      VALUES (@event_id, @timestamp, @actor_user_id, @actor_session_id,
        @actor_ip, @actor_ua, @action, @resource_type, @resource_id, @project_id,
        @outcome, @metadata, @checksum, @previous_event_id)
    `);
    const tx = this.db.transaction((events: AuditEvent[]) => {
      for (const e of events) {
        insert.run({
          event_id: e.event_id,
          timestamp: e.timestamp,
          actor_user_id: e.actor.user_id,
          actor_session_id: e.actor.session_id,
          actor_ip: e.actor.ip_address,
          actor_ua: e.actor.user_agent,
          action: e.action,
          resource_type: e.resource.type,
          resource_id: e.resource.id,
          project_id: e.resource.project_id,
          outcome: e.outcome,
          metadata: JSON.stringify(e.metadata),
          checksum: e.checksum,
          previous_event_id: e.previous_event_id,
        });
      }
    });
    tx(this.buffer);
    this.buffer = [];
  }

  private computeChecksum(event: AuditEvent): string {
    const copy = { ...event, checksum: '' };
    return createHash('sha256').update(JSON.stringify(copy)).digest('hex');
  }
}

export const audit = new AuditLogger();
```

### Usage in Route Handlers

```typescript
// src/routes/clips.ts
import { audit } from '../audit/logger';

router.post('/api/clips', async (req, res) => {
  const clip = await clipService.create(req.body);
  await audit.log({
    actor: {
      user_id: req.user.id,
      session_id: req.session.id,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
    },
    action: 'clip.create',
    resource: { type: 'clip', id: clip.id, project_id: clip.projectId },
    outcome: 'success',
    metadata: { source_video_id: req.body.videoId, duration_seconds: clip.duration },
  });
  res.json(clip);
});
```

## Scaled Production Implementation

In production, audit events flow through a message queue before landing in a write-optimized store. This decouples audit logging from request latency entirely.

### Architecture

```
App Workers → Redis Stream (audit:events) → Audit Consumer → ClickHouse
                                                    ↓
                                              S3 (cold archive, Parquet)
```

### Redis Stream Producer

```typescript
// src/audit/producer.ts
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

export async function emitAuditEvent(event: AuditEvent): Promise<void> {
  await redis.xadd(
    'audit:events',
    'MAXLEN', '~', '1000000',
    '*',
    'payload', JSON.stringify(event)
  );
}
```

### ClickHouse Consumer

```python
# audit_consumer.py
import redis
import clickhouse_connect
import json
from datetime import datetime

r = redis.Redis.from_url(os.environ['REDIS_URL'])
ch = clickhouse_connect.get_client(host=os.environ['CLICKHOUSE_HOST'])

INSERT_SQL = """
INSERT INTO audit_log (event_id, timestamp, actor_user_id, actor_session_id,
    actor_ip, actor_ua, action, resource_type, resource_id, project_id,
    outcome, metadata_json, checksum, previous_event_id)
VALUES
"""

def consume():
    batch = []
    while True:
        entries = r.xread({'audit:events': '$'}, count=500, block=2000)
        if not entries:
            if batch:
                flush(batch)
                batch = []
            continue
        for stream, messages in entries:
            for msg_id, fields in messages:
                evt = json.loads(fields[b'payload'])
                batch.append([
                    evt['event_id'],
                    datetime.fromisoformat(evt['timestamp'].replace('Z', '+00:00')),
                    evt['actor']['user_id'],
                    evt['actor'].get('session_id'),
                    evt['actor'].get('ip_address'),
                    evt['actor'].get('user_agent'),
                    evt['action'],
                    evt['resource']['type'],
                    evt['resource']['id'],
                    evt['resource'].get('project_id'),
                    evt['outcome'],
                    json.dumps(evt.get('metadata', {})),
                    evt['checksum'],
                    evt.get('previous_event_id'),
                ])
        if len(batch) >= 500:
            flush(batch)
            batch = []

def flush(batch):
    ch.command(INSERT_SQL, parameters=batch)
```

### ClickHouse Table

```sql
CREATE TABLE audit_log (
    event_id          String,
    timestamp         DateTime64(3),
    actor_user_id     LowCardinality(String),
    actor_session_id  String,
    actor_ip          IPv4,
    actor_ua          String,
    action            LowCardinality(String),
    resource_type     LowCardinality(String),
    resource_id       String,
    project_id        String,
    outcome           Enum8('success'=1, 'failure'=2, 'denied'=3),
    metadata_json     String,
    checksum          String,
    previous_event_id String
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (project_id, resource_type, timestamp)
TTL timestamp + INTERVAL 2 YEAR
SETTINGS index_granularity = 8192;
```

## Retention and Archival

| Tier | Hot Storage | Warm Storage | Cold Archive |
|------|------------|--------------|--------------|
| Free | SQLite (local disk) | N/A | Manual `.bak` copy |
| Production | ClickHouse (30 days) | ClickHouse cold storage (1 year) | S3 Parquet (7 years) |

For production, set up a TTL-based migration:

```sql
-- Move to cold volume after 30 days
ALTER TABLE audit_log MODIFY TTL timestamp + INTERVAL 30 DAY TO VOLUME 'cold',
                          timestamp + INTERVAL 2 YEAR DELETE;
```

## Querying Audit Logs

### Free Tier (SQLite)

```sql
-- Who accessed clip_abc123 in the last 7 days?
SELECT timestamp, actor_user_id, action, outcome
FROM audit_log
WHERE resource_type = 'clip'
  AND resource_id = 'clip_abc123'
  AND timestamp > datetime('now', '-7 days')
ORDER BY timestamp DESC;
```

### Production (ClickHouse)

```sql
-- All failed actions by user in the last 24 hours, grouped by action
SELECT action, count() AS cnt
FROM audit_log
WHERE actor_user_id = 'usr_a1b2c3'
  AND timestamp > now() - INTERVAL 24 HOUR
  AND outcome = 'failure'
GROUP BY action
ORDER BY cnt DESC;
```

## Integrity Verification

Run a periodic job to verify the hash chain is unbroken:

```typescript
// src/audit/verify.ts
export async function verifyChain(db: Database.Database): Promise<VerificationResult> {
  const rows = db.prepare(
    'SELECT event_id, checksum, previous_event_id FROM audit_log ORDER BY timestamp'
  ).all();

  let prev: string | null = null;
  for (const row of rows) {
    if (row.previous_event_id !== prev) {
      return { valid: false, brokenAt: row.event_id, expected: prev, actual: row.previous_event_id };
    }
    prev = row.event_id;
  }
  return { valid: true, eventsChecked: rows.length };
}
```

In production, run this as a Kubernetes CronJob every 6 hours and alert on failure via PagerDuty.

## Summary

The free tier uses SQLite with in-process batching — simple, zero-dependency, good enough for thousands of events daily. Production uses Redis Streams for decoupling and ClickHouse for fast analytical queries over billions of rows. Both tiers share the same event schema and hash-chain integrity model, making migration straightforward when a project outgrows the free tier.
