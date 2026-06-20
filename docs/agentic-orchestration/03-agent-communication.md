# Agent Communication

This document covers how MiniOp agents exchange messages, share state, and coordinate work. Communication patterns differ significantly between free tier (in-process) and scaled production (distributed message broker).

## Communication Patterns

MiniOp agents use three communication patterns depending on the interaction type:

| Pattern | Use Case | Free Tier | Production |
|---------|----------|-----------|------------|
| **Fire-and-forget** | Logging, metrics, side effects | `EventEmitter.emit()` | Redis PUB/SUB |
| **Request-reply** | Agent-to-agent queries | Async function call | Redis Streams with reply-to |
| **Pub-sub fan-out** | Broadcasting state changes | `EventEmitter` with multiple listeners | Redis PUB/SUB or Kafka topics |

## Message Schema

All inter-agent messages follow a common envelope. This schema is shared across tiers — only the transport changes.

```typescript
// src/comms/message-envelope.ts
export interface MessageEnvelope<T = unknown> {
  id: string;                    // UUID v7 (time-sortable)
  type: string;                  // e.g. "clip.generated", "review.requested"
  source: string;                // agent name that produced the message
  timestamp: string;             // ISO 8601
  correlationId: string;         // traces a full pipeline run
  replyTo?: string;              // queue/topic for request-reply
  payload: T;
  metadata: {
    retryCount: number;
    maxRetries: number;
    priority: 'low' | 'normal' | 'high';
    ttl: number;                 // ms before message expires
  };
}

export function createMessage<T>(
  type: string,
  source: string,
  payload: T,
  opts: Partial<MessageEnvelope['metadata']> = {}
): MessageEnvelope<T> {
  return {
    id: crypto.randomUUID(),
    type,
    source,
    timestamp: new Date().toISOString(),
    correlationId: crypto.randomUUID(),
    payload,
    metadata: {
      retryCount: 0,
      maxRetries: 3,
      priority: 'normal',
      ttl: 300_000,
      ...opts,
    },
  };
}
```

## Free Tier: In-Process Event Bus

On free tier, agents run as coroutines inside a single Node.js process. The `EventBus` class provides typed channels with delivery guarantees.

```typescript
// src/comms/local-event-bus.ts
import { EventEmitter } from 'events';
import { AsyncLocalStorage } from 'async_hooks';
import type { MessageEnvelope } from './message-envelope';

type Handler<T = unknown> = (msg: MessageEnvelope<T>) => Promise<void>;

export class LocalEventBus {
  private emitter = new EventEmitter();
  private store = new AsyncLocalStorage<{ correlationId: string }>();
  private deadLetterQueue: MessageEnvelope[] = [];

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  publish<T>(msg: MessageEnvelope<T>): void {
    const ctx = this.store.getStore();
    if (ctx) msg.correlationId = ctx.correlationId;
    this.emitter.emit(msg.type, msg);
  }

  subscribe<T>(type: string, handler: Handler<T>): () => void {
    const wrapped = async (msg: MessageEnvelope<T>) => {
      try {
        await handler(msg);
      } catch (err) {
        if (msg.metadata.retryCount < msg.metadata.maxRetries) {
          const delay = Math.pow(2, msg.metadata.retryCount) * 100;
          setTimeout(() => {
            this.publish({
              ...msg,
              metadata: { ...msg.metadata, retryCount: msg.metadata.retryCount + 1 },
            });
          }, delay);
        } else {
          this.deadLetterQueue.push(msg);
          console.error(`[DLQ] Message ${msg.id} moved to dead letter queue after ${msg.metadata.maxRetries} retries`);
        }
      }
    };

    this.emitter.on(type, wrapped);
    return () => this.emitter.off(type, wrapped);
  }

  getDeadLetterQueue(): MessageEnvelope[] {
    return [...this.deadLetterQueue];
  }

  runWithContext<T>(correlationId: string, fn: () => Promise<T>): Promise<T> {
    return this.store.run({ correlationId }, fn);
  }
}

export const bus = new LocalEventBus();
```

### Request-Reply Pattern (Free Tier)

For synchronous agent-to-agent queries (e.g., clip-generator asking meta-enricher for scene tags):

```typescript
// src/comms/request-reply.ts
import { bus, type LocalEventBus } from './local-event-bus';
import type { MessageEnvelope } from './message-envelope';

export class RequestReplyClient {
  private pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private bus: LocalEventBus) {
    this.bus.subscribe('reply', async (msg) => {
      const handler = this.pending.get(msg.payload.requestId);
      if (!handler) return;
      clearTimeout(handler.timer);
      this.pending.delete(msg.payload.requestId);
      handler.resolve(msg.payload.result);
    });
  }

  async request<TReq, TRes>(
    type: string,
    payload: TReq,
    timeoutMs = 10_000
  ): Promise<TRes> {
    return new Promise((resolve, reject) => {
      const msg = createMessage(type, 'request-client', payload, { priority: 'high' });

      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new Error(`Request ${msg.id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(msg.id, { resolve: resolve as any, reject, timer });
      this.bus.publish(msg);
    });
  }
}

