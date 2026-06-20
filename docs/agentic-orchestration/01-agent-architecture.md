# Agent Architecture

MiniOp's agentic orchestration system coordinates AI-powered video clipping, review, and deployment across a distributed pipeline. This document covers the architecture from local development (free tier) through scaled production.

## Core Agent Topology

MiniOp uses a **supervisor-worker** pattern. A single supervisor agent routes tasks to specialized workers. Each worker owns one concern: video analysis, clip generation, metadata enrichment, or deployment.

```
┌─────────────────────────────────────────────────────┐
│                   Supervisor Agent                   │
│  (routes tasks, manages retries, aggregates results) │
└──────┬──────────┬──────────┬──────────┬─────────────┘
       │          │          │          │
  ┌────▼───┐ ┌───▼────┐ ┌───▼───┐ ┌───▼──────┐
  │ Video  │ │  Clip  │ │ Meta  │ │ Deploy   │
  │Analyst │ │Generator│ │Enrichr│ │ Agent    │
  └────────┘ └────────┘ └───────┘ └──────────┘
```

### Free Tier: Single-Process Orchestration

On free tier, all agents run as coroutines inside a single Node.js process. No external message broker is required. Communication happens through an in-process event bus backed by `AsyncLocalStorage` for context propagation.

```typescript
// src/agents/supervisor.ts
import { EventBus } from '../lib/event-bus';
import { VideoAnalyst } from './video-analyst';
import { ClipGenerator } from './clip-generator';
import { MetaEnricher } from './meta-enricher';
import { DeployAgent } from './deploy-agent';

interface TaskMessage {
  id: string;
  type: 'analyze' | 'clip' | 'enrich' | 'deploy';
  payload: Record<string, unknown>;
  parentId?: string;
  retryCount: number;
}

export class Supervisor {
  private agents = new Map<string, (msg: TaskMessage) => Promise<unknown>>();

  constructor(private bus: EventBus) {
    this.agents.set('analyze', new VideoAnalyst(bus).handle);
    this.agents.set('clip', new ClipGenerator(bus).handle);
    this.agents.set('enrich', new MetaEnricher(bus).handle);
    this.agents.set('deploy', new DeployAgent(bus).handle);
  }

  async dispatch(msg: TaskMessage): Promise<void> {
    const handler = this.agents.get(msg.type);
    if (!handler) throw new Error(`Unknown task type: ${msg.type}`);

    try {
      const result = await handler(msg);
      this.bus.emit('task:complete', { id: msg.id, result });
    } catch (err) {
      if (msg.retryCount < 3) {
        this.bus.emit('task:retry', { ...msg, retryCount: msg.retryCount + 1 });
      } else {
        this.bus.emit('task:failed', { id: msg.id, error: err });
      }
    }
  }
}
```

The free-tier bus is a simple `EventEmitter` wrapper with typed channels:

```typescript
// src/lib/event-bus.ts
import { EventEmitter } from 'events';
import { AsyncLocalStorage } from 'async_hooks';

export class EventBus {
  private emitter = new EventEmitter();
  private store = new AsyncLocalStorage<{ traceId: string }>();

  emit(event: string, data: unknown): void {
    const ctx = this.store.getStore();
    this.emitter.emit(event, { ...data as object, traceId: ctx?.traceId });
  }

  on(event: string, handler: (data: any) => void): void {
    this.emitter.on(event, handler);
  }

  runWithTrace<T>(traceId: string, fn: () => Promise<T>): Promise<T> {
    return this.store.run({ traceId }, fn);
  }
}
```

### Scaled Production: Distributed Agents

In production, agents run as independent services communicating through Redis Streams (or Kafka for high throughput). Each agent is a container with its own health checks and scaling policy.

```yaml
# docker-compose.prod.yml (excerpt)
services:
  supervisor:
    image: miniop/supervisor:latest
    environment:
      REDIS_URL: redis://redis:6379
      ORCHESTRATOR_MODE: distributed
    deploy:
      replicas: 2

  agent-video-analyst:
    image: miniop/agent-video-analyst:latest
    environment:
      REDIS_URL: redis://redis:6379
      STREAM_CONSUMER_GROUP: video-analysts
      CONCURRENCY: 4
    deploy:
      replicas: 3

  agent-clip-generator:
    image: miniop/agent-clip-generator:latest
    environment:
      REDIS_URL: redis://redis:6379
      STREAM_CONSUMER_GROUP: clip-generators
      GPU_ENABLED: "true"
    deploy:
      replicas: 5
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

The distributed event bus wraps Redis Streams:

```typescript
// src/lib/redis-event-bus.ts
import Redis from 'ioredis';

export class RedisEventBus {
  private redis: Redis;
  private consumerGroup: string;

  constructor(redisUrl: string, consumerGroup: string) {
    this.redis = new Redis(redisUrl);
    this.consumerGroup = consumerGroup;
  }

