# Deadlock Prevention for MiniOp Agents

## Overview

Deadlocks occur when two or more agents hold resources while waiting for each other to release additional resources. In MiniOp, this can happen when Agent A locks a video for transcoding while waiting for a GPU, and Agent B holds the GPU while waiting for the same video's metadata (locked by Agent A). Deadlock prevention ensures the system never enters such states, while deadlock detection and recovery handle cases where prevention fails.

This document covers prevention strategies, detection algorithms, and recovery procedures for both free-tier single-process and production distributed deployments.

## Deadlock Scenarios in MiniOp

| Scenario | Resources Contended | Agents Involved | Likelihood |
|----------|-------------------|-----------------|------------|
| Video + GPU | Video metadata lock, GPU allocation | Transcoder, Analyzer | Medium |
| Clip + Export | Clip record, export queue slot | Clip generator, Export worker | Low |
| Project + Storage | Project quota, S3 upload slot | Upload handler, Quota enforcer | Low |
| Chain dependency | A→B→C→A task dependencies | Multiple pipeline stages | Rare |
| Database + Cache | DB row lock, Redis key lock | Any two agents on same entity | Medium |

## Prevention Strategy 1: Ordered Resource Acquisition

The simplest and most effective prevention strategy: always acquire resources in a consistent global order.

```typescript
// src/agents/deadlock/ordered-lock.ts
import { Mutex } from 'async-mutex';

const RESOURCE_ORDER: Record<string, number> = {
  'project':    1,
  'video':      2,
  'transcription': 3,
  'clip':       4,
  'export':     5,
  'gpu':        6,
  'storage':    7,
};

const locks = new Map<string, Mutex>();

function getLockKey(resourceType: string, resourceId: string): string {
  return `${resourceType}:${resourceId}`;
}

function getResourceOrder(resourceType: string): number {
  return RESOURCE_ORDER[resourceType] || 999;
}

export async function acquireMultipleResources(
  resources: Array<{ type: string; id: string }>,
  agentId: string,
  timeoutMs: number = 30000
): Promise<() => void> {
  // Sort by global order to prevent deadlocks
  const sorted = [...resources].sort((a, b) =>
    getResourceOrder(a.type) - getResourceOrder(b.type)
  );

  const acquired: Array<{ key: string; release: () => void }> = [];

  try {
    for (const resource of sorted) {
      const key = getLockKey(resource.type, resource.id);

      if (!locks.has(key)) {
        locks.set(key, new Mutex());
      }

      const mutex = locks.get(key)!;
      const release = await Promise.race([
        mutex.acquire(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new LockTimeoutError(key, timeoutMs)), timeoutMs)
        ),
      ]);

      acquired.push({ key, release });
    }

    // Return a release function that releases all in reverse order
    return () => {
      for (let i = acquired.length - 1; i >= 0; i--) {
        acquired[i].release();
      }
    };
  } catch (error) {
    // Release all acquired locks on failure
    for (let i = acquired.length - 1; i >= 0; i--) {
      acquired[i].release();
    }
    throw error;
  }
}

export class LockTimeoutError extends Error {
  constructor(resourceKey: string, timeoutMs: number) {
    super(`Lock timeout on ${resourceKey} after ${timeoutMs}ms`);
    this.name = 'LockTimeoutError';
  }
}
```

### Usage in Agents

```typescript
// src/agents/transcoder.ts
import { acquireMultipleResources } from './deadlock/ordered-lock';

export async function transcodeVideo(videoId: string, gpuId: string): Promise<void> {
  // Always acquire in order: video (2) → gpu (6)
  const release = await acquireMultipleResources(
    [
      { type: 'video', id: videoId },
      { type: 'gpu', id: gpuId },
    ],
    'transcoder'
  );

  try {
    const video = await db.query('SELECT * FROM videos WHERE id = $1', [videoId]);
    // ... transcode logic
  } finally {
    release();
  }
}
```

