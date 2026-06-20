# Conflict Detection for MiniOp Agents

## Overview

MiniOp uses autonomous agents for video processing, transcription analysis, clip segmentation, and export optimization. When multiple agents operate on the same video project concurrently — analyzing different segments, applying different effects, or updating shared metadata — conflicts arise. Conflict detection identifies these situations before they cause data corruption or inconsistent state.

This document defines the conflict detection mechanisms, detection algorithms, and implementation for both free-tier single-process agents and production distributed agent orchestration.

## Conflict Types in MiniOp

| Conflict Type | Example | Severity | Detection Method |
|--------------|---------|----------|-----------------|
| Write-Write | Two agents updating clip metadata simultaneously | Critical | Optimistic locking |
| Read-Write | Agent reads stale video state while another renders | High | Version vectors |
| Semantic | Two agents assign overlapping time ranges to different clips | Medium | Business rule validation |
| Resource | Two agents request the same GPU for transcoding | High | Resource locks |
| Ordering | Export agent runs before clip generation completes | Critical | DAG dependency checks |

## Optimistic Locking for Write-Write Detection

Every mutable entity in MiniOp carries a version number. Updates must specify the version they read; if the version has changed, the update is rejected.

### Database Schema

```sql
-- Shared schema addition
ALTER TABLE clips ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE videos ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE transcriptions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
```

### Implementation

```typescript
// src/agents/conflict/optimistic-lock.ts
export class OptimisticLockError extends Error {
  constructor(
    public entity: string,
    public entityId: string,
    public expectedVersion: number,
    public actualVersion: number
  ) {
    super(`Optimistic lock conflict on ${entity} ${entityId}: expected v${expectedVersion}, found v${actualVersion}`);
    this.name = 'OptimisticLockError';
  }
}

export async function updateWithLock<T extends { id: string; version: number }>(
  table: string,
  id: string,
  expectedVersion: number,
  updates: Partial<T>
): Promise<T> {
  const setClauses = Object.keys(updates)
    .map((key, i) => `${key} = $${i + 3}`)
    .join(', ');

  const query = `
    UPDATE ${table}
    SET ${setClauses}, version = version + 1, updated_at = NOW()
    WHERE id = $1 AND version = $2
    RETURNING *
  `;

  const result = await db.query(query, [id, expectedVersion, ...Object.values(updates)]);

  if (result.rows.length === 0) {
    // Either the row doesn't exist or the version changed
    const current = await db.query(`SELECT id, version FROM ${table} WHERE id = $1`, [id]);
    if (current.rows.length === 0) {
      throw new Error(`${table} ${id} not found`);
    }
    throw new OptimisticLockError(table, id, expectedVersion, current.rows[0].version);
  }

  return result.rows[0] as T;
}
```

### Agent Usage

```typescript
// src/agents/clip-analyzer.ts
import { updateWithLock, OptimisticLockError } from './conflict/optimistic-lock';

export async function updateClipSegments(
  clipId: string,
  expectedVersion: number,
  segments: ClipSegment[]
): Promise<void> {
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await updateWithLock('clips', clipId, expectedVersion, {
        segments: JSON.stringify(segments),
        analysis_status: 'completed',
      });
      return; // Success
    } catch (error) {
      if (error instanceof OptimisticLockError && attempt < MAX_RETRIES - 1) {
        // Re-read current state and retry
        const current = await db.query('SELECT * FROM clips WHERE id = $1', [clipId]);
        expectedVersion = current.rows[0].version;
        // Merge logic: decide if our changes can be applied on top of current state
        const canMerge = mergeSegments(current.rows[0].segments, segments);
        if (!canMerge) {
          throw new ConflictResolutionError('Cannot merge concurrent clip updates', {
            clipId,
            ourVersion: error.expectedVersion,
            theirVersion: error.actualVersion,
          });
        }
        continue;
      }
      throw error;
    }
  }
}
```

## Version Vectors for Read-Write Detection

For distributed agents that cache entity state, version vectors provide stronger guarantees than single version numbers.