  async emit(stream: string, data: Record<string, unknown>): Promise<string> {
    const entries = Object.entries(data).flat().map(String);
    return this.redis.xadd(stream, '*', ...entries);
  }

  async consume(
    stream: string,
    consumer: string,
    handler: (id: string, data: Record<string, string>) => Promise<void>
  ): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', stream, this.consumerGroup, '0', 'MKSTREAM');
    } catch {} // group may already exist

    while (true) {
      const results = await this.redis.xreadgroup(
        'GROUP', this.consumerGroup, consumer,
        'COUNT', 10, 'BLOCK', 5000,
        'STREAMS', stream, '>'
      );
      if (!results) continue;

      for (const [, messages] of results) {
        for (const [id, fields] of messages) {
          const obj: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
          await handler(id, obj);
          await this.redis.xack(stream, this.consumerGroup, id);
        }
      }
    }
  }
}
```

## Agent Lifecycle

Every agent follows the same lifecycle regardless of tier:

1. **Initialize** — load config, connect to bus/broker, register health endpoint
2. **Receive** — pull or receive a task message from the supervisor
3. **Validate** — check payload schema, verify preconditions (file exists, API key present)
4. **Execute** — perform the core work (call ML model, run FFmpeg, hit GitHub API)
5. **Report** — emit success or failure back through the bus
6. **Cleanup** — release temporary resources (temp files, GPU memory)

```typescript
// src/agents/base-agent.ts
export abstract class BaseAgent<TInput, TOutput> {
  abstract name: string;

  async handle(msg: TaskMessage): Promise<TOutput> {
    console.log(`[${this.name}] Processing task ${msg.id}`);
    const input = this.validate(msg.payload);
    const result = await this.execute(input);
    return result;
  }

  protected abstract validate(payload: Record<string, unknown>): TInput;
  protected abstract execute(input: TInput): Promise<TOutput>;
}
```

## Task Graph Definition

MiniOp defines workflows as directed acyclic graphs (DAGs). The supervisor traverses the graph, dispatching tasks when dependencies complete.

```typescript
// src/workflows/clip-pipeline.ts
export const clipPipeline: TaskGraph = {
  nodes: [
    { id: 'analyze', type: 'analyze', deps: [] },
    { id: 'generate', type: 'clip', deps: ['analyze'] },
    { id: 'enrich', type: 'enrich', deps: ['generate'] },
    { id: 'deploy', type: 'deploy', deps: ['enrich'] },
  ],
};

export interface TaskGraph {
  nodes: Array<{
    id: string;
    type: string;
    deps: string[];
  }>;
}
```

The supervisor resolves which tasks are ready by checking completed dependencies:

```typescript
async dispatchReady(graph: TaskGraph, completed: Set<string>): Promise<void> {
  for (const node of graph.nodes) {
    if (completed.has(node.id)) continue;
    if (node.deps.every(d => completed.has(d))) {
      this.dispatch({
        id: node.id,
        type: node.type as TaskMessage['type'],
        payload: {},
        retryCount: 0,
      });
    }
  }
}
```

## Configuration

Agents read from environment variables with sensible defaults for free tier:

```typescript
// src/config.ts
export const config = {
  mode: (process.env.ORCHESTRATOR_MODE ?? 'local') as 'local' | 'distributed',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  concurrency: parseInt(process.env.CONCURRENCY ?? '1', 10),
  retryLimit: parseInt(process.env.RETRY_LIMIT ?? '3', 10),
  healthPort: parseInt(process.env.HEALTH_PORT ?? '8080', 10),
};
```

Free tier runs with `ORCHESTRATOR_MODE=local` (default). No Redis needed — the in-process `EventEmitter` bus is used automatically. Set `ORCHESTRATOR_MODE=distributed` and provide `REDIS_URL` to switch to production mode.

## Observability

Every agent emits structured logs and OpenTelemetry spans:

```typescript
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('miniop-agents');

