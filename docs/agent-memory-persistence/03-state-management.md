# Agent State Management for MiniOp

## Overview

MiniOp agents transition through multiple states during their lifecycle: initializing, idle, processing, waiting, error, and terminated. State management ensures agents can be monitored, recovered, and coordinated. This document defines the state machine, persistence strategies, recovery procedures, and scaling patterns for agent state management.

## Agent State Machine

```
                    ┌─────────────┐
                    │  INITIALIZING│
                    └──────┬──────┘
                           │ ready
                           ▼
    ┌──────────┐    ┌─────────────┐    ┌──────────┐
    │ WAITING  │◄───│    IDLE     │───▶│ PROCESSING│
    │(resource)│    └──────┬──────┘    └─────┬────┘
    └──────────┘           │                 │
           │          claimed            completed
           │               │                 │
           ▼               ▼                 ▼
    ┌──────────────┐ ┌─────────────┐  ┌──────────┐
    │  PROCESSING  │ │  PROCESSING │  │   IDLE   │
    └──────────────┘ └──────┬──────┘  └──────────┘
                           │ error
                           ▼
                    ┌─────────────┐    ┌──────────┐
                    │   ERROR     │───▶│ RECOVERY │
                    └──────┬──────┘    └─────┬────┘
                           │ unrecoverable   │ recovered
                           ▼                 │
                    ┌─────────────┐          │
                    │ TERMINATED  │◄─────────┘
                    └─────────────┘
```

## State Definitions

```typescript
// src/agents/state/types.ts
export type AgentState =
  | 'initializing'
  | 'idle'
  | 'processing'
  | 'waiting'
  | 'error'
  | 'recovery'
  | 'terminated';

export interface AgentStateRecord {
  agentId: string;
  agentType: string;
  currentState: AgentState;
  previousState: AgentState | null;
  stateEnteredAt: string;
  stateReason: string | null;
  metadata: Record<string, unknown>;
  version: number;
}

export interface StateTransition {
  from: AgentState;
  to: AgentState;
  trigger: string;
  guard?: (agent: AgentStateRecord) => boolean;
  action?: (agent: AgentStateRecord) => Promise<void>;
}

export const VALID_TRANSITIONS: StateTransition[] = [
  { from: 'initializing', to: 'idle',       trigger: 'init_complete' },
  { from: 'initializing', to: 'terminated', trigger: 'init_failed' },
  { from: 'idle',         to: 'processing', trigger: 'task_claimed' },
  { from: 'idle',         to: 'waiting',    trigger: 'resource_needed' },
  { from: 'idle',         to: 'terminated', trigger: 'shutdown' },
  { from: 'processing',   to: 'idle',       trigger: 'task_completed' },
  { from: 'processing',   to: 'error',      trigger: 'task_failed' },
  { from: 'processing',   to: 'waiting',    trigger: 'resource_needed' },
  { from: 'processing',   to: 'terminated', trigger: 'shutdown' },
  { from: 'waiting',      to: 'processing', trigger: 'resource_acquired' },
  { from: 'waiting',      to: 'error',      trigger: 'wait_timeout' },
  { from: 'waiting',      to: 'idle',       trigger: 'wait_cancelled' },
  { from: 'error',        to: 'recovery',   trigger: 'recoverable' },
  { from: 'error',        to: 'terminated', trigger: 'unrecoverable' },
  { from: 'recovery',     to: 'idle',       trigger: 'recovered' },
  { from: 'recovery',     to: 'terminated', trigger: 'recovery_failed' },
];
```

## State Manager Implementation

