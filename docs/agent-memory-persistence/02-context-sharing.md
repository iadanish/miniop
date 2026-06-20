# Agent Context Sharing for MiniOp

## Purpose

Multiple agents collaborate on MiniOp's video processing pipeline — a video analyzer identifies key moments, a clip generator creates segments, a transcription agent adds subtitles, and an export agent renders final output. These agents need to share context: analysis results, transcription data, clip boundaries, and rendering parameters. Context sharing must be efficient, versioned, and avoid tight coupling between agents.

This document defines the context sharing patterns, message formats, and implementation for both free-tier and production deployments.

## Context Sharing Patterns

| Pattern | Coupling | Latency | Use Case |
|---------|---------|---------|----------|
| Shared Database | Medium | Low | Durable context that persists across restarts |
| Message Passing | Low | Medium | Event-driven notifications between agents |
| Shared Memory (Redis) | High | Very Low | Hot context accessed by multiple agents simultaneously |
| Context Store | Low | Low | Versioned, queryable context objects |
| Publish-Subscribe | Very Low | Medium | Broadcasting state changes to interested agents |

## Context Store Implementation

The primary context sharing mechanism is a versioned context store. Each video processing job has a context object that agents read from and write to.

```typescript
// src/agents/context/context-store.ts
import Redis from 'ioredis';

export interface VideoContext {
  videoId: string;
  projectId: string;
  version: number;
  createdAt: string;
  updatedAt: string;

  // Set by video analyzer
  analysis?: {
    scenes: Array<{ start: number; end: number; label: string; confidence: number }>;
    speakers: Array<{ id: string; segments: Array<{ start: number; end: number }> }>;
    topics: Array<{ keyword: string; timestamps: number[] }>;
    sentiment: Array<{ start: number; end: number; score: number }>;
    highlights: Array<{ start: number; end: number; reason: string; score: number }>;
  };

  // Set by transcription agent
  transcription?: {
    language: string;
    segments: Array<{
      start: number;
      end: number;
      text: string;
      words: Array<{ word: string; start: number; end: number; confidence: number }>;
    }>;
    fullText: string;
  };

  // Set by clip generator
  clips?: Array<{
    clipId: string;
    start: number;
    end: number;
    title: string;
    score: number;
    suggestedBy: 'ai' | 'user';
    tags: string[];
  }>;

  // Set by export agent
  exports?: Array<{
    exportId: string;
    clipId: string;
    format: string;
    resolution: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    outputPath?: string;
  }>;

  // Agent-specific context (extensible)
  agentContext: Record<string, unknown>;
}

export class ContextStore {
  private redis: Redis;
  private db: Pool;

  constructor(redis: Redis, db: Pool) {
    this.redis = redis;
    this.db = db;
  }

  async get(videoId: string): Promise<VideoContext | null> {
    // Try Redis first (hot path)
    const cached = await this.redis.get(`context:${videoId}`);
    if (cached) {
      return JSON.parse(cached);
    }

    // Fall back to PostgreSQL
    const result = await this.db.query(
      'SELECT context_data FROM video_contexts WHERE video_id = $1',
      [videoId]
    );

    if (result.rows.length === 0) return null;

    const context = result.rows[0].context_data as VideoContext;
    // Cache in Redis
    await this.redis.setex(`context:${videoId}`, 3600, JSON.stringify(context));
    return context;
  }

  async update(
    videoId: string,
    agentId: string,
    updates: Partial<VideoContext>,
    expectedVersion: number
  ): Promise<{ success: boolean; context?: VideoContext; conflict?: boolean }> {
    // Optimistic locking with version check
    const current = await this.get(videoId);
    if (!current) throw new Error(`Context not found for video ${videoId}`);

    if (current.version !== expectedVersion) {
      return { success: false, conflict: true };
    }

    const merged = this.deepMerge(current, updates);
    merged.version = current.version + 1;
    merged.updatedAt = new Date().toISOString();

    // Write to PostgreSQL (source of truth)
    await this.db.query(
      `UPDATE video_contexts SET context_data = $1, version = $2, updated_at = NOW()
       WHERE video_id = $3 AND version = $4`,
      [JSON.stringify(merged), merged.version, videoId, expectedVersion]
    );

    // Update Redis cache
    await this.redis.setex(`context:${videoId}`, 3600, JSON.stringify(merged));

    // Notify subscribers
    await this.redis.publish(`context:updates:${videoId}`, JSON.stringify({
      videoId,
      agentId,
      version: merged.version,
      updatedFields: Object.keys(updates),
      timestamp: merged.updatedAt,
    }));

    return { success: true, context: merged };
  }

  private deepMerge(target: any, source: any): any {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(result[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }
}
```

