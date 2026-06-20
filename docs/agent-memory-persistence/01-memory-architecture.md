# Agent Memory Architecture for MiniOp

## Overview

MiniOp's agents — video analyzers, clip generators, transcription processors, export optimizers — accumulate state during their execution: intermediate results, learned preferences, model cache positions, and partial computations. This memory must persist across agent restarts, scale horizontally, and be accessible to cooperating agents without creating tight coupling.

This document defines the memory architecture for MiniOp agents, covering storage tiers, access patterns, consistency guarantees, and implementation for both free-tier and production deployments.

## Memory Tiers

| Tier | Purpose | Latency | Capacity | Persistence | Use Case |
|------|---------|---------|----------|-------------|----------|
| L1: Process Memory | Hot working state | <1ms | MBs | None (lost on crash) | Current computation, model weights in VRAM |
| L2: Redis | Warm shared state | 1-5ms | GBs | Configurable (RDB/AOF) | Cross-agent coordination, task queues |
| L3: PostgreSQL | Durable state | 5-20ms | TBs | Full ACID | Agent output, metadata, relationships |
| L4: Object Storage | Cold artifacts | 50-200ms | Unlimited | 11 9s durability | Video files, model checkpoints, large tensors |

### Tier Selection Matrix

```
Need it in <1ms?         → L1 (process memory)
Need it shared across agents? → L2 (Redis)
Need transactions?       → L3 (PostgreSQL)
Need it after restart?   → L2 + L3 (Redis + PostgreSQL)
Larger than 100MB?       → L4 (S3)
```

## Agent Memory Model

Each agent instance maintains a structured memory object that maps to the tiered storage.

```typescript
// src/agents/memory/types.ts
export interface AgentMemory {
  agentId: string;
  agentType: string;
  sessionId: string;
  startedAt: string;

  // L1: Process-local (not persisted)
  process: {
    currentTask: string | null;
    modelCache: Map<string, unknown>;
    temporaryBuffers: Map<string, Buffer>;
    metrics: AgentMetrics;
  };

  // L2: Redis-backed shared state
  shared: {
    taskProgress: Record<string, number>;    // taskId → percent complete
    activeResources: string[];               // Currently locked resources
    peerCoordination: CoordinationState;     // State shared with cooperating agents
  };

  // L3: PostgreSQL-backed durable state
  durable: {
    completedTasks: string[];
    learnedPreferences: Record<string, unknown>;
    errorHistory: Array<{ timestamp: string; error: string; context: unknown }>;
    checkpoints: Array<{ taskId: string; checkpoint: unknown; createdAt: string }>;
  };

  // L4: Object storage references
  artifacts: {
    modelPaths: string[];
    intermediateFiles: string[];
    outputPaths: string[];
  };
}
```

## L1: Process Memory Management

Process memory is the fastest tier but has no persistence. Use it for actively-computed values and caches that can be rebuilt.

```typescript
// src/agents/memory/process-memory.ts
export class ProcessMemoryStore {
  private cache = new Map<string, { value: unknown; expiresAt: number }>();
  private maxSize: number;
  private currentSize: number = 0;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  set<T>(key: string, value: T, ttlMs: number = 300000): void {
    // Evict if at capacity
    if (this.currentSize >= this.maxSize) {
      this.evictOldest();
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
    this.currentSize++;
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.currentSize--;
      return null;
    }

    return entry.value as T;
  }

  private evictOldest(): void {
    // LRU eviction
    let oldestKey: string | null = null;
    let oldestExpiry = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.expiresAt < oldestExpiry) {
        oldestExpiry = entry.expiresAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.currentSize--;
    }
  }
}

// Transcription model cache — hot in process memory, cold in Redis
export class TranscriptionCache {
  private processCache: ProcessMemoryStore;
  private redis: Redis;

  constructor(redis: Redis) {
    this.processCache = new ProcessMemoryStore(500);
    this.redis = redis;
  }

  async getSegment(videoId: string, segmentIndex: number): Promise<TranscriptionSegment | null> {
    const cacheKey = `transcription:${videoId}:${segmentIndex}`;

    // L1: Process memory
    const cached = this.processCache.get<TranscriptionSegment>(cacheKey);
    if (cached) return cached;

    // L2: Redis
    const redisValue = await this.redis.get(cacheKey);
    if (redisValue) {
      const segment = JSON.parse(redisValue);
      this.processCache.set(cacheKey, segment);
      return segment;
    }

    return null;
  }

  async setSegment(videoId: string, segmentIndex: number, segment: TranscriptionSegment): Promise<void> {
    const cacheKey = `transcription:${videoId}:${segmentIndex}`;
    this.processCache.set(cacheKey, segment);
    await this.redis.setex(cacheKey, 3600, JSON.stringify(segment));
  }
}
```