export function registerHandler<TReq, TRes>(
  bus: LocalEventBus,
  type: string,
  handler: (payload: TReq) => Promise<TRes>
): void {
  bus.subscribe(type, async (msg: MessageEnvelope<TReq>) => {
    const result = await handler(msg.payload);
    bus.publish(createMessage('reply', type, {
      requestId: msg.id,
      result,
    }));
  });
}
```

Usage in an agent:

```typescript
// Inside ClipGenerator
const tags = await replyClient.request<{ videoId: string }, string[]>(
  'enrich.get-tags',
  { videoId: 'abc123' }
);
```

## Scaled Production: Redis Streams

In production, agents are separate containers. Communication uses Redis Streams for ordered, durable message delivery with consumer groups.

### Producer

```typescript
// src/comms/redis-producer.ts
import Redis from 'ioredis';
import type { MessageEnvelope } from './message-envelope';

export class RedisProducer {
  private redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
  }

  async publish<T>(stream: string, msg: MessageEnvelope<T>): Promise<string> {
    const flat = this.flatten(msg);
    return this.redis.xadd(stream, 'MAXLEN', '~', '100000', '*', ...flat);
  }

  async publishBatch<T>(stream: string, messages: MessageEnvelope<T>[]): Promise<void> {
    const pipeline = this.redis.pipeline();
    for (const msg of messages) {
      const flat = this.flatten(msg);
      pipeline.xadd(stream, 'MAXLEN', '~', '100000', '*', ...flat);
    }
    await pipeline.exec();
  }

  private flatten(msg: MessageEnvelope): string[] {
    return [
      'id', msg.id,
      'type', msg.type,
      'source', msg.source,
      'timestamp', msg.timestamp,
      'correlationId', msg.correlationId,
      'payload', JSON.stringify(msg.payload),
      'metadata', JSON.stringify(msg.metadata),
      ...(msg.replyTo ? ['replyTo', msg.replyTo] : []),
    ];
  }
}
```

### Consumer with Consumer Groups

```typescript
// src/comms/redis-consumer.ts
import Redis from 'ioredis';
import type { MessageEnvelope } from './message-envelope';

export class RedisConsumer {
  private redis: Redis;
  private running = false;

  constructor(
    redisUrl: string,
    private stream: string,
    private group: string,
    private consumer: string
  ) {
    this.redis = new Redis(redisUrl);
  }

