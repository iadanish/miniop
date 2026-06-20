# Event Logging Implementation for MiniOp

## Purpose

Event logging captures discrete system occurrences — video uploads, transcription jobs, clip generation, export requests, user authentication, billing changes. Unlike audit logging (which is security-focused and immutable), event logging is operational. It feeds dashboards, alerting, debugging pipelines, and usage analytics.

This document specifies the event taxonomy, transport, storage, and querying patterns for MiniOp's event system.

## Event Taxonomy

MiniOp events follow a three-level hierarchy: `domain.action.detail`. Every event must be registered in the taxonomy before it can be emitted.

```typescript
// src/events/taxonomy.ts
export const EVENT_TAXONOMY = {
  // Video pipeline
  'video.upload.started':           { severity: 'info',  category: 'pipeline' },
  'video.upload.completed':         { severity: 'info',  category: 'pipeline' },
  'video.upload.failed':            { severity: 'error', category: 'pipeline' },
  'video.transcode.started':        { severity: 'info',  category: 'pipeline' },
  'video.transcode.progress':       { severity: 'debug', category: 'pipeline' },
  'video.transcode.completed':      { severity: 'info',  category: 'pipeline' },
  'video.transcode.failed':         { severity: 'error', category: 'pipeline' },

  // Clip generation
  'clip.analysis.started':          { severity: 'info',  category: 'pipeline' },
  'clip.analysis.completed':        { severity: 'info',  category: 'pipeline' },
  'clip.segment.created':           { severity: 'info',  category: 'pipeline' },
  'clip.render.started':            { severity: 'info',  category: 'pipeline' },
  'clip.render.completed':          { severity: 'info',  category: 'pipeline' },
  'clip.export.requested':          { severity: 'info',  category: 'pipeline' },
  'clip.export.completed':          { severity: 'info',  category: 'pipeline' },

  // Auth and account
  'auth.login':                     { severity: 'info',  category: 'auth' },
  'auth.logout':                    { severity: 'info',  category: 'auth' },
  'auth.token.refreshed':           { severity: 'debug', category: 'auth' },
  'auth.password.changed':          { severity: 'warn',  category: 'auth' },
  'account.plan.changed':           { severity: 'info',  category: 'billing' },
  'account.usage.limit_hit':        { severity: 'warn',  category: 'billing' },

  // System
  'system.worker.started':          { severity: 'info',  category: 'system' },
  'system.worker.crashed':          { severity: 'error', category: 'system' },
  'system.queue.backpressure':      { severity: 'warn',  category: 'system' },
  'system.storage.threshold':       { severity: 'warn',  category: 'system' },
} as const;

export type EventName = keyof typeof EVENT_TAXONOMY;
```

## Event Structure

```typescript
// src/events/types.ts
export interface Event<T = Record<string, unknown>> {
  id: string;              // uuidv7
  name: EventName;
  timestamp: string;       // ISO 8601
  source: string;          // service identifier: "api", "transcoder", "analyzer"
  version: number;         // schema version for this event type
  correlation_id: string;  // request/operation trace ID
  actor?: {
    type: 'user' | 'system' | 'cron';
    id: string;
  };
  payload: T;
  context: {
    environment: 'development' | 'staging' | 'production';
    region: string;
    instance_id: string;
  };
}
```

## Emitter Implementation

### Free Tier: In-Process EventEmitter

On the free tier, events are emitted synchronously through Node's EventEmitter and written to a rotating JSONL file.