## L2: Redis-Backed Shared State

Redis provides the shared memory layer for agent coordination. Use it for state that multiple agents need to access concurrently.

```typescript
// src/agents/memory/shared-state.ts
import Redis from 'ioredis';

export class SharedAgentMemory {
  private redis: Redis;
  private agentId: string;

  constructor(redis: Redis, agentId: string) {
    this.redis = redis;
    this.agentId = agentId;
  }

  // Task progress tracking — visible to all agents
  async setTaskProgress(taskId: string, progress: number, metadata?: Record<string, unknown>): Promise<void> {
    const key = `agent:task:${taskId}`;
    await this.redis.hset(key, {
      progress: progress.toString(),
      agentId: this.agentId,
      updatedAt: Date.now().toString(),
      metadata: JSON.stringify(metadata || {}),
    });
    await this.redis.expire(key, 86400); // 24h TTL
  }

  async getTaskProgress(taskId: string): Promise<TaskProgress | null> {
    const key = `agent:task:${taskId}`;
    const data = await this.redis.hgetall(key);
    if (!data.progress) return null;

    return {
      taskId,
      progress: parseInt(data.progress),
      agentId: data.agentId,
      updatedAt: new Date(parseInt(data.updatedAt)),
      metadata: JSON.parse(data.metadata || '{}'),
    };
  }

  // Agent heartbeat — detect crashed agents
  async registerAgent(capabilities: string[]): Promise<void> {
    const key = `agent:registry:${this.agentId}`;
    await this.redis.set(key, JSON.stringify({
      agentId: this.agentId,
      capabilities,
      registeredAt: Date.now(),
      lastHeartbeat: Date.now(),
    }), 'EX', 30);
  }

  async heartbeat(): Promise<void> {
    const key = `agent:registry:${this.agentId}`;
    await this.redis.expire(key, 30);
    await this.redis.hset(key, 'lastHeartbeat', Date.now().toString());
  }

  async getActiveAgents(): Promise<AgentInfo[]> {
    const keys = await this.redis.keys('agent:registry:*');
    const agents: AgentInfo[] = [];

    for (const key of keys) {
      const data = await this.redis.get(key);
      if (data) {
        agents.push(JSON.parse(data));
      }
    }

    return agents;
  }

  // Work stealing — agents pick up tasks from a shared queue
  async claimTask(queueName: string): Promise<string | null> {
    const task = await this.redis.lpop(`queue:${queueName}`);
    if (task) {
      await this.redis.hset(`task:${task}:claim`, {
        agentId: this.agentId,
        claimedAt: Date.now().toString(),
      });
    }
    return task;
  }

  async releaseTask(taskId: string): Promise<void> {
    await this.redis.del(`task:${taskId}:claim`);
  }
}
```

### Redis Data Structures for Agent Memory

```redis
# Agent registry (hash per agent)
agent:registry:agent-001 → { capabilities, lastHeartbeat, registeredAt }

# Task progress (hash per task)
agent:task:task-abc → { progress, agentId, updatedAt, metadata }

# Task queues (list per queue)
queue:transcode → [task-1, task-2, task-3]
queue:analyze   → [task-4, task-5]

# Task claims (hash per task)
task:task-1:claim → { agentId, claimedAt }

# Shared checkpoints (hash per checkpoint)
checkpoint:video-123 → { segment, timestamp, data }

# Agent coordination (sorted set for priority)
coordination:video-123 → [{ agent: agent-001, priority: 100 }, ...]
```

## L3: PostgreSQL Durable State

Durable state survives agent restarts and system failures. Use it for completed results, learned patterns, and error history.