```typescript
// src/agents/conflict/version-vector.ts
export interface VersionVector {
  [agentId: string]: number;
}

export function incrementVersion(vector: VersionVector, agentId: string): VersionVector {
  return {
    ...vector,
    [agentId]: (vector[agentId] || 0) + 1,
  };
}

export function mergeVectors(a: VersionVector, b: VersionVector): VersionVector {
  const merged: VersionVector = { ...a };
  for (const [agentId, version] of Object.entries(b)) {
    merged[agentId] = Math.max(merged[agentId] || 0, version);
  }
  return merged;
}

export function compareVectors(a: VersionVector, b: VersionVector): 'equal' | 'a_gt_b' | 'b_gt_a' | 'concurrent' {
  let aGreater = false;
  let bGreater = false;

  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of allKeys) {
    const aVal = a[key] || 0;
    const bVal = b[key] || 0;
    if (aVal > bVal) aGreater = true;
    if (bVal > aVal) bGreater = true;
  }

  if (aGreater && bGreater) return 'concurrent';
  if (aGreater) return 'a_gt_b';
  if (bGreater) return 'b_gt_a';
  return 'equal';
}

export function detectConflict(
  readVector: VersionVector,
  currentVector: VersionVector,
  writeVector: VersionVector
): { hasConflict: boolean; reason?: string } {
  const readVsCurrent = compareVectors(readVector, currentVector);

  if (readVsCurrent === 'equal') {
    return { hasConflict: false }; // No concurrent modification
  }

  if (readVsCurrent === 'a_gt_b') {
    // This shouldn't happen — the read vector can't be ahead of current
    return { hasConflict: true, reason: 'Invalid state: read vector ahead of current' };
  }

  // current > read: someone else modified since we read
  // Check if our write conflicts with the changes
  const ourDelta = mergeVectors(readVector, writeVector);
  const theirDelta = currentVector;
  const relationship = compareVectors(ourDelta, theirDelta);

  if (relationship === 'concurrent') {
    return { hasConflict: true, reason: 'Concurrent modifications detected' };
  }

  return { hasConflict: false }; // Our changes are on top of theirs
}
```

### Database Storage

```sql
-- PostgreSQL with JSONB version vector
ALTER TABLE clips ADD COLUMN version_vector JSONB NOT NULL DEFAULT '{}';

-- Index for version vector queries
CREATE INDEX idx_clips_version_vector ON clips USING GIN (version_vector);
```

## Semantic Conflict Detection

Semantic conflicts occur when logically incompatible changes are made concurrently. These require domain-specific validation.

```typescript
// src/agents/conflict/semantic-detector.ts
export interface ClipTimeRange {
  start: number;
  end: number;
  clipId: string;
}

export function detectTimeRangeOverlap(
  existingRanges: ClipTimeRange[],
  newRange: ClipTimeRange
): { hasConflict: boolean; conflictingClips: string[] } {
  const conflictingClips: string[] = [];

  for (const existing of existingRanges) {
    if (existing.clipId === newRange.clipId) continue; // Same clip, skip

    // Check for overlap
    const overlapStart = Math.max(existing.start, newRange.start);
    const overlapEnd = Math.min(existing.end, newRange.end);

    if (overlapStart < overlapEnd) {
      // Overlap of more than 1 second is considered a conflict
      if (overlapEnd - overlapStart > 1.0) {
        conflictingClips.push(existing.clipId);
      }
    }
  }

  return {
    hasConflict: conflictingClips.length > 0,
    conflictingClips,
  };
}

export async function validateClipAssignment(
  projectId: string,
  newClip: { id: string; start: number; end: number }
): Promise<ValidationResult> {
  const existingClips = await db.query(
    'SELECT id, time_start, time_end FROM clips WHERE project_id = $1 AND id != $2',
    [projectId, newClip.id]
  );

  const ranges: ClipTimeRange[] = existingClips.rows.map(r => ({
    start: r.time_start,
    end: r.time_end,
    clipId: r.id,
  }));

  const overlapResult = detectTimeRangeOverlap(ranges, {
    start: newClip.start,
    end: newClip.end,
    clipId: newClip.id,
  });

  if (overlapResult.hasConflict) {
    return {
      valid: false,
      error: 'TIME_RANGE_OVERLAP',
      details: `Overlapping with clips: ${overlapResult.conflictingClips.join(', ')}`,
    };
  }

  // Additional semantic checks
  if (newClip.end - newClip.start < 5) {
    return { valid: false, error: 'CLIP_TOO_SHORT', details: 'Minimum clip duration is 5 seconds' };
  }

  if (newClip.end - newClip.start > 180) {
    return { valid: false, error: 'CLIP_TOO_LONG', details: 'Maximum clip duration is 180 seconds' };
  }

  return { valid: true };
}
```