```typescript
// src/events/emitter-local.ts
import { EventEmitter } from 'events';
import { appendFileSync, renameSync, statSync } from 'fs';
import { v7 as uuidv7 } from 'uuid';

class LocalEventEmitter extends EventEmitter {
  private logPath: string;
  private maxFileSize: number;
  private currentSize: number = 0;

  constructor(logPath: string = './data/events.jsonl', maxFileSize: number = 50 * 1024 * 1024) {
    super();
    this.logPath = logPath;
    this.maxFileSize = maxFileSize;
    this.currentSize = this.getFileSize();
  }

  emitEvent<T>(name: EventName, payload: T, actor?: Event['actor'], correlationId?: string): void {
    const event: Event<T> = {
      id: uuidv7(),
      name,
      timestamp: new Date().toISOString(),
      source: 'api',
      version: 1,
      correlation_id: correlationId || uuidv7(),
      actor,
      payload,
      context: {
        environment: 'development',
        region: 'local',
        instance_id: 'main',
      },
    };

    const line = JSON.stringify(event) + '\n';

    if (this.currentSize + line.length > this.maxFileSize) {
      this.rotate();
    }

    appendFileSync(this.logPath, line, 'utf-8');
    this.currentSize += line.length;
    this.emit(name, event);
  }

  private rotate(): void {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    renameSync(this.logPath, `${this.logPath}.${ts}`);
    this.currentSize = 0;
  }

  private getFileSize(): number {
    try {
      return statSync(this.logPath).size;
    } catch {
      return 0;
    }
  }
}

export const events = new LocalEventEmitter();
```

Usage:

```typescript
import { events } from './events/emitter-local';

events.emitEvent('video.upload.completed', {
  videoId: 'vid_abc',
  sizeBytes: 52428800,
  durationSeconds: 120,
  format: 'mp4',
}, { type: 'user', id: req.user.id });
```

### Production: Redis Streams + Kafka Bridge

For production, events flow through Redis Streams for internal consumption and optionally bridge to Kafka for external integrations.

```typescript
// src/events/emitter-redis.ts
import Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';

class RedisEventEmitter {
  private redis: Redis;
  private streamName = 'events:main';
  private consumers: Map<string, Set<(event: Event) => void>> = new Map();

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
  }

  async emit<T>(name: EventName, payload: T, opts: Partial<Event> = {}): Promise<string> {
    const event: Event<T> = {
      id: uuidv7(),
      name,
      timestamp: new Date().toISOString(),
      source: opts.source || 'api',
      version: 1,
      correlation_id: opts.correlation_id || uuidv7(),
      actor: opts.actor,
      payload,
      context: {
        environment: process.env.NODE_ENV as any,
        region: process.env.AWS_REGION || 'us-east-1',
        instance_id: process.env.HOSTNAME || 'unknown',
      },
    };

    await this.redis.xadd(
      this.streamName,
      'MAXLEN', '~', '5000000',
      '*',
      'name', name,
      'payload', JSON.stringify(event),
    );

    // Notify in-process subscribers
    const category = EVENT_TAXONOMY[name].category;
    this.consumers.get(category)?.forEach(fn => fn(event));
    this.consumers.get('*')?.forEach(fn => fn(event));

    return event.id;
  }

  subscribe(category: string, handler: (event: Event) => void): () => void {
    if (!this.consumers.has(category)) {
      this.consumers.set(category, new Set());
    }
    this.consumers.get(category)!.add(handler);
    return () => this.consumers.get(category)?.delete(handler);
  }
}

export const events = new RedisEventEmitter(process.env.REDIS_URL);
```

## Event Consumer: Processing and Routing

```python
# event_consumer.py
import redis
import json
import logging
from datetime import datetime

r = redis.Redis.from_url(os.environ['REDIS_URL'])

ALERT_RULES = {
    'video.upload.failed': {'threshold': 10, 'window_seconds': 300, 'channel': 'slack'},
    'system.worker.crashed': {'threshold': 1, 'window_seconds': 60, 'channel': 'pagerduty'},
    'system.queue.backpressure': {'threshold': 5, 'window_seconds': 120, 'channel': 'slack'},
}

def process_events():
    last_id = '0'
    while True:
        results = r.xread({'events:main': last_id}, count=100, block=5000)
        if not results:
            continue
        for stream, messages in results:
            for msg_id, fields in messages:
                last_id = msg_id
                event = json.loads(fields[b'payload'])
                handle_event(event)

def handle_event(event):
    name = event['name']
    # Write to ClickHouse for analytics
    write_to_clickhouse(event)
    # Check alerting rules
    if name in ALERT_RULES:
        check_alert(name, event)

def check_alert(name, event):
    rule = ALERT_RULES[name]
    key = f"alert_count:{name}"
    r.incr(key)
    r.expire(key, rule['window_seconds'])
    count = int(r.get(key))
    if count >= rule['threshold']:
        send_alert(rule['channel'], name, count, rule['window_seconds'])
        r.delete(key)
```