## Prevention Strategy 2: Lock Timeout with Abort

Every lock acquisition has a bounded timeout. If a lock can't be acquired within the timeout, the operation aborts and retries with backoff.

```typescript
// src/agents/deadlock/timeout-lock.ts
export interface LockConfig {
  acquireTimeoutMs: number;
  holdTimeoutMs: number;
  maxRetries: number;
  backoffMs: number;
}

const DEFAULT_CONFIG: LockConfig = {
  acquireTimeoutMs: 10000,
  holdTimeoutMs: 60000,
  maxRetries: 3,
  backoffMs: 1000,
};

export class BoundedLock {
  private redis: Redis;
  private key: string;
  private config: LockConfig;

  constructor(redis: Redis, key: string, config: Partial<LockConfig> = {}) {
    this.redis = redis;
    this.key = `lock:${key}`;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async acquire(ownerId: string): Promise<LockHandle> {
    let attempt = 0;

    while (attempt < this.config.maxRetries) {
      const acquired = await this.redis.set(
        this.key,
        JSON.stringify({
          owner: ownerId,
          acquiredAt: Date.now(),
          expiresAt: Date.now() + this.config.holdTimeoutMs,
        }),
        'NX',
        'PX',
        this.config.holdTimeoutMs
      );

      if (acquired) {
        return new LockHandle(this.redis, this.key, ownerId, this.config.holdTimeoutMs);
      }

      attempt++;
      if (attempt < this.config.maxRetries) {
        await new Promise(r => setTimeout(r, this.config.backoffMs * attempt));
      }
    }

    throw new DeadlockSuspectedError(this.key, this.config.maxRetries);
  }
}

export class LockHandle {
  private redis: Redis;
  private key: string;
  private owner: string;
  private holdTimeout: number;
  private refreshInterval: NodeJS.Timeout | null = null;

  constructor(redis: Redis, key: string, owner: string, holdTimeout: number) {
    this.redis = redis;
    this.key = key;
    this.owner = owner;
    this.holdTimeout = holdTimeout;

    // Refresh lock periodically to prevent expiry during long operations
    this.refreshInterval = setInterval(() => this.refresh(), holdTimeout / 3);
  }

  private async refresh(): Promise<void> {
    const current = await this.redis.get(this.key);
    if (current) {
      const lock = JSON.parse(current);
      if (lock.owner === this.owner) {
        await this.redis.pexpire(this.key, this.holdTimeout);
      }
    }
  }

  async release(): Promise<void> {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }

    // Only release if we still own it
    const script = `
      local current = redis.call('GET', KEYS[1])
      if current then
        local lock = cjson.decode(current)
        if lock.owner == ARGV[1] then
          return redis.call('DEL', KEYS[1])
        end
      end
      return 0
    `;
    await this.redis.eval(script, 1, this.key, this.owner);
  }
}

export class DeadlockSuspectedError extends Error {
  constructor(key: string, retries: number) {
    super(`Possible deadlock: failed to acquire ${key} after ${retries} retries`);
    this.name = 'DeadlockSuspectedError';
  }
}
```

## Prevention Strategy 3: Wait-Die Scheme

In the wait-die scheme, older transactions (by timestamp) wait for younger ones, but younger transactions abort immediately if they can't get a lock.