```typescript
// src/agents/state/state-manager.ts
import { EventEmitter } from 'events';

export class AgentStateManager extends EventEmitter {
  private state: AgentStateRecord;
  private redis: Redis;
  private db: Pool;
  private stateHistory: Array<{ state: AgentState; at: string; reason: string }> = [];

  constructor(agentId: string, agentType: string, redis: Redis, db: Pool) {
    super();
    this.redis = redis;
    this.db = db;
    this.state = {
      agentId,
      agentType,
      currentState: 'initializing',
      previousState: null,
      stateEnteredAt: new Date().toISOString(),
      stateReason: 'Agent starting',
      metadata: {},
      version: 0,
    };
  }

  async transition(to: AgentState, trigger: string, reason?: string, metadata?: Record<string, unknown>): Promise<void> {
    const current = this.state.currentState;

    // Validate transition
    const valid = VALID_TRANSITIONS.find(t => t.from === current && t.to === to);
    if (!valid) {
      throw new Error(`Invalid state transition: ${current} → ${to} (trigger: ${trigger})`);
    }

    // Execute guard if defined
    if (valid.guard && !valid.guard(this.state)) {
      throw new Error(`Guard rejected transition: ${current} → ${to}`);
    }

    // Execute action if defined
    if (valid.action) {
      await valid.action(this.state);
    }

    const previousState = current;
    this.state.previousState = previousState;
    this.state.currentState = to;
    this.state.stateEnteredAt = new Date().toISOString();
    this.state.stateReason = reason || trigger;
    this.state.metadata = { ...this.state.metadata, ...metadata };
    this.state.version++;

    // Record history
    this.stateHistory.push({
      state: to,
      at: this.state.stateEnteredAt,
      reason: reason || trigger,
    });

    // Persist to Redis (hot)
    await this.redis.set(
      `agent:state:${this.state.agentId}`,
      JSON.stringify(this.state),
      'EX',
      300
    );

    // Persist to PostgreSQL (durable)
    await this.db.query(
      `INSERT INTO agent_state_transitions (agent_id, from_state, to_state, trigger, reason, metadata, transitioned_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [this.state.agentId, previousState, to, trigger, reason, JSON.stringify(metadata)]
    );

    // Update current state in agents table
    await this.db.query(
      `UPDATE agents SET current_state = $1, state_updated_at = NOW(), state_version = $2
       WHERE id = $3`,
      [to, this.state.version, this.state.agentId]
    );

    // Emit event
    this.emit('state:changed', {
      agentId: this.state.agentId,
      from: previousState,
      to,
      trigger,
      reason,
    });

    // Publish to Redis for other agents to observe
    await this.redis.publish(`agent:state:${this.state.agentId}`, JSON.stringify({
      from: previousState,
      to,
      trigger,
      reason,
      at: this.state.stateEnteredAt,
    }));
  }

  getCurrentState(): AgentStateRecord {
    return { ...this.state };
  }

  getStateHistory(): Array<{ state: AgentState; at: string; reason: string }> {
    return [...this.stateHistory];
  }

  isInState(state: AgentState): boolean {
    return this.state.currentState === state;
  }

  timeInCurrentState(): number {
    return Date.now() - new Date(this.state.stateEnteredAt).getTime();
  }
}
```

## State Persistence

### PostgreSQL Schema

```sql
CREATE TABLE agents (
    id                  TEXT PRIMARY KEY,
    agent_type          TEXT NOT NULL,
    current_state       TEXT NOT NULL DEFAULT 'initializing',
    state_updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    state_version       INTEGER NOT NULL DEFAULT 0,
    capabilities        JSONB DEFAULT '[]',
    metadata            JSONB DEFAULT '{}',
    registered_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_heartbeat      TIMESTAMPTZ
);