async execute(input: TInput): Promise<TOutput> {
  return tracer.startActiveSpan(`${this.name}.execute`, async (span) => {
    try {
      const result = await this.doWork(input);
      span.setStatus({ code: 0 });
      return result;
    } catch (err) {
      span.setStatus({ code: 2, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}
```

In production, export traces to Jaeger or Grafana Tempo. On free tier, use the `ConsoleSpanExporter` for local debugging.

## Agent Performance Metrics

Anthropic's benchmarks establish that agents achieving 80%+ code-writing autonomy, 76%+ task success, and 33%+ bug catch rates are production-ready. MiniOp tracks per-agent metrics against these thresholds to determine which agents can operate autonomously and which need human oversight.

### Agent Success Rate Tracking

Every agent task emits a structured completion event. The metrics pipeline aggregates these into success rates per agent type, measured against the 76% Anthropic task success target.

```typescript
// src/metrics/agent-tracker.ts
interface AgentCompletionEvent {
  agentName: string;
  taskId: string;
  success: boolean;
  requiredHumanOverride: boolean;
  latencyMs: number;
  modelVersion: string;
  timestamp: Date;
}

interface AgentPerformanceSummary {
  agentName: string;
  successRate: number;
  autonomousRate: number;
  p50LatencyMs: number;
  p99LatencyMs: number;
  taskCount: number;
  meetsTarget: boolean;
}

const ANTHROPIC_TARGETS = {
  successRate: 0.76,
  autonomyRate: 0.80,
  bugCatchRate: 0.33,
};

export class AgentPerformanceTracker {
  private events: AgentCompletionEvent[] = [];

  record(event: AgentCompletionEvent): void {
    this.events.push(event);
    this.emitMetric(event);
  }

  summarize(agentName: string, windowDays: number = 7): AgentPerformanceSummary {
    const cutoff = new Date(Date.now() - windowDays * 86400_000);
    const relevant = this.events.filter(
      e => e.agentName === agentName && e.timestamp >= cutoff
    );

    if (relevant.length === 0) {
      return {
        agentName,
        successRate: 0, autonomousRate: 0,
        p50LatencyMs: 0, p99LatencyMs: 0,
        taskCount: 0, meetsTarget: false,
      };
    }

    const successes = relevant.filter(e => e.success).length;
    const autonomous = relevant.filter(e => e.success && !e.requiredHumanOverride).length;
    const latencies = relevant.map(e => e.latencyMs).sort((a, b) => a - b);

    const successRate = successes / relevant.length;
    const autonomousRate = successes > 0 ? autonomous / successes : 0;

    return {
      agentName,
      successRate,
      autonomousRate,
      p50LatencyMs: latencies[Math.floor(latencies.length / 2)],
      p99LatencyMs: latencies[Math.floor(latencies.length * 0.99)],
      taskCount: relevant.length,
      meetsTarget:
        successRate >= ANTHROPIC_TARGETS.successRate &&
        autonomousRate >= ANTHROPIC_TARGETS.autonomyRate,
    };
  }

  private emitMetric(event: AgentCompletionEvent): void {
    // Push to Prometheus / OpenTelemetry
    const meter = otel.metrics.getMeter('miniop-agents');
    const counter = meter.createCounter('agent.tasks.total');
    counter.add(1, {
      agent: event.agentName,
      success: String(event.success),
      human_override: String(event.requiredHumanOverride),
    });
    const latency = meter.createHistogram('agent.task.latency_ms');
    latency.record(event.latencyMs, { agent: event.agentName });
  }
}
```

### Code Quality Tracking Per Agent

Each agent's generated code is tracked for quality — lines accepted unchanged by human reviewers contribute to the 80% code-writing autonomy target from Anthropic's SWE-bench benchmarks.

```typescript
// src/metrics/code-quality.ts
interface CodeQualityEvent {
  agentName: string;
  prNumber: number;
  filesGenerated: number;
  linesGenerated: number;
  linesAccepted: number;
  linesModified: number;
  linesRejected: number;
}

export function computeAgentCodeQuality(events: CodeQualityEvent[]): Map<string, number> {
  const byAgent = new Map<string, CodeQualityEvent[]>();
  for (const e of events) {
    const list = byAgent.get(e.agentName) ?? [];
    list.push(e);
    byAgent.set(e.agentName, list);
  }

  const rates = new Map<string, number>();
  for (const [agent, agentEvents] of byAgent) {
    const totalLines = agentEvents.reduce((s, e) => s + e.linesGenerated, 0);
    const acceptedLines = agentEvents.reduce((s, e) => s + e.linesAccepted, 0);
    rates.set(agent, totalLines > 0 ? acceptedLines / totalLines : 0);
  }
  return rates;
}
```

### Autonomy Level Classification

Agents are classified into autonomy levels based on their benchmark performance. Agents below Anthropic targets operate in assisted mode with mandatory human review.

```typescript
// src/metrics/autonomy-classifier.ts
type AutonomyLevel = 'autonomous' | 'assisted' | 'supervised';

export function classifyAutonomy(summary: AgentPerformanceSummary): AutonomyLevel {
  if (
    summary.successRate >= 0.76 &&
    summary.autonomousRate >= 0.80 &&
    summary.taskCount >= 50
  ) {
    return 'autonomous';
  }
  if (summary.successRate >= 0.60 && summary.taskCount >= 20) {
    return 'assisted';
  }
  return 'supervised';
}

export function getAutonomyConfig(level: AutonomyLevel) {
  const configs = {
    autonomous: {
      requireHumanReview: false,
      autoMerge: true,
      maxConcurrentTasks: 10,
      retryLimit: 3,
    },
    assisted: {
      requireHumanReview: true,
      autoMerge: false,
      maxConcurrentTasks: 5,
      retryLimit: 2,
    },
    supervised: {
      requireHumanReview: true,
      autoMerge: false,
      maxConcurrentTasks: 2,
      retryLimit: 1,
    },
  };
  return configs[level];
}
```