```typescript
// src/agents/deadlock/wait-die.ts
interface Transaction {
  id: string;
  timestamp: number;  // Lower = older
  agentId: string;
}

export class WaitDieLockManager {
  private locks = new Map<string, { owner: Transaction; expiresAt: number }>();
  private waitQueues = new Map<string, Array<{ transaction: Transaction; resolve: () => void; reject: (err: Error) => void }>>();

  async acquire(resourceId: string, tx: Transaction, timeoutMs: number = 30000): Promise<() => void> {
    const current = this.locks.get(resourceId);

    if (!current || Date.now() > current.expiresAt) {
      // Lock available — acquire it
      this.locks.set(resourceId, { owner: tx, expiresAt: Date.now() + timeoutMs });
      return () => this.release(resourceId, tx);
    }

    if (current.owner.id === tx.id) {
      // Already own it
      return () => this.release(resourceId, tx);
    }

    // Lock is held by another transaction
    if (tx.timestamp < current.owner.timestamp) {
      // We are older — wait
      return new Promise((resolve, reject) => {
        if (!this.waitQueues.has(resourceId)) {
          this.waitQueues.set(resourceId, []);
        }
        this.waitQueues.get(resourceId)!.push({
          transaction: tx,
          resolve: () => resolve(() => this.release(resourceId, tx)),
          reject,
        });

        // Set timeout
        setTimeout(() => {
          const queue = this.waitQueues.get(resourceId);
          if (queue) {
            const idx = queue.findIndex(q => q.transaction.id === tx.id);
            if (idx !== -1) {
              queue.splice(idx, 1);
              reject(new LockTimeoutError(resourceId, timeoutMs));
            }
          }
        }, timeoutMs);
      });
    } else {
      // We are younger — die (abort)
      throw new TransactionAbortError(tx.id, `Aborted: younger transaction ${tx.id} cannot wait for older ${current.owner.id}`);
    }
  }

  private release(resourceId: string, tx: Transaction): void {
    const current = this.locks.get(resourceId);
    if (!current || current.owner.id !== tx.id) return;

    // Check wait queue
    const queue = this.waitQueues.get(resourceId);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      this.locks.set(resourceId, { owner: next.transaction, expiresAt: Date.now() + 30000 });
      next.resolve();
    } else {
      this.locks.delete(resourceId);
    }
  }
}

export class TransactionAbortError extends Error {
  constructor(transactionId: string, reason: string) {
    super(`Transaction ${transactionId} aborted: ${reason}`);
    this.name = 'TransactionAbortError';
  }
}
```

## Prevention Strategy 4: Deadlock Detection via Resource Graph

For cases where prevention isn't possible (complex multi-resource operations), detect deadlocks by analyzing the resource allocation graph.

```typescript
// src/agents/deadlock/detector.ts
interface ResourceEdge {
  from: string;  // Agent or transaction ID
  to: string;    // Resource ID
  type: 'holds' | 'waits_for';
}

export class DeadlockDetector {
  private edges: ResourceEdge[] = [];

  addEdge(from: string, to: string, type: 'holds' | 'waits_for'): void {
    this.edges.push({ from, to, type });
  }

  removeEdges(from: string, to: string): void {
    this.edges = this.edges.filter(e => !(e.from === from && e.to === to));
  }

  detectCycles(): string[][] {
    // Build adjacency list: agent → agents it's waiting for
    const graph = new Map<string, Set<string>>();

    for (const edge of this.edges) {
      if (edge.type === 'waits_for') {
        // Find who holds the resource
        const holders = this.edges
          .filter(e => e.to === edge.to && e.type === 'holds')
          .map(e => e.from);

        if (!graph.has(edge.from)) {
          graph.set(edge.from, new Set());
        }
        for (const holder of holders) {
          if (holder !== edge.from) {
            graph.get(edge.from)!.add(holder);
          }
        }
      }
    }

    // DFS cycle detection
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (node: string, path: string[]): void => {
      visited.add(node);
      recursionStack.add(node);
      path.push(node);

      const neighbors = graph.get(node) || new Set();
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          dfs(neighbor, [...path]);
        } else if (recursionStack.has(neighbor)) {
          // Found cycle
          const cycleStart = path.indexOf(neighbor);
          cycles.push(path.slice(cycleStart));
        }
      }

      recursionStack.delete(node);
    };

    for (const node of graph.keys()) {
      if (!visited.has(node)) {
        dfs(node, []);
      }
    }

    return cycles;
  }
}

// Periodic detection job
export async function runDeadlockDetection(): Promise<void> {
  const detector = new DeadlockDetector();

  // Load current lock state from Redis
  const lockKeys = await redis.keys('lock:*');
  for (const key of lockKeys) {
    const lock = await redis.get(key);
    if (lock) {
      const { owner } = JSON.parse(lock);
      const resourceId = key.replace('lock:', '');
      detector.addEdge(owner, resourceId, 'holds');
    }
  }

  // Load wait state
  const waitKeys = await redis.keys('wait:*');
  for (const key of waitKeys) {
    const waits = await redis.smembers(key);
    const resourceId = key.replace('wait:', '');
    for (const waiter of waits) {
      detector.addEdge(waiter, resourceId, 'waits_for');
    }
  }

  // Detect cycles
  const cycles = detector.detectCycles();

  if (cycles.length > 0) {
    console.error(`Deadlock detected: ${JSON.stringify(cycles)}`);

    for (const cycle of cycles) {
      // Break the deadlock by aborting the youngest transaction
      const youngest = cycle.reduce((youngest, current) => {
        const currentTx = getTransaction(current);
        const youngestTx = getTransaction(youngest);
        return currentTx.timestamp > youngestTx.timestamp ? current : youngest;
      });

      await abortTransaction(youngest);
      await logDeadlockBreak(cycle, youngest);
    }
  }
}
```