CREATE TABLE agent_state_transitions (
    id                  BIGSERIAL PRIMARY KEY,
    agent_id            TEXT NOT NULL REFERENCES agents(id),
    from_state          TEXT NOT NULL,
    to_state            TEXT NOT NULL,
    trigger             TEXT NOT NULL,
    reason              TEXT,
    metadata            JSONB DEFAULT '{}',
    transitioned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_transitions_agent ON agent_state_transitions(agent_id, transitioned_at);
CREATE INDEX idx_transitions_state ON agent_state_transitions(to_state, transitioned_at);
CREATE INDEX idx_agents_state ON agents(current_state, state_updated_at);
```

### State Recovery After Crash

```typescript
// src/agents/state/recovery.ts
export class StateRecoveryManager {
  private db: Pool;
  private redis: Redis;

  constructor(db: Pool, redis: Redis) {
    this.db = db;
    this.redis = redis;
  }

  async recoverStaleAgents(maxHeartbeatAgeSeconds: number = 60): Promise<void> {
    // Find agents that haven't heartbeated recently
    const stale = await this.db.query(
      `SELECT id, agent_type, current_state, state_updated_at
       FROM agents
       WHERE current_state NOT IN ('terminated')
         AND last_heartbeat < NOW() - INTERVAL '1 second' * $1`,
      [maxHeartbeatAgeSeconds]
    );

    for (const agent of stale.rows) {
      console.log(`Recovering stale agent: ${agent.id} (state: ${agent.current_state})`);

      // Check if agent has a Redis lock (might be alive but slow)
      const redisState = await this.redis.get(`agent:state:${agent.id}`);
      if (redisState) {
        const state = JSON.parse(redisState);
        const stateAge = Date.now() - new Date(state.stateEnteredAt).getTime();

        if (stateAge < maxHeartbeatAgeSeconds * 1000 * 2) {
          // State is recent in Redis — agent might just be slow
          continue;
        }
      }

      // Agent is truly stale — initiate recovery
      await this.recoverAgent(agent.id, agent.current_state);
    }
  }

  private async recoverAgent(agentId: string, lastState: string): Promise<void> {
    // Record the crash
    await this.db.query(
      `INSERT INTO agent_state_transitions (agent_id, from_state, to_state, trigger, reason, transitioned_at)
       VALUES ($1, $2, 'error', 'crash_detected', 'Heartbeat timeout', NOW())`,
      [agentId, lastState]
    );

    // Update agent state
    await this.db.query(
      `UPDATE agents SET current_state = 'error', state_updated_at = NOW(), state_version = state_version + 1
       WHERE id = $1`,
      [agentId]
    );

    // Release held resources
    await this.releaseAgentResources(agentId);

    // Requeue tasks
    await this.requeueAgentTasks(agentId);

    // Notify monitoring
    await this.redis.publish('agent:events', JSON.stringify({
      type: 'agent_crashed',
      agentId,
      lastState,
      detectedAt: new Date().toISOString(),
    }));
  }

  private async releaseAgentResources(agentId: string): Promise<void> {
    // Release Redis locks
    const lockKeys = await this.redis.keys('lock:*');
    for (const key of lockKeys) {
      const lock = await this.redis.get(key);
      if (lock) {
        const data = JSON.parse(lock);
        if (data.agent === agentId || data.agentId === agentId) {
          await this.redis.del(key);
          console.log(`Released lock: ${key}`);
        }
      }
    }

    // Release GPU allocations
    const gpuKeys = await this.redis.keys('gpu:allocated:*');
    for (const key of gpuKeys) {
      const allocation = await this.redis.get(key);
      if (allocation && JSON.parse(allocation).agentId === agentId) {
        await this.redis.del(key);
        console.log(`Released GPU: ${key}`);
      }
    }
  }

  private async requeueAgentTasks(agentId: string): Promise<void> {
    // Find tasks claimed by this agent
    const claimed = await this.redis.keys('task:*:claim');
    for (const key of claimed) {
      const claim = await this.redis.hgetall(key);
      if (claim.agentId === agentId) {
        const taskId = key.split(':')[1];
        const queue = claim.queue || 'default';

        // Re-enqueue
        await this.redis.lpush(`queue:${queue}`, taskId);
        await this.redis.del(key);

        // Update task state
        await this.db.query(
          `UPDATE processing_tasks SET status = 'queued', assigned_agent = NULL
           WHERE id = $1`,
          [taskId]
        );

        console.log(`Requeued task: ${taskId} to queue: ${queue}`);
      }
    }
  }
}
```

## Free Tier: Simple State Management

On the free tier, agents run in-process. State management is simplified.

```typescript
// src/agents/state/local-state-manager.ts
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';

export class LocalStateManager extends EventEmitter {
  private state: AgentState = 'initializing';
  private db: Database.Database;
  private agentId: string;
  private stateEnteredAt: Date = new Date();

  constructor(agentId: string, dbPath: string = './data/agent-state.db') {
    super();
    this.agentId = agentId;
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_state_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id    TEXT NOT NULL,
        from_state  TEXT,
        to_state    TEXT NOT NULL,
        reason      TEXT,
        transitioned_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Restore last state if exists
    const last = this.db.prepare(
      'SELECT to_state FROM agent_state_log WHERE agent_id = ? ORDER BY id DESC LIMIT 1'
    ).get(this.agentId) as any;

    if (last) {
      this.state = last.to_state as AgentState;
    }
  }

  transition(to: AgentState, reason?: string): void {
    const from = this.state;

    const valid = VALID_TRANSITIONS.find(t => t.from === from && t.to === to);
    if (!valid) {
      throw new Error(`Invalid transition: ${from} → ${to}`);
    }

    this.state = to;
    this.stateEnteredAt = new Date();

    this.db.prepare(
      'INSERT INTO agent_state_log (agent_id, from_state, to_state, reason) VALUES (?, ?, ?, ?)'
    ).run(this.agentId, from, to, reason);

    this.emit('state:changed', { from, to, reason });
  }

  getState(): AgentState {
    return this.state;
  }

  getTimeInState(): number {
    return Date.now() - this.stateEnteredAt.getTime();
  }
}
```

## Multi-Agent State Coordination

When multiple agents work on the same pipeline, their states must be coordinated.

```typescript
// src/agents/state/pipeline-coordinator.ts
export class PipelineCoordinator {
  private redis: Redis;
  private db: Pool;

  constructor(redis: Redis, db: Pool) {
    this.redis = redis;
    this.db = db;
  }

  async getPipelineState(videoId: string): Promise<PipelineState> {
    const agents = await this.db.query(
      `SELECT a.id, a.agent_type, a.current_state, a.state_updated_at
       FROM agents a
       JOIN agent_tasks t ON t.agent_id = a.id
       WHERE t.video_id = $1`,
      [videoId]
    );

    const stages: PipelineStage[] = agents.rows.map(a => ({
      agentId: a.id,
      type: a.agent_type,
      state: a.current_state as AgentState,
      updatedAt: a.state_updated_at,
    }));

    return {
      videoId,
      stages,
      overallState: this.calculateOverallState(stages),
      bottlenecks: this.identifyBottlenecks(stages),
    };
  }

  private calculateOverallState(stages: PipelineStage[]): PipelineOverallState {
    if (stages.some(s => s.state === 'error')) return 'failed';
    if (stages.every(s => s.state === 'idle')) return 'completed';
    if (stages.some(s => s.state === 'processing')) return 'processing';
    if (stages.some(s => s.state === 'waiting')) return 'waiting';
    return 'pending';
  }

  private identifyBottlenecks(stages: PipelineStage[]): string[] {
    const bottlenecks: string[] = [];

    // Find stages that have been waiting too long
    for (const stage of stages) {
      if (stage.state === 'waiting') {
        const waitTime = Date.now() - new Date(stage.updatedAt).getTime();
        if (waitTime > 60000) { // Waiting > 1 minute
          bottlenecks.push(`${stage.type} (${stage.agentId}) has been waiting ${Math.round(waitTime / 1000)}s`);
        }
      }
    }

    return bottlenecks;
  }

  async waitForStageCompletion(
    videoId: string,
    stageType: string,
    timeoutMs: number = 300000
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for ${stageType} to complete`));
      }, timeoutMs);

      const check = async () => {
        const agents = await this.db.query(
          `SELECT current_state FROM agents a
           JOIN agent_tasks t ON t.agent_id = a.id
           WHERE t.video_id = $1 AND a.agent_type = $2`,
          [videoId, stageType]
        );

        if (agents.rows.length > 0 && agents.rows[0].current_state === 'idle') {
          clearTimeout(timeout);
          resolve();
        }
      };

      // Subscribe to state changes
      const subscriber = new Redis(process.env.REDIS_URL);
      subscriber.subscribe(`agent:state:*`);
      subscriber.on('message', async (channel, message) => {
        const data = JSON.parse(message);
        if (data.to === 'idle') {
          await check();
        }
      });

      // Also poll periodically
      const interval = setInterval(check, 5000);

      check(); // Initial check
    });
  }
}
```

## State-Based Auto-Scaling

```typescript
// src/agents/state/auto-scaler.ts
export class AgentAutoScaler {
  private redis: Redis;
  private db: Pool;
  private config: ScalerConfig;

  constructor(redis: Redis, db: Pool, config: ScalerConfig) {
    this.redis = redis;
    this.db = db;
    this.config = config;
  }

  async evaluate(): Promise<ScaleDecision> {
    // Count agents by state
    const stateCounts = await this.db.query(
      `SELECT current_state, COUNT(*) as count
       FROM agents
       WHERE agent_type = $1
       GROUP BY current_state`,
      [this.config.agentType]
    );

    const counts = Object.fromEntries(
      stateCounts.rows.map(r => [r.current_state, parseInt(r.count)])
    );

    const idle = counts['idle'] || 0;
    const processing = counts['processing'] || 0;
    const waiting = counts['waiting'] || 0;
    const total = idle + processing + waiting;

    // Check queue depth
    const queueDepth = await this.redis.llen(`queue:${this.config.queueName}`);

    // Scale up if queue is growing and all agents are busy
    if (queueDepth > this.config.scaleUpQueueThreshold && idle === 0 && total < this.config.maxAgents) {
      const desiredCount = Math.min(
        total + Math.ceil(queueDepth / this.config.tasksPerAgent),
        this.config.maxAgents
      );
      return { action: 'scale_up', currentCount: total, desiredCount, reason: `Queue depth: ${queueDepth}` };
    }

    // Scale down if too many idle agents
    if (idle > this.config.scaleDownIdleThreshold && total > this.config.minAgents) {
      const desiredCount = Math.max(
        total - (idle - this.config.scaleDownIdleThreshold),
        this.config.minAgents
      );
      return { action: 'scale_down', currentCount: total, desiredCount, reason: `Idle agents: ${idle}` };
    }

    return { action: 'no_change', currentCount: total, desiredCount: total, reason: 'Within thresholds' };
  }

  async executeScaleDecision(decision: ScaleDecision): Promise<void> {
    if (decision.action === 'no_change') return;

    console.log(`Scaling ${decision.action}: ${decision.currentCount} → ${decision.desiredCount} (${decision.reason})`);

    if (decision.action === 'scale_up') {
      const toAdd = decision.desiredCount - decision.currentCount;
      for (let i = 0; i < toAdd; i++) {
        await this.spawnAgent();
      }
    } else {
      const toRemove = decision.currentCount - decision.desiredCount;
      await this.terminateIdleAgents(toRemove);
    }
  }

  private async spawnAgent(): Promise<void> {
    // Kubernetes: scale deployment
    // Docker Compose: increase replicas
    // Local: fork process
  }

  private async terminateIdleAgents(count: number): Promise<void> {
    const idle = await this.db.query(
      `SELECT id FROM agents WHERE agent_type = $1 AND current_state = 'idle'
       ORDER BY state_updated_at ASC LIMIT $2`,
      [this.config.agentType, count]
    );

    for (const agent of idle.rows) {
      // Send shutdown signal
      await this.redis.publish(`agent:state:${agent.id}`, JSON.stringify({
        trigger: 'shutdown',
        reason: 'auto_scale_down',
      }));
    }
  }
}
```

## State Monitoring Dashboard

```typescript
// src/agents/state/monitor.ts
export class StateMonitor {
  private db: Pool;

  constructor(db: Pool) {
    this.db = db;
  }

  async getAgentSummary(): Promise<AgentSummary> {
    const agents = await this.db.query(
      `SELECT agent_type, current_state, COUNT(*) as count
       FROM agents
       WHERE current_state != 'terminated'
       GROUP BY agent_type, current_state`
    );

    const transitions = await this.db.query(
      `SELECT to_state, COUNT(*) as count
       FROM agent_state_transitions
       WHERE transitioned_at > NOW() - INTERVAL '1 hour'
       GROUP BY to_state`
    );

    return {
      agents: agents.rows,
      recentTransitions: transitions.rows,
      timestamp: new Date().toISOString(),
    };
  }

  async getAgentTimeline(agentId: string, hours: number = 24): Promise<StateTimelineEntry[]> {
    const result = await this.db.query(
      `SELECT from_state, to_state, trigger, reason, transitioned_at
       FROM agent_state_transitions
       WHERE agent_id = $1 AND transitioned_at > NOW() - INTERVAL '1 hour' * $2
       ORDER BY transitioned_at ASC`,
      [agentId, hours]
    );

    return result.rows;
  }

  async getStuckAgents(thresholdSeconds: number = 300): Promise<StuckAgent[]> {
    const result = await this.db.query(
      `SELECT id, agent_type, current_state, state_updated_at,
              EXTRACT(EPOCH FROM (NOW() - state_updated_at)) as seconds_in_state
       FROM agents
       WHERE current_state IN ('waiting', 'error')
         AND state_updated_at < NOW() - INTERVAL '1 second' * $1`,
      [thresholdSeconds]
    );

    return result.rows;
  }
}
```

## State Persistence for Free Tier

```typescript
// src/agents/state/local-state-persistence.ts
import Database from 'better-sqlite3';

export class LocalStatePersistence {
  private db: Database.Database;

  constructor(dbPath: string = './data/agent-state.db') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_state (
        agent_id        TEXT PRIMARY KEY,
        agent_type      TEXT NOT NULL,
        current_state   TEXT NOT NULL,
        state_version   INTEGER NOT NULL DEFAULT 0,
        metadata        TEXT DEFAULT '{}',
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS agent_state_history (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id        TEXT NOT NULL,
        from_state      TEXT,
        to_state        TEXT NOT NULL,
        reason          TEXT,
        transitioned_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_history_agent ON agent_state_history(agent_id, transitioned_at);
    `);
  }

  saveState(agentId: string, state: AgentStateRecord): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO agent_state (agent_id, agent_type, current_state, state_version, metadata, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).run(agentId, state.agentType, state.currentState, state.version, JSON.stringify(state.metadata));
  }

  loadState(agentId: string): AgentStateRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM agent_state WHERE agent_id = ?'
    ).get(agentId) as any;

    if (!row) return null;

    return {
      agentId: row.agent_id,
      agentType: row.agent_type,
      currentState: row.current_state,
      previousState: null,
      stateEnteredAt: row.updated_at,
      stateReason: null,
      metadata: JSON.parse(row.metadata || '{}'),
      version: row.state_version,
    };
  }

  getActiveAgents(): AgentStateRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM agent_state WHERE current_state != 'terminated'"
    ).all() as any[];

    return rows.map(row => ({
      agentId: row.agent_id,
      agentType: row.agent_type,
      currentState: row.current_state,
      previousState: null,
      stateEnteredAt: row.updated_at,
      stateReason: null,
      metadata: JSON.parse(row.metadata || '{}'),
      version: row.state_version,
    }));
  }
}
```

## Summary

Agent state management in MiniOp uses a formal state machine with validated transitions. State is persisted in PostgreSQL for durability and Redis for fast access. Crash detection uses heartbeat monitoring with automatic resource release and task requeueing. Pipeline coordination tracks multi-agent workflows and identifies bottlenecks. Auto-scaling uses state distribution and queue depth to provision or terminate agents. The free tier uses SQLite with a simplified state machine. All state transitions are logged for debugging and auditing.