## Message Passing Between Agents

For loose coupling, agents communicate via messages through Redis pub/sub.

```typescript
// src/agents/context/message-bus.ts
import Redis from 'ioredis';

export interface AgentMessage {
  id: string;
  type: string;
  sourceAgent: string;
  targetAgent?: string;  // Omit for broadcast
  payload: unknown;
  timestamp: string;
  correlationId?: string;
}

export class MessageBus {
  private publisher: Redis;
  private subscriber: Redis;
  private handlers = new Map<string, Set<(msg: AgentMessage) => void>>();

  constructor(redisUrl: string) {
    this.publisher = new Redis(redisUrl);
    this.subscriber = new Redis(redisUrl);

    this.subscriber.on('message', (channel, message) => {
      const msg = JSON.parse(message) as AgentMessage;
      const channelHandlers = this.handlers.get(channel);
      channelHandlers?.forEach(handler => handler(msg));
    });
  }

  async publish(message: AgentMessage): Promise<void> {
    const channel = message.targetAgent
      ? `agent:${message.targetAgent}`
      : `agent:broadcast:${message.type}`;

    await this.publisher.publish(channel, JSON.stringify(message));
  }

  subscribe(pattern: string, handler: (msg: AgentMessage) => void): () => void {
    if (!this.handlers.has(pattern)) {
      this.handlers.set(pattern, new Set());
      this.subscriber.subscribe(pattern);
    }
    this.handlers.get(pattern)!.add(handler);

    return () => {
      this.handlers.get(pattern)?.delete(handler);
      if (this.handlers.get(pattern)?.size === 0) {
        this.subscriber.unsubscribe(pattern);
        this.handlers.delete(pattern);
      }
    };
  }

  async request(
    targetAgent: string,
    type: string,
    payload: unknown,
    timeoutMs: number = 10000
  ): Promise<AgentMessage> {
    return new Promise((resolve, reject) => {
      const correlationId = uuidv7();
      const replyChannel = `agent:reply:${correlationId}`;

      const timeout = setTimeout(() => {
        this.subscriber.unsubscribe(replyChannel);
        reject(new Error(`Request timeout: ${type} to ${targetAgent}`));
      }, timeoutMs);

      this.subscriber.subscribe(replyChannel);
      this.subscriber.once('message', (channel, message) => {
        clearTimeout(timeout);
        this.subscriber.unsubscribe(replyChannel);
        resolve(JSON.parse(message));
      });

      this.publish({
        id: uuidv7(),
        type,
        sourceAgent: 'requester',
        targetAgent,
        payload: { ...payload, replyTo: replyChannel },
        timestamp: new Date().toISOString(),
        correlationId,
      });
    });
  }
}
```

### Agent-Specific Message Handlers

```typescript
// src/agents/clip-generator.ts
import { MessageBus, AgentMessage } from './context/message-bus';
import { ContextStore } from './context/context-store';

export class ClipGeneratorAgent {
  private bus: MessageBus;
  private contextStore: ContextStore;

  constructor(bus: MessageBus, contextStore: ContextStore) {
    this.bus = bus;
    this.contextStore = contextStore;
  }

  async start(): Promise<void> {
    // Listen for analysis completion
    this.bus.subscribe('agent:broadcast:analysis.completed', this.onAnalysisCompleted.bind(this));

    // Listen for direct requests
    this.bus.subscribe('agent:clip-generator', this.onDirectMessage.bind(this));
  }

  private async onAnalysisCompleted(msg: AgentMessage): Promise<void> {
    const { videoId } = msg.payload as { videoId: string };

    // Load full context
    const context = await this.contextStore.get(videoId);
    if (!context || !context.analysis) return;

    // Generate clips based on analysis
    const clips = await this.generateClips(context);

    // Update context with generated clips
    await this.contextStore.update(videoId, 'clip-generator', {
      clips,
    }, context.version);

    // Notify downstream agents
    await this.bus.publish({
      id: uuidv7(),
      type: 'clips.generated',
      sourceAgent: 'clip-generator',
      payload: { videoId, clipCount: clips.length },
      timestamp: new Date().toISOString(),
    });
  }

  private async onDirectMessage(msg: AgentMessage): Promise<void> {
    switch (msg.type) {
      case 'regenerate_clips':
        // Handle regeneration request
        break;
      case 'update_clip_boundaries':
        // Handle user edits
        break;
    }
  }

  private async generateClips(context: VideoContext): Promise<VideoContext['clips']> {
    const clips: NonNullable<VideoContext['clips']> = [];

    for (const highlight of context.analysis!.highlights) {
      // Find overlapping transcription
      const transcription = this.findOverlappingTranscription(
        context.transcription!,
        highlight.start,
        highlight.end
      );

      clips.push({
        clipId: `clip_${uuidv7()}`,
        start: highlight.start,
        end: highlight.end,
        title: transcription?.text.substring(0, 100) || `Clip at ${highlight.start}s`,
        score: highlight.score,
        suggestedBy: 'ai',
        tags: this.extractTags(context.analysis!, highlight),
      });
    }

    return clips.sort((a, b) => b.score - a.score);
  }
}
```