```sql
-- Agent memory tables
CREATE TABLE agent_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        TEXT NOT NULL,
    agent_type      TEXT NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at        TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'active',
    metadata        JSONB DEFAULT '{}'
);

CREATE TABLE agent_checkpoints (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES agent_sessions(id),
    task_id         TEXT NOT NULL,
    checkpoint_data JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(session_id, task_id)
);

CREATE TABLE agent_learned_preferences (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_type      TEXT NOT NULL,
    preference_key  TEXT NOT NULL,
    preference_value JSONB NOT NULL,
    confidence      FLOAT NOT NULL DEFAULT 0.5,
    sample_count    INTEGER NOT NULL DEFAULT 1,
    last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(agent_type, preference_key)
);

CREATE TABLE agent_error_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID REFERENCES agent_sessions(id),
    task_id         TEXT,
    error_type      TEXT NOT NULL,
    error_message   TEXT NOT NULL,
    context         JSONB DEFAULT '{}',
    stack_trace     TEXT,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_checkpoints_session ON agent_checkpoints(session_id, task_id);
CREATE INDEX idx_preferences_agent ON agent_learned_preferences(agent_type, preference_key);
CREATE INDEX idx_errors_session ON agent_error_log(session_id, occurred_at);
```

### Checkpoint Persistence

```typescript
// src/agents/memory/checkpoint.ts
export class CheckpointManager {
  private db: Pool;
  private sessionId: string;

  constructor(db: Pool, sessionId: string) {
    this.db = db;
    this.sessionId = sessionId;
  }

  async save(taskId: string, data: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO agent_checkpoints (session_id, task_id, checkpoint_data)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id, task_id)
       DO UPDATE SET checkpoint_data = $3, created_at = NOW()`,
      [this.sessionId, taskId, JSON.stringify(data)]
    );
  }

  async load(taskId: string): Promise<unknown | null> {
    const result = await this.db.query(
      'SELECT checkpoint_data FROM agent_checkpoints WHERE session_id = $1 AND task_id = $2',
      [this.sessionId, taskId]
    );
    return result.rows[0]?.checkpoint_data || null;
  }

  async loadLatestForAgent(agentId: string, taskId: string): Promise<unknown | null> {
    const result = await this.db.query(
      `SELECT checkpoint_data FROM agent_checkpoints c
       JOIN agent_sessions s ON c.session_id = s.id
       WHERE s.agent_id = $1 AND c.task_id = $2
       ORDER BY c.created_at DESC LIMIT 1`,
      [agentId, taskId]
    );
    return result.rows[0]?.checkpoint_data || null;
  }
}
```

## L4: Object Storage for Artifacts

Large binary artifacts (video files, model weights, intermediate tensors) live in S3-compatible object storage.

```typescript
// src/agents/memory/artifact-store.ts
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

export class ArtifactStore {
  private s3: S3Client;
  private bucket: string;

  constructor(bucket: string, region: string = 'us-east-1') {
    this.s3 = new S3Client({ region });
    this.bucket = bucket;
  }

  async storeArtifact(
    agentId: string,
    taskId: string,
    artifactName: string,
    data: Buffer | ReadableStream,
    contentType: string = 'application/octet-stream'
  ): Promise<string> {
    const key = `artifacts/${agentId}/${taskId}/${artifactName}`;

    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: data,
      ContentType: contentType,
      Metadata: {
        agentId,
        taskId,
        storedAt: new Date().toISOString(),
      },
    }));

    return key;
  }

  async getArtifact(key: string): Promise<Buffer> {
    const resp = await this.s3.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));

    return Buffer.from(await resp.Body!.transformToByteArray());
  }

  async listArtifacts(agentId: string, taskId: string): Promise<string[]> {
    const prefix = `artifacts/${agentId}/${taskId}/`;
    // ... list objects with prefix
    return [];
  }
}
```

## Free Tier: Unified Memory Store

On the free tier, all memory tiers collapse into SQLite + local filesystem.

```typescript
// src/agents/memory/free-tier-store.ts
import Database from 'better-sqlite3';

export class FreeTierMemoryStore {
  private db: Database.Database;
  private dataDir: string;

  constructor(dbPath: string = './data/agent-memory.db', dataDir: string = './data/artifacts') {
    this.db = new Database(dbPath);
    this.dataDir = dataDir;
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        agent_id    TEXT NOT NULL,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        tier        TEXT NOT NULL DEFAULT 'l3',
        expires_at  TEXT,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (agent_id, key)
      );

      CREATE TABLE IF NOT EXISTS agent_checkpoints (
        agent_id    TEXT NOT NULL,
        task_id     TEXT NOT NULL,
        data        TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (agent_id, task_id)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_expires ON agent_memory(expires_at);
    `);
  }

  set(agentId: string, key: string, value: unknown, tier: string = 'l3', ttlSeconds?: number): void {
    const expiresAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null;
    this.db.prepare(
      `INSERT OR REPLACE INTO agent_memory (agent_id, key, value, tier, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).run(agentId, key, JSON.stringify(value), tier, expiresAt);
  }