## Production: Redis-Based Distributed Lock Manager

```typescript
// src/agents/deadlock/distributed-lock-manager.ts
import Redis from 'ioredis';

export class DistributedLockManager {
  private redis: Redis;
  private detector: DeadlockDetector;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
    this.detector = new DeadlockDetector();

    // Run deadlock detection every 10 seconds
    setInterval(() => this.runDetection(), 10000);
  }

  async lock(
    resources: Array<{ type: string; id: string }>,
    agentId: string,
    opts: { timeoutMs?: number; ordered?: boolean } = {}
  ): Promise<LockSession> {
    const { timeoutMs = 30000, ordered = true } = opts;
    const sorted = ordered
      ? [...resources].sort((a, b) => RESOURCE_ORDER[a.type] - RESOURCE_ORDER[b.type])
      : resources;

    const sessionId = `session:${uuidv7()}`;
    const acquired: string[] = [];

    for (const resource of sorted) {
      const lockKey = `lock:${resource.type}:${resource.id}`;
      const start = Date.now();

      while (Date.now() - start < timeoutMs) {
        const result = await this.redis.set(
          lockKey,
          JSON.stringify({ session: sessionId, agent: agentId, acquired: Date.now() }),
          'NX',
          'PX',
          timeoutMs
        );

        if (result) {
          acquired.push(lockKey);
          this.detector.addEdge(agentId, `${resource.type}:${resource.id}`, 'holds');
          break;
        }

        // Register wait
        await this.redis.sadd(`wait:${resource.type}:${resource.id}`, agentId);
        this.detector.addEdge(agentId, `${resource.type}:${resource.id}`, 'waits_for');

        await new Promise(r => setTimeout(r, 100));
      }

      if (!acquired.includes(lockKey)) {
        // Timeout — release all acquired
        for (const key of acquired) {
          await this.unlock(key, agentId);
        }
        throw new LockTimeoutError(lockKey, timeoutMs);
      }
    }

    return new LockSession(this.redis, acquired, agentId, sessionId);
  }

  private async unlock(lockKey: string, agentId: string): Promise<void> {
    const script = `
      local current = redis.call('GET', KEYS[1])
      if current then
        local lock = cjson.decode(current)
        if lock.agent == ARGV[1] then
          redis.call('DEL', KEYS[1])
          redis.call('SREM', 'wait:' .. KEYS[1]:sub(6), ARGV[1])
          return 1
        end
      end
      return 0
    `;
    await this.redis.eval(script, 1, lockKey, agentId);
    this.detector.removeEdges(agentId, lockKey.replace('lock:', ''));
  }

  private async runDetection(): Promise<void> {
    // Refresh edges from Redis
    const lockKeys = await this.redis.keys('lock:*');
    // ... rebuild graph and detect
  }
}
```