## Resource Conflict Detection

GPU and CPU resources are finite. Multiple agents requesting the same resource must be coordinated.

```typescript
// src/agents/conflict/resource-lock.ts
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

export interface ResourceRequest {
  resourceId: string;    // e.g., 'gpu:0', 'cpu:transcoder-pool'
  agentId: string;
  operation: string;     // e.g., 'transcode', 'analyze'
  estimatedDurationMs: number;
  priority: number;      // Higher = more important
}

export async function acquireResourceLock(
  request: ResourceRequest,
  timeoutMs: number = 30000
): Promise<{ acquired: boolean; waitTimeMs?: number }> {
  const lockKey = `resource:lock:${request.resourceId}`;
  const queueKey = `resource:queue:${request.resourceId}`;
  const start = Date.now();

  // Try immediate acquisition
  const acquired = await redis.set(
    lockKey,
    JSON.stringify({
      agentId: request.agentId,
      operation: request.operation,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + request.estimatedDurationMs + 5000, // 5s buffer
    }),
    'NX',
    'PX',
    request.estimatedDurationMs + 5000
  );

  if (acquired) {
    return { acquired: true, waitTimeMs: 0 };
  }

  // Check who holds the lock
  const currentLock = await redis.get(lockKey);
  if (currentLock) {
    const lock = JSON.parse(currentLock);
    if (lock.agentId === request.agentId) {
      // We already hold it — extend
      await redis.pexpire(lockKey, request.estimatedDurationMs + 5000);
      return { acquired: true, waitTimeMs: 0 };
    }
  }

  // Queue and wait
  await redis.zadd(queueKey, request.priority, JSON.stringify(request));

  // Poll for acquisition
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 1000));

    const stillLocked = await redis.get(lockKey);
    if (!stillLocked) {
      // Lock released — try to acquire
      const ourRequest = await redis.zpopmax(queueKey);
      if (ourRequest && JSON.parse(ourRequest[0]).agentId === request.agentId) {
        const reacquired = await redis.set(
          lockKey,
          JSON.stringify({
            agentId: request.agentId,
            operation: request.operation,
            acquiredAt: Date.now(),
            expiresAt: Date.now() + request.estimatedDurationMs + 5000,
          }),
          'NX',
          'PX',
          request.estimatedDurationMs + 5000
        );
        if (reacquired) {
          return { acquired: true, waitTimeMs: Date.now() - start };
        }
      }
    }
  }

  // Timeout — remove from queue
  await redis.zrem(queueKey, JSON.stringify(request));
  return { acquired: false };
}

export async function releaseResourceLock(resourceId: string, agentId: string): Promise<void> {
  const lockKey = `resource:lock:${resourceId}`;
  const current = await redis.get(lockKey);

  if (current) {
    const lock = JSON.parse(current);
    if (lock.agentId === agentId) {
      await redis.del(lockKey);
    }
  }
}
```

## DAG Dependency Conflict Detection

MiniOp's processing pipeline is a directed acyclic graph. An agent must not start a task if its dependencies haven't completed.