  get<T>(agentId: string, key: string): T | null {
    const row = this.db.prepare(
      `SELECT value, expires_at FROM agent_memory WHERE agent_id = ? AND key = ?`
    ).get(agentId, key) as any;

    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      this.db.prepare('DELETE FROM agent_memory WHERE agent_id = ? AND key = ?').run(agentId, key);
      return null;
    }

    return JSON.parse(row.value);
  }

  saveCheckpoint(agentId: string, taskId: string, data: unknown): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO agent_checkpoints (agent_id, task_id, data, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    ).run(agentId, taskId, JSON.stringify(data));
  }

  loadCheckpoint(agentId: string, taskId: string): unknown | null {
    const row = this.db.prepare(
      'SELECT data FROM agent_checkpoints WHERE agent_id = ? AND task_id = ?'
    ).get(agentId, taskId) as any;
    return row ? JSON.parse(row.data) : null;
  }
}
```

## Memory Lifecycle Management

```typescript
// src/agents/memory/lifecycle.ts
export class MemoryLifecycleManager {
  private redis: Redis;
  private db: Pool;

  constructor(redis: Redis, db: Pool) {
    this.redis = redis;
    this.db = db;
  }

  async onAgentStart(agentId: string, agentType: string): Promise<AgentMemory> {
    // Register session
    const session = await this.db.query(
      `INSERT INTO agent_sessions (agent_id, agent_type) VALUES ($1, $2) RETURNING id`,
      [agentId, agentType]
    );
    const sessionId = session.rows[0].id;

    // Load latest checkpoint if exists
    const checkpoint = await this.db.query(
      `SELECT checkpoint_data FROM agent_checkpoints c
       JOIN agent_sessions s ON c.session_id = s.id
       WHERE s.agent_id = $1 ORDER BY c.created_at DESC LIMIT 1`,
      [agentId]
    );

    // Load learned preferences
    const prefs = await this.db.query(
      'SELECT preference_key, preference_value, confidence FROM agent_learned_preferences WHERE agent_type = $1',
      [agentType]
    );

    return {
      agentId,
      agentType,
      sessionId,
      startedAt: new Date().toISOString(),
      process: {
        currentTask: null,
        modelCache: new Map(),
        temporaryBuffers: new Map(),
        metrics: { tasksCompleted: 0, errors: 0, avgDurationMs: 0 },
      },
      shared: {
        taskProgress: {},
        activeResources: [],
        peerCoordination: { peers: [], leaderId: null },
      },
      durable: {
        completedTasks: [],
        learnedPreferences: Object.fromEntries(
          prefs.rows.map(p => [p.preference_key, { value: p.preference_value, confidence: p.confidence }])
        ),
        errorHistory: [],
        checkpoints: checkpoint.rows.map(c => c.checkpoint_data),
      },
      artifacts: {
        modelPaths: [],
        intermediateFiles: [],
        outputPaths: [],
      },
    };
  }

  async onAgentCrash(agentId: string): Promise<void> {
    // Mark session as crashed
    await this.db.query(
      `UPDATE agent_sessions SET status = 'crashed', ended_at = NOW()
       WHERE agent_id = $1 AND status = 'active'`,
      [agentId]
    );

    // Release all held locks
    const lockKeys = await this.redis.keys('lock:*');
    for (const key of lockKeys) {
      const lock = await this.redis.get(key);
      if (lock) {
        const data = JSON.parse(lock);
        if (data.agent === agentId) {
          await this.redis.del(key);
        }
      }
    }

    // Requeue claimed tasks
    const claimKeys = await this.redis.keys('task:*:claim');
    for (const key of claimKeys) {
      const claim = await this.redis.hgetall(key);
      if (claim.agentId === agentId) {
        const taskId = key.split(':')[1];
        await this.redis.lpush(`queue:${claim.queue || 'default'}`, taskId);
        await this.redis.del(key);
      }
    }
  }
}
```

## Summary

MiniOp's agent memory architecture uses four tiers: process memory for hot computation, Redis for shared coordination state, PostgreSQL for durable results and checkpoints, and S3 for large artifacts. The free tier collapses these into SQLite and local filesystem. Every agent checkpoint is persisted so work survives crashes. Memory lifecycle management handles agent startup (loading prior state), crash recovery (releasing locks, requeueing tasks), and shutdown (persisting final state). Learned preferences accumulate across sessions, improving agent performance over time.