## Free Tier: Simple Deadlock Prevention

On the free tier, deadlocks are prevented by always acquiring locks in a global order and using a single lock timeout.

```typescript
// src/agents/deadlock/local-prevention.ts
import { Mutex } from 'async-mutex';

const globalLockOrder = new Map<string, number>([
  ['project', 1],
  ['video', 2],
  ['clip', 3],
  ['export', 4],
]);

const locks = new Map<string, Mutex>();

export async function acquireOrdered(
  resources: string[],
  timeoutMs: number = 10000
): Promise<() => void> {
  const sorted = [...resources].sort((a, b) => {
    const aOrder = globalLockOrder.get(a.split(':')[0]) || 999;
    const bOrder = globalLockOrder.get(b.split(':')[0]) || 999;
    return aOrder - bOrder;
  });

  const acquired: Array<{ key: string; release: () => void }> = [];

  try {
    for (const key of sorted) {
      if (!locks.has(key)) {
        locks.set(key, new Mutex());
      }
      const release = await Promise.race([
        locks.get(key)!.acquire(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Lock timeout: ${key}`)), timeoutMs)
        ),
      ]);
      acquired.push({ key, release });
    }

    return () => {
      for (let i = acquired.length - 1; i >= 0; i--) {
        acquired[i].release();
      }
    };
  } catch (error) {
    for (let i = acquired.length - 1; i >= 0; i--) {
      acquired[i].release();
    }
    throw error;
  }
}
```

## Deadlock Metrics

```typescript
// src/agents/deadlock/metrics.ts
import { Counter, Gauge, Histogram } from 'prom-client';

export const deadlocksDetected = new Counter({
  name: 'minio_deadlocks_detected_total',
  help: 'Total deadlocks detected',
  labelNames: ['resolution'],
});

export const lockTimeouts = new Counter({
  name: 'minio_lock_timeouts_total',
  help: 'Total lock acquisition timeouts',
  labelNames: ['resource_type'],
});

export const activeLocks = new Gauge({
  name: 'minio_active_locks',
  help: 'Number of currently held locks',
  labelNames: ['resource_type'],
});

export const lockHoldDuration = new Histogram({
  name: 'minio_lock_hold_duration_seconds',
  help: 'How long locks are held',
  labelNames: ['resource_type'],
  buckets: [0.01, 0.1, 0.5, 1, 5, 10, 30, 60],
});
```

## Alerting Rules

```yaml
# monitoring/alerts.yaml
groups:
  - name: deadlock_alerts
    rules:
      - alert: DeadlockDetected
        expr: rate(minio_deadlocks_detected_total[5m]) > 0
        for: 0m
        labels:
          severity: critical
        annotations:
          summary: "Deadlock detected in MiniOp agent system"

      - alert: HighLockTimeoutRate
        expr: rate(minio_lock_timeouts_total[5m]) > 10
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "High rate of lock timeouts — possible contention"

      - alert: LockHoldTooLong
        expr: histogram_quantile(0.99, minio_lock_hold_duration_seconds) > 30
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Locks being held for extended periods"
```

## Summary

Deadlock prevention in MiniOp uses ordered resource acquisition as the primary strategy — all agents acquire locks in a consistent global order, making cyclic waits impossible. Secondary prevention includes lock timeouts with abort (preventing indefinite waits), the wait-die scheme (older transactions wait, younger abort), and resource graph cycle detection for complex scenarios. The free tier uses in-process mutexes with ordered acquisition. Production uses Redis-based distributed locks with periodic deadlock detection. All lock contention events are recorded as metrics with alerting on anomalies.