## ClickHouse Schema for Events

```sql
CREATE TABLE events (
    id              String,
    name            LowCardinality(String),
    timestamp       DateTime64(3),
    source          LowCardinality(String),
    version         UInt16,
    correlation_id  String,
    actor_type      Enum8('user'=1, 'system'=2, 'cron'=3),
    actor_id        String,
    payload_json    String,
    environment     LowCardinality(String),
    region          LowCardinality(String),
    instance_id     String
) ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (name, timestamp)
TTL timestamp + INTERVAL 90 DAY;

CREATE MATERIALIZED VIEW events_by_actor
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (actor_id, name, toStartOfHour(timestamp))
AS SELECT
    actor_id,
    name,
    toStartOfHour(timestamp) AS hour,
    count() AS event_count
FROM events
GROUP BY actor_id, name, hour;
```

## Querying Events

### Dashboard Query: Clip Generation Rate

```sql
SELECT
    toStartOfInterval(timestamp, INTERVAL 15 MINUTE) AS bucket,
    count() AS clips_generated
FROM events
WHERE name = 'clip.render.completed'
  AND timestamp > now() - INTERVAL 24 HOUR
GROUP BY bucket
ORDER BY bucket;
```

### Debugging: Trace a Correlation ID

```sql
SELECT timestamp, name, source, payload_json
FROM events
WHERE correlation_id = 'abc-123-def'
ORDER BY timestamp;
```

### Usage: Count Videos per User This Month

```sql
SELECT
    actor_id,
    count() AS video_count
FROM events
WHERE name = 'video.upload.completed'
  AND timestamp >= toStartOfMonth(now())
GROUP BY actor_id
ORDER BY video_count DESC
LIMIT 100;
```

## Log Level Configuration

```yaml
# config/events.yaml
logging:
  levels:
    pipeline: info      # Show upload/transcode/clip lifecycle events
    auth: info          # Login/logout events
    billing: info       # Plan changes, usage limits
    system: warn        # Only warnings and errors from infrastructure
  suppress:
    - video.transcode.progress  # High-frequency, low-value in production
    - auth.token.refreshed
```

In code:

```typescript
const config = loadConfig();

function shouldEmit(eventName: EventName): boolean {
  const meta = EVENT_TAXONOMY[eventName];
  if (config.logging.suppress.includes(eventName)) return false;
  const levelPriority = { debug: 0, info: 1, warn: 2, error: 3 };
  const configured = levelPriority[config.logging.levels[meta.category] || 'info'];
  const severity = levelPriority[meta.severity];
  return severity >= configured;
}
```

## Integration with Monitoring

Feed events into Grafana via the ClickHouse datasource plugin. Key panels:

1. **Pipeline throughput** — `clip.render.completed` count per 5-minute window
2. **Error rate** — `*.failed` events as a ratio of total events
3. **Queue depth proxy** — `system.queue.backpressure` frequency
4. **User activity heatmap** — `auth.login` grouped by hour and region

Set up Prometheus-compatible metrics export:

```typescript
// src/events/metrics.ts
import { register, Counter } from 'prom-client';

const eventsTotal = new Counter({
  name: 'minio_events_total',
  help: 'Total events emitted',
  labelNames: ['name', 'category', 'severity'],
});

events.subscribe('*', (event) => {
  const meta = EVENT_TAXONOMY[event.name];
  eventsTotal.inc({ name: event.name, category: meta.category, severity: meta.severity });
});
```

## Summary

Event logging in MiniOp uses a structured taxonomy to ensure every system occurrence is categorized, schema-versioned, and queryable. The free tier writes to rotating JSONL files with in-process EventEmitter. Production uses Redis Streams for transport and ClickHouse for storage, enabling real-time dashboards and alerting. Both tiers share the same event schema, making local development consistent with production behavior.