## Publish-Subscribe for State Broadcasting

Agents subscribe to state changes they care about without knowing who produces them.

```typescript
// src/agents/context/pubsub.ts
export class ContextPubSub {
  private redis: Redis;
  private subscriptions = new Map<string, Set<(event: ContextEvent) => void>>();

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async publish(event: ContextEvent): Promise<void> {
    const channel = `context:${event.videoId}:${event.field}`;
    await this.redis.publish(channel, JSON.stringify(event));

    // Also publish to wildcard channel
    await this.redis.publish(`context:${event.videoId}:*`, JSON.stringify(event));
  }

  subscribe(videoId: string, field: string | '*', handler: (event: ContextEvent) => void): () => void {
    const channel = `context:${videoId}:${field}`;

    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
      this.redis.subscribe(channel);
    }
    this.subscriptions.get(channel)!.add(handler);

    return () => {
      this.subscriptions.get(channel)?.delete(handler);
    };
  }
}

interface ContextEvent {
  videoId: string;
  field: string;
  agentId: string;
  oldValue: unknown;
  newValue: unknown;
  version: number;
  timestamp: string;
}
```

## Free Tier: In-Process Context Sharing

On the free tier, agents run in the same process. Context sharing uses an EventEmitter with in-memory storage.

```typescript
// src/agents/context/local-context-store.ts
import { EventEmitter } from 'events';

export class LocalContextStore extends EventEmitter {
  private contexts = new Map<string, VideoContext>();

  async get(videoId: string): Promise<VideoContext | null> {
    return this.contexts.get(videoId) || null;
  }

  async set(videoId: string, context: VideoContext): Promise<void> {
    const old = this.contexts.get(videoId);
    this.contexts.set(videoId, context);

    // Emit change events for each field that changed
    if (old) {
      for (const key of Object.keys(context)) {
        if (JSON.stringify((old as any)[key]) !== JSON.stringify((context as any)[key])) {
          this.emit('context:changed', {
            videoId,
            field: key,
            oldValue: (old as any)[key],
            newValue: (context as any)[key],
            version: context.version,
          });
        }
      }
    }
  }

  async update(
    videoId: string,
    agentId: string,
    updates: Partial<VideoContext>
  ): Promise<{ success: boolean; context?: VideoContext }> {
    const current = this.contexts.get(videoId);
    if (!current) return { success: false };

    const merged = { ...current, ...updates, version: current.version + 1, updatedAt: new Date().toISOString() };
    await this.set(videoId, merged);
    return { success: true, context: merged };
  }

  subscribe(videoId: string, handler: (event: any) => void): () => void {
    const listener = (event: any) => {
      if (event.videoId === videoId) handler(event);
    };
    this.on('context:changed', listener);
    return () => this.off('context:changed', listener);
  }
}
```

## Context Serialization for Cross-Agent Transfer

When context needs to be sent between agents (e.g., via message passing), use a compact serialization format.