  async start(handler: (msg: MessageEnvelope) => Promise<void>): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.stream, this.group, '0', 'MKSTREAM');
    } catch {} // group exists

    this.running = true;

    while (this.running) {
      const results = await this.redis.xreadgroup(
        'GROUP', this.group, this.consumer,
        'COUNT', 10,
        'BLOCK', 5000,
        'STREAMS', this.stream, '>'
      );

      if (!results) continue;

      for (const [, messages] of results) {
        for (const [id, fields] of messages) {
          const msg = this.unflatten(fields);
          try {
            await handler(msg);
            await this.redis.xack(this.stream, this.group, id);
          } catch (err) {
            console.error(`[Consumer] Failed to process ${id}:`, err);
            // Message stays pending for retry via XCLAIM
          }
        }
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private unflatten(fields: string[]): MessageEnvelope {
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
    return {
      id: obj.id,
      type: obj.type,
      source: obj.source,
      timestamp: obj.timestamp,
      correlationId: obj.correlationId,
      replyTo: obj.replyTo,
      payload: JSON.parse(obj.payload),
      metadata: JSON.parse(obj.metadata),
    };
  }
}
```

### Claiming Stale Messages

When a consumer crashes mid-processing, its unacknowledged messages become stale. The `XCLAIM` command transfers ownership to a healthy consumer:

```typescript
async claimStaleMessages(minIdleMs = 60_000): Promise<MessageEnvelope[]> {
  const pending = await this.redis.xpending(
    this.stream, this.group, 'IDLE', minIdleMs, '-', '+', '10', this.consumer
  );

  if (!pending || pending.length === 0) return [];

  const ids = pending.map((p: any) => p[0]);
  const claimed = await this.redis.xclaim(
    this.stream, this.group, this.consumer, minIdleMs, ...ids
  );

  return claimed.map(([, fields]: any) => this.unflatten(fields));
}
```

Run this as a periodic task (every 30 seconds) in each consumer.

## Pub-Sub Fan-Out

For broadcasting state changes (e.g., "pipeline completed" to multiple dashboard instances), use Redis PUB/SUB alongside Streams. Streams guarantee delivery; PUB/SUB is fire-and-forget for real-time subscribers.

```typescript
// src/comms/redis-pubsub.ts
import Redis from 'ioredis';

export class PubSub {
  private pub: Redis;
  private sub: Redis;

  constructor(redisUrl: string) {
    this.pub = new Redis(redisUrl);
    this.sub = new Redis(redisUrl);
  }

  async publish(channel: string, data: unknown): Promise<void> {
    await this.pub.publish(channel, JSON.stringify(data));
  }

  subscribe(channel: string, handler: (data: unknown) => void): void {
    this.sub.subscribe(channel);
    this.sub.on('message', (ch, message) => {
      if (ch === channel) handler(JSON.parse(message));
    });
  }
}
```

## Correlation ID Propagation

Every pipeline run gets a `correlationId` that flows through all messages. This enables end-to-end tracing across agents.

```typescript
// src/comms/tracing.ts
import { AsyncLocalStorage } from 'async_hooks';
import type { MessageEnvelope } from './message-envelope';

export const traceContext = new AsyncLocalStorage<{ correlationId: string }>();

export function withTrace<T>(msg: MessageEnvelope, fn: () => Promise<T>): Promise<T> {
  return traceContext.run({ correlationId: msg.correlationId }, fn);
}

export function currentTraceId(): string | undefined {
  return traceContext.getStore()?.correlationId;
}
```

Wrap every consumer handler in `withTrace`:

```typescript
consumer.start(async (msg) => {
  await withTrace(msg, async () => {
    // All downstream calls automatically carry the correlationId
    await processMessage(msg);
  });
});
```

## Message Priority

High-priority messages (user-initiated requests) skip the queue tail. On free tier, use separate `EventEmitter` channels with ordered processing:

```typescript
// Priority routing in LocalEventBus
private priorityHandlers = new Map<string, Handler[]>();

subscribe<T>(type: string, handler: Handler<T>, priority = 'normal'): void {
  if (priority === 'high') {
    const handlers = this.priorityHandlers.get(type) ?? [];
    handlers.unshift(handler as Handler);
    this.priorityHandlers.set(type, handlers);
  }
  // ... normal subscription
}
```

In production, use separate Redis Streams per priority level:

```
clip.requests.high    — processed first, lower concurrency
clip.requests.normal  — default stream
clip.requests.low     — batch processing, high concurrency
```

## Error Handling and Dead Letter Queue

Messages that exhaust retries are routed to a DLQ stream. An operator dashboard reads from the DLQ for manual inspection.

```typescript
// DLQ consumer for debugging
const dlqConsumer = new RedisConsumer(redisUrl, 'stream:dlq', 'dlq-handlers', 'dashboard-1');

dlqConsumer.start(async (msg) => {
  console.error(`[DLQ] ${msg.type} from ${msg.source}:`, JSON.stringify(msg.payload, null, 2));
  // Store to database for operator review
  await db.dlqEntries.create({
    messageId: msg.id,
    type: msg.type,
    source: msg.source,
    payload: msg.payload,
    failedAt: new Date(),
  });
});
```

## Health Ping

Agents periodically publish health pings. The supervisor monitors these to detect unresponsive agents:

```typescript
// Inside each agent — runs every 15 seconds
setInterval(() => {
  bus.publish(createMessage('agent.health', this.name, {
    status: 'healthy',
    uptime: process.uptime(),
    memoryMb: process.memoryUsage().heapUsed / 1024 / 1024,
    pendingTasks: this.pendingCount,
  }));
}, 15_000);

// Supervisor watches for missing pings
const lastPing = new Map<string, number>();

bus.subscribe('agent.health', async (msg) => {
  lastPing.set(msg.source, Date.now());
});

setInterval(() => {
  const now = Date.now();
  for (const [agent, lastSeen] of lastPing) {
    if (now - lastSeen > 45_000) { // 3 missed pings
      console.error(`[Supervisor] Agent ${agent} unresponsive — last seen ${new Date(lastSeen).toISOString()}`);
      alertOpsChannel(agent);
    }
  }
}, 15_000);
```

## Testing Communication

Use a mock bus for unit tests and a real Redis instance for integration tests:

```typescript
// test/helpers/mock-bus.ts
export class MockBus {
  private handlers = new Map<string, Function[]>();
  published: MessageEnvelope[] = [];

  subscribe(type: string, handler: Function): () => void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
    return () => { /* cleanup */ };
  }

  publish(msg: MessageEnvelope): void {
    this.published.push(msg);
    for (const handler of this.handlers.get(msg.type) ?? []) {
      handler(msg);
    }
  }
}
```

For integration tests, spin up Redis with Testcontainers:

```typescript
import { GenericContainer } from 'testcontainers';

const redis = await new GenericContainer('redis:7')
  .withExposedPorts(6379)
  .start();

const redisUrl = `redis://localhost:${redis.getMappedPort(6379)}`;
// Use redisUrl in your tests
```