```typescript
// src/agents/conflict/dag-validator.ts
interface TaskNode {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  dependencies: string[];  // Task IDs this task depends on
  agentId?: string;
}

export async function validateTaskStart(taskId: string): Promise<{ canStart: boolean; blockers: string[] }> {
  const task = await db.query('SELECT * FROM processing_tasks WHERE id = $1', [taskId]);
  if (task.rows.length === 0) throw new Error(`Task ${taskId} not found`);

  const taskNode = task.rows[0] as TaskNode;
  const blockers: string[] = [];

  // Check all dependencies
  for (const depId of taskNode.dependencies) {
    const dep = await db.query('SELECT id, status FROM processing_tasks WHERE id = $1', [depId]);
    if (dep.rows.length === 0) {
      blockers.push(`Dependency ${depId} not found`);
    } else if (dep.rows[0].status !== 'completed') {
      blockers.push(`Dependency ${depId} is ${dep.rows[0].status}`);
    }
  }

  // Check for circular dependencies (shouldn't happen with DAG, but defensive)
  if (await hasCircularDependency(taskId)) {
    blockers.push('Circular dependency detected');
  }

  return { canStart: blockers.length === 0, blockers };
}

async function hasCircularDependency(taskId: string, visited: Set<string> = new Set()): Promise<boolean> {
  if (visited.has(taskId)) return true;
  visited.add(taskId);

  const dependents = await db.query(
    'SELECT id FROM processing_tasks WHERE $1 = ANY(dependencies)',
    [taskId]
  );

  for (const dep of dependents.rows) {
    if (await hasCircularDependency(dep.id, new Set(visited))) {
      return true;
    }
  }

  return false;
}
```

## Free Tier: In-Process Conflict Detection

On the free tier, agents run as async functions in a single Node.js process. Conflict detection uses mutex locks and shared state.

```typescript
// src/agents/conflict/local-mutex.ts
import { Mutex } from 'async-mutex';

const mutexes = new Map<string, Mutex>();

export function getMutex(resourceId: string): Mutex {
  if (!mutexes.has(resourceId)) {
    mutexes.set(resourceId, new Mutex());
  }
  return mutexes.get(resourceId)!;
}

export async function withLock<T>(
  resourceId: string,
  fn: () => Promise<T>,
  timeoutMs: number = 30000
): Promise<T> {
  const mutex = getMutex(resourceId);
  const release = await mutex.acquire();

  const timeout = setTimeout(() => {
    release();
    throw new Error(`Lock timeout on ${resourceId} after ${timeoutMs}ms`);
  }, timeoutMs);

  try {
    return await fn();
  } finally {
    clearTimeout(timeout);
    release();
  }
}

// Usage in agent
export async function analyzeVideo(videoId: string): Promise<void> {
  await withLock(`video:${videoId}`, async () => {
    const video = await db.query('SELECT * FROM videos WHERE id = $1', [videoId]);
    // ... analysis logic
    await db.query('UPDATE videos SET status = $1 WHERE id = $2', ['analyzed', videoId]);
  });
}
```

## Conflict Detection Metrics

```typescript
// src/agents/conflict/metrics.ts
import { Counter, Histogram } from 'prom-client';

export const conflictDetected = new Counter({
  name: 'minio_agent_conflicts_total',
  help: 'Total conflicts detected',
  labelNames: ['type', 'entity', 'resolution'],
});

export const conflictResolutionTime = new Histogram({
  name: 'minio_conflict_resolution_seconds',
  help: 'Time to resolve conflicts',
  labelNames: ['type'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10],
});

export const lockWaitTime = new Histogram({
  name: 'minio_lock_wait_seconds',
  help: 'Time spent waiting for locks',
  labelNames: ['resource_type'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30],
});

export function recordConflict(type: string, entity: string, resolution: string, durationMs: number): void {
  conflictDetected.inc({ type, entity, resolution });
  conflictResolutionTime.observe({ type }, durationMs / 1000);
}
```

## Summary

Conflict detection in MiniOp operates at five levels: optimistic locking for write-write conflicts, version vectors for read-write detection, semantic validation for business rule violations, resource locks for shared infrastructure, and DAG validation for pipeline ordering. The free tier uses in-process mutexes and simple version counters. Production uses Redis-based distributed locks and PostgreSQL version vectors. All conflict events are recorded as metrics for monitoring and alerting.