```typescript
// src/agents/context/serialization.ts
export interface SerializedContext {
  v: number;           // version
  vid: string;         // videoId
  ts: string;          // timestamp
  data: string;        // Base64-encoded msgpack
}

export function serializeContext(context: VideoContext): SerializedContext {
  // Use msgpack for compact binary serialization
  const packed = msgpack.encode(context);
  return {
    v: context.version,
    vid: context.videoId,
    ts: new Date().toISOString(),
    data: packed.toString('base64'),
  };
}

export function deserializeContext(serialized: SerializedContext): VideoContext {
  const packed = Buffer.from(serialized.data, 'base64');
  return msgpack.decode(packed) as VideoContext;
}

// For Redis: store as hash with field-level granularity
export async function storeContextHash(redis: Redis, context: VideoContext): Promise<void> {
  const key = `context:hash:${context.videoId}`;

  const pipeline = redis.pipeline();
  pipeline.hset(key, 'version', context.version.toString());
  pipeline.hset(key, 'videoId', context.videoId);
  pipeline.hset(key, 'updatedAt', context.updatedAt);

  if (context.analysis) {
    pipeline.hset(key, 'analysis', JSON.stringify(context.analysis));
  }
  if (context.transcription) {
    pipeline.hset(key, 'transcription', JSON.stringify(context.transcription));
  }
  if (context.clips) {
    pipeline.hset(key, 'clips', JSON.stringify(context.clips));
  }

  pipeline.expire(key, 86400);
  await pipeline.exec();
}

export async function getContextField<T>(redis: Redis, videoId: string, field: string): Promise<T | null> {
  const value = await redis.hget(`context:hash:${videoId}`, field);
  return value ? JSON.parse(value) : null;
}
```

## Context Versioning and Conflict Resolution

When multiple agents update the context concurrently, version-based conflict resolution ensures consistency.

```typescript
// src/agents/context/versioned-update.ts
export class VersionedContextUpdater {
  private contextStore: ContextStore;
  private maxRetries: number;

  constructor(contextStore: ContextStore, maxRetries: number = 3) {
    this.contextStore = contextStore;
    this.maxRetries = maxRetries;
  }

  async updateWithMerge(
    videoId: string,
    agentId: string,
    fieldUpdates: Partial<VideoContext>,
    mergeStrategy: 'ours' | 'theirs' | 'smart' = 'smart'
  ): Promise<VideoContext> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const current = await this.contextStore.get(videoId);
      if (!current) throw new Error(`Context not found: ${videoId}`);

      // Determine what we're changing
      const updates: Partial<VideoContext> = {};
      for (const [key, value] of Object.entries(fieldUpdates)) {
        if (key === 'analysis' || key === 'transcription' || key === 'clips') {
          // Structured field — use smart merge
          updates[key] = this.smartMerge(current[key], value, mergeStrategy);
        } else {
          updates[key] = value;
        }
      }

      const result = await this.contextStore.update(videoId, agentId, updates, current.version);
      if (result.success) return result.context!;

      // Version conflict — retry
      await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
    }

    throw new Error(`Failed to update context after ${this.maxRetries} retries`);
  }

  private smartMerge(existing: any, incoming: any, strategy: string): any {
    if (!existing) return incoming;
    if (!incoming) return existing;

    if (Array.isArray(existing) && Array.isArray(incoming)) {
      // Merge arrays by ID, preferring incoming values
      const merged = new Map<string, any>();
      for (const item of existing) {
        merged.set(item.clipId || item.id || JSON.stringify(item), item);
      }
      for (const item of incoming) {
        merged.set(item.clipId || item.id || JSON.stringify(item), item);
      }
      return Array.from(merged.values());
    }

    if (typeof existing === 'object' && typeof incoming === 'object') {
      return { ...existing, ...incoming };
    }

    return strategy === 'theirs' ? incoming : existing;
  }
}
```

## Context Caching Strategy

```typescript
// src/agents/context/cache.ts
export class ContextCache {
  private redis: Redis;
  private localCache: Map<string, { data: VideoContext; loadedAt: number }> = new Map();
  private localTtlMs: number;

  constructor(redis: Redis, localTtlMs: number = 30000) {
    this.redis = redis;
    this.localTtlMs = localTtlMs;
  }

  async get(videoId: string): Promise<VideoContext | null> {
    // L1: Local memory
    const local = this.localCache.get(videoId);
    if (local && Date.now() - local.loadedAt < this.localTtlMs) {
      return local.data;
    }

    // L2: Redis
    const redisData = await this.redis.get(`context:${videoId}`);
    if (redisData) {
      const context = JSON.parse(redisData);
      this.localCache.set(videoId, { data: context, loadedAt: Date.now() });
      return context;
    }

    return null;
  }

  invalidate(videoId: string): void {
    this.localCache.delete(videoId);
  }
}
```

## Summary

Context sharing in MiniOp uses a layered approach. The Context Store provides versioned, durable context objects stored in PostgreSQL with Redis caching. Message passing via Redis pub/sub enables loose coupling between agents. Publish-subscribe allows agents to react to state changes without direct dependencies. The free tier uses in-process EventEmitter for sharing. All context updates use optimistic locking with version numbers to handle concurrent modifications. Smart merge strategies resolve conflicts when multiple agents update the same context fields.
