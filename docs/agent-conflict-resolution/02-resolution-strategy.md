# Conflict Resolution Strategy for MiniOp Agents

## Purpose

Detecting conflicts is only half the problem — MiniOp must also resolve them. This document defines the resolution strategies for each conflict type, including automatic resolution for common cases and escalation paths for conflicts that require human intervention.

## Resolution Strategy Matrix

| Conflict Type | Auto-Resolvable | Strategy | Escalation |
|--------------|----------------|----------|------------|
| Write-Write (metadata) | Yes | Last-writer-wins with merge | Notify on version gap > 5 |
| Write-Write (content) | Partial | Three-way merge for structured data | Manual review for unstructured |
| Read-Write (stale read) | Yes | Retry with fresh read | After 3 retries |
| Semantic (time overlap) | Yes | Priority-based arbitration | User notification |
| Resource contention | Yes | Priority queue with preemption | Alert on wait > 60s |
| Ordering violation | Yes | DAG re-evaluation, dependency requeue | Alert on cycle detection |

## Last-Writer-Wins with Merge

For metadata updates where changes are additive (tags, descriptions, labels), last-writer-wins with merge is the default strategy.

```typescript
// src/agents/resolution/last-writer-wins.ts
import { VersionVector, compareVectors, mergeVectors } from './version-vector';

interface MergeableEntity {
  id: string;
  version_vector: VersionVector;
  metadata: Record<string, unknown>;
  updated_at: string;
}

export async function resolveLastWriterWins<T extends MergeableEntity>(
  table: string,
  entityId: string,
  agentId: string,
  updates: Partial<T>
): Promise<{ resolved: boolean; merged?: T; conflict?: ConflictDetail }> {
  const current = await db.query(`SELECT * FROM ${table} WHERE id = $1`, [entityId]);
  if (current.rows.length === 0) throw new Error(`${entityId} not found`);

  const existing = current.rows[0] as T;

  // Check for concurrent modifications
  const readVector = updates.version_vector || {};
  const comparison = compareVectors(readVector, existing.version_vector);

  if (comparison === 'equal' || comparison === 'a_gt_b') {
    // No conflict — apply update directly
    const newVector = incrementVersion(existing.version_vector, agentId);
    const merged = await db.query(
      `UPDATE ${table} SET metadata = metadata || $1, version_vector = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [JSON.stringify(updates.metadata || {}), JSON.stringify(newVector), entityId]
    );
    return { resolved: true, merged: merged.rows[0] };
  }

  if (comparison === 'b_gt_a') {
    // Their changes are strictly ahead — apply ours on top
    const newVector = incrementVersion(existing.version_vector, agentId);
    const mergedMetadata = deepMerge(existing.metadata, updates.metadata || {});
    const merged = await db.query(
      `UPDATE ${table} SET metadata = $1, version_vector = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [JSON.stringify(mergedMetadata), JSON.stringify(newVector), entityId]
    );
    return { resolved: true, merged: merged.rows[0] };
  }

  // comparison === 'concurrent' — true conflict
  return {
    resolved: false,
    conflict: {
      type: 'concurrent_write',
      entityId,
      ourVector: readVector,
      theirVector: existing.version_vector,
      details: 'Concurrent modifications detected — manual resolution required',
    },
  };
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = deepMerge(
        (result[key] as Record<string, unknown>) || {},
        value as Record<string, unknown>
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}
```

## Three-Way Merge for Structured Data

For structured data like clip segment lists, transcription word arrays, and effect configurations, three-way merge provides more precise conflict resolution.

```typescript
// src/agents/resolution/three-way-merge.ts
interface MergeResult<T> {
  merged: T;
  conflicts: Array<{
    path: string;
    baseValue: unknown;
    oursValue: unknown;
    theirsValue: unknown;
    resolution: 'ours' | 'theirs' | 'manual';
  }>;
  autoResolved: number;
  manualRequired: number;
}

export function threeWayMerge<T extends Record<string, unknown>>(
  base: T,
  ours: T,
  theirs: T,
  conflictPolicy: ConflictPolicy = 'prefer-theirs'
): MergeResult<T> {
  const conflicts: MergeResult<T>['conflicts'] = [];
  const merged = { ...base } as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);

  for (const key of allKeys) {
    const baseVal = base[key];
    const oursVal = ours[key];
    const theirsVal = theirs[key];

    // Both unchanged
    if (deepEqual(oursVal, baseVal) && deepEqual(theirsVal, baseVal)) {
      continue;
    }

    // Only we changed
    if (!deepEqual(oursVal, baseVal) && deepEqual(theirsVal, baseVal)) {
      merged[key] = oursVal;
      continue;
    }

    // Only they changed
    if (deepEqual(oursVal, baseVal) && !deepEqual(theirsVal, baseVal)) {
      merged[key] = theirsVal;
      continue;
    }

    // Both changed — check if same value
    if (deepEqual(oursVal, theirsVal)) {
      merged[key] = oursVal; // Same change, no conflict
      continue;
    }

    // Both changed differently — conflict
    if (isMergeableArray(baseVal, oursVal, theirsVal)) {
      merged[key] = mergeArrays(baseVal as unknown[], oursVal as unknown[], theirsVal as unknown[]);
      conflicts.push({ path: key, baseValue: baseVal, oursValue: oursVal, theirsValue: theirsVal, resolution: 'auto-array-merge' });
    } else {
      const resolution = conflictPolicy === 'prefer-ours' ? 'ours' : 'theirs';
      merged[key] = resolution === 'ours' ? oursVal : theirsVal;
      conflicts.push({ path: key, baseValue: baseVal, oursValue: oursVal, theirsValue: theirsVal, resolution });
    }
  }

  return {
    merged: merged as T,
    conflicts,
    autoResolved: conflicts.filter(c => c.resolution.startsWith('auto')).length,
    manualRequired: conflicts.filter(c => c.resolution === 'manual').length,
  };
}

function isMergeableArray(base: unknown, ours: unknown, theirs: unknown): boolean {
  return Array.isArray(base) && Array.isArray(ours) && Array.isArray(theirs);
}

function mergeArrays(base: unknown[], ours: unknown[], theirs: unknown[]): unknown[] {
  // Identify additions from each side
  const ourAdds = ours.filter(item => !base.some(b => deepEqual(b, item)));
  const theirAdds = theirs.filter(item => !base.some(b => deepEqual(b, item)));
  const ourRemoves = base.filter(item => !ours.some(o => deepEqual(o, item)));
  const theirRemoves = base.filter(item => !theirs.some(t => deepEqual(t, item)));

  // Start with base, apply non-conflicting changes
  let result = base.filter(item =>
    !ourRemoves.some(r => deepEqual(r, item)) || theirAdds.some(a => deepEqual(a, item))
  );

  // Add from both sides
  result = [...result, ...ourAdds, ...theirAdds];

  // Remove duplicates
  return result.filter((item, index, arr) =>
    arr.findIndex(other => deepEqual(other, item)) === index
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
```

## Priority-Based Arbitration

When multiple agents make conflicting changes to the same resource, priority determines the winner.

```typescript
// src/agents/resolution/priority-arbitrator.ts
interface AgentPriority {
  agentId: string;
  priority: number;       // Higher = more important
  role: string;
  deadline?: Date;        // If set, this agent's work must complete by this time
}

const AGENT_PRIORITIES: Record<string, AgentPriority> = {
  'user-export':      { agentId: 'user-export',      priority: 100, role: 'export' },
  'user-clip-edit':   { agentId: 'user-clip-edit',    priority: 90,  role: 'editing' },
  'ai-analysis':      { agentId: 'ai-analysis',       priority: 50,  role: 'analysis' },
  'auto-clip':        { agentId: 'auto-clip',         priority: 40,  role: 'generation' },
  'thumbnail-gen':    { agentId: 'thumbnail-gen',     priority: 30,  role: 'assets' },
  'analytics':        { agentId: 'analytics',         priority: 10,  role: 'analytics' },
};

export function resolvePriorityConflict(
  contenders: Array<{ agentId: string; operation: string; timestamp: string }>
): { winner: string; losers: string[]; reason: string } {
  const ranked = contenders
    .map(c => ({
      ...c,
      priority: AGENT_PRIORITIES[c.agentId]?.priority || 0,
    }))
    .sort((a, b) => b.priority - a.priority);

  // Check for deadline preemption
  const withDeadlines = ranked.filter(c =>
    AGENT_PRIORITIES[c.agentId]?.deadline &&
    AGENT_PRIORITIES[c.agentId].deadline.getTime() - Date.now() < 60000 // Within 1 minute
  );

  if (withDeadlines.length > 0) {
    const deadlineWinner = withDeadlines[0];
    return {
      winner: deadlineWinner.agentId,
      losers: contenders.filter(c => c.agentId !== deadlineWinner.agentId).map(c => c.agentId),
      reason: `Deadline preemption: ${deadlineWinner.agentId} has imminent deadline`,
    };
  }

  return {
    winner: ranked[0].agentId,
    losers: ranked.slice(1).map(c => c.agentId),
    reason: `Priority-based: ${ranked[0].agentId} (priority ${ranked[0].priority}) beats ${ranked[1].agentId} (priority ${ranked[1].priority})`,
  };
}

export async function applyPriorityResolution(
  resourceId: string,
  contenders: Array<{ agentId: string; operation: string }>
): Promise<void> {
  const resolution = resolvePriorityConflict(contenders);

  // Notify losers to abort their operations
  for (const loserId of resolution.losers) {
    await notifyAgentAbort(loserId, resourceId, resolution.reason);
  }

  // Log the resolution
  await logConflictResolution({
    type: 'priority_arbitration',
    resourceId,
    winner: resolution.winner,
    losers: resolution.losers,
    reason: resolution.reason,
  });
}
```

## Semantic Conflict Resolution

Time range overlaps in clips require intelligent resolution that preserves user intent.

```typescript
// src/agents/resolution/semantic-resolver.ts
export interface OverlapResolution {
  strategy: 'trim' | 'split' | 'merge' | 'reject';
  adjustments: Array<{
    clipId: string;
    newStart?: number;
    newEnd?: number;
    action: 'keep' | 'trim-start' | 'trim-end' | 'split' | 'merge';
  }>;
}

export function resolveTimeOverlap(
  existing: Array<{ id: string; start: number; end: number; priority: number }>,
  incoming: { id: string; start: number; end: number; priority: number }
): OverlapResolution {
  // Sort by priority (highest first)
  const all = [...existing, incoming].sort((a, b) => b.priority - a.priority);
  const adjustments: OverlapResolution['adjustments'] = [];

  for (let i = 0; i < all.length; i++) {
    const current = all[i];
    for (let j = i + 1; j < all.length; j++) {
      const other = all[j];

      const overlapStart = Math.max(current.start, other.start);
      const overlapEnd = Math.min(current.end, other.end);

      if (overlapStart >= overlapEnd) continue; // No overlap

      const overlapDuration = overlapEnd - overlapStart;

      if (overlapDuration < 2) {
        // Tiny overlap — just trim the lower-priority clip
        adjustments.push({
          clipId: other.id,
          newStart: other.start < current.start ? other.start : overlapEnd,
          newEnd: other.end > current.end ? other.end : overlapStart,
          action: other.start < current.start ? 'trim-end' : 'trim-start',
        });
      } else if (overlapDuration > (other.end - other.start) * 0.5) {
        // Major overlap — split the lower-priority clip
        adjustments.push({
          clipId: other.id,
          action: 'split',
          // Split into two parts: before and after the higher-priority clip
        });
      } else {
        // Moderate overlap — trim
        if (other.start < current.start) {
          adjustments.push({ clipId: other.id, newEnd: current.start, action: 'trim-end' });
        } else {
          adjustments.push({ clipId: other.id, newStart: current.end, action: 'trim-start' });
        }
      }
    }
  }

  return {
    strategy: adjustments.some(a => a.action === 'split') ? 'split' : 'trim',
    adjustments,
  };
}
```

## Retry with Backoff

For transient conflicts (stale reads, temporary locks), retry with exponential backoff is the default resolution.

```typescript
// src/agents/resolution/retry.ts
export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterFactor: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  shouldRetry: (error: Error) => boolean,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: Error;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === cfg.maxRetries || !shouldRetry(lastError)) {
        throw lastError;
      }

      // Calculate delay with exponential backoff and jitter
      const baseDelay = cfg.baseDelayMs * Math.pow(cfg.backoffMultiplier, attempt);
      const jitter = baseDelay * cfg.jitterFactor * (Math.random() * 2 - 1);
      const delay = Math.min(baseDelay + jitter, cfg.maxDelayMs);

      console.log(`Retry attempt ${attempt + 1}/${cfg.maxRetries} after ${delay}ms: ${lastError.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw lastError!;
}

// Usage
export async function updateClipWithRetry(
  clipId: string,
  updates: Partial<Clip>
): Promise<Clip> {
  return withRetry(
    () => updateWithLock('clips', clipId, updates.version, updates),
    (error) => error instanceof OptimisticLockError,
    { maxRetries: 3 }
  );
}
```

## Conflict Resolution Queue

When automatic resolution fails, conflicts enter a resolution queue for human review.

```typescript
// src/agents/resolution/queue.ts
interface ConflictTicket {
  id: string;
  type: string;
  resourceId: string;
  resourceType: string;
  detectedAt: string;
  contenders: Array<{
    agentId: string;
    operation: string;
    proposedState: unknown;
  }>;
  autoResolutionAttempted: boolean;
  autoResolutionResult?: string;
  status: 'pending' | 'in_review' | 'resolved' | 'escalated';
  assignedTo?: string;
  resolution?: {
    chosenState: unknown;
    resolvedBy: string;
    resolvedAt: string;
    reason: string;
  };
}

export async function createConflictTicket(
  type: string,
  resourceId: string,
  resourceType: string,
  contenders: ConflictTicket['contenders']
): Promise<string> {
  const ticket: ConflictTicket = {
    id: `conflict_${uuidv7()}`,
    type,
    resourceId,
    resourceType,
    detectedAt: new Date().toISOString(),
    contenders,
    autoResolutionAttempted: false,
    status: 'pending',
  };

  await db.query(
    `INSERT INTO conflict_tickets (id, type, resource_id, resource_type, detected_at,
     contenders, status) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ticket.id, type, resourceId, resourceType, ticket.detectedAt,
     JSON.stringify(contenders), 'pending']
  );

  // Notify operations team if severity is high
  if (type === 'write_write_content' || type === 'circular_dependency') {
    await notifyOpsTeam(ticket);
  }

  return ticket.id;
}

export async function resolveConflictTicket(
  ticketId: string,
  resolution: ConflictTicket['resolution']
): Promise<void> {
  await db.query(
    `UPDATE conflict_tickets SET status = 'resolved', resolution = $1 WHERE id = $2`,
    [JSON.stringify(resolution), ticketId]
  );

  // Apply the chosen resolution
  const ticket = await db.query('SELECT * FROM conflict_tickets WHERE id = $1', [ticketId]);
  const t = ticket.rows[0];

  await applyResolution(t.resource_type, t.resource_id, resolution.chosenState);
}
```

## Free Tier: Simplified Resolution

On the free tier, conflict resolution is simpler because agents run in-process.

```typescript
// src/agents/resolution/local-resolver.ts
import { withLock } from './local-mutex';

export async function resolveLocalConflict<T>(
  resourceId: string,
  agentId: string,
  operation: () => Promise<T>
): Promise<T> {
  return withLock(`resolution:${resourceId}`, async () => {
    // Re-read current state inside the lock
    const currentState = await readResourceState(resourceId);

    // Check if our operation is still valid
    if (!isOperationStillValid(currentState, agentId)) {
      throw new ConflictResolutionError(
        `Operation no longer valid for ${resourceId}`,
        { resourceId, agentId }
      );
    }

    return operation();
  });
}
```

## Resolution Metrics and Alerting

```typescript
// src/agents/resolution/metrics.ts
import { Counter, Histogram, Gauge } from 'prom-client';

export const resolutionsTotal = new Counter({
  name: 'minio_conflict_resolutions_total',
  help: 'Total conflict resolutions',
  labelNames: ['type', 'strategy', 'outcome'],
});

export const resolutionDuration = new Histogram({
  name: 'minio_resolution_duration_seconds',
  help: 'Time to resolve conflicts',
  labelNames: ['type', 'strategy'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30],
});

export const pendingConflicts = new Gauge({
  name: 'minio_pending_conflicts',
  help: 'Number of unresolved conflicts',
  labelNames: ['type'],
});

// Alert when too many conflicts are pending
export function checkConflictBacklog(): void {
  const types = ['write_write', 'semantic', 'resource', 'ordering'];
  for (const type of types) {
    const count = getPendingConflictCount(type);
    pendingConflicts.set({ type }, count);
    if (count > 10) {
      sendAlert(`High conflict backlog: ${count} pending ${type} conflicts`);
    }
  }
}
```

## Summary

Conflict resolution in MiniOp uses a tiered approach. Simple conflicts (stale reads, additive metadata) resolve automatically via last-writer-wins with merge or retry with backoff. Structured data conflicts use three-way merge. Resource contention uses priority-based arbitration with deadline preemption. Semantic conflicts (time range overlaps) use domain-specific resolution with trim/split/merge strategies. When automatic resolution fails, conflicts enter a ticketing queue for human review. The free tier uses in-process mutex-based resolution; production uses distributed coordination with Redis and PostgreSQL.
