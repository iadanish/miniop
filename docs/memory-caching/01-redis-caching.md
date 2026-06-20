# Redis Caching Strategy for MiniOp

MiniOp processes video clips, generates transcripts, and serves metadata-heavy API responses. Without caching, every clip list, project detail, and AI-generated highlight query hits PostgreSQL directly. Redis eliminates redundant database reads, stores ephemeral processing state, and provides the backbone for rate limiting and session management.

## Free Tier: Single Redis Instance with Upstash

For development and small-scale deployments (under 1,000 daily active users), use Upstash Redis. It offers a generous free tier with 10,000 commands per day, persistent storage, and global replication — no infrastructure management required.

### Setup

```bash
npm install ioredis
```

Create `lib/redis.ts`:

```typescript
import Redis from "ioredis";

const redis = new Redis(process.env.UPSTASH_REDIS_URL!, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    return Math.min(times * 200, 2000);
  },
  enableReadyCheck: true,
  lazyConnect: true,
});

export default redis;
```

Set the environment variable in `.env.local`:

```
UPSTASH_REDIS_URL=redis://default:xxxx@your-instance.upstash.io:6379
```

### Core Caching Patterns

**Cache-aside for project metadata:**

```typescript
const PROJECT_CACHE_TTL = 300; // 5 minutes

export async function getProject(projectId: string) {
  const cacheKey = `project:${projectId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { clips: true, settings: true },
  });

  if (project) {
    await redis.setex(cacheKey, PROJECT_CACHE_TTL, JSON.stringify(project));
  }
  return project;
}

export async function invalidateProject(projectId: string) {
  await redis.del(`project:${projectId}`);
}
```

**Caching clip lists with cursor pagination:**

```typescript
export async function getUserClips(userId: string, cursor?: string, limit = 20) {
  const cacheKey = `clips:${userId}:${cursor || "first"}:${limit}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const clips = await db.clip.findMany({
    where: { userId },
    take: limit + 1,
    cursor: cursor ? { id: cursor } : undefined,
    orderBy: { createdAt: "desc" },
  });

  const hasMore = clips.length > limit;
  const items = hasMore ? clips.slice(0, limit) : clips;
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  const result = { items, nextCursor };
  await redis.setex(cacheKey, 120, JSON.stringify(result)); // 2 min TTL
  return result;
}
```

### Rate Limiting with Sliding Window

```typescript
export async function checkRateLimit(
  identifier: string,
  maxRequests: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number }> {
  const key = `ratelimit:${identifier}`;
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;

  const pipe = redis.pipeline();
  pipe.zremrangebyscore(key, 0, windowStart);
  pipe.zadd(key, now, `${now}`);
  pipe.zcard(key);
  pipe.expire(key, windowSeconds);
  const results = await pipe.exec();

  const count = results![2][1] as number;
  return {
    allowed: count <= maxRequests,
    remaining: Math.max(0, maxRequests - count),
  };
}
```

### Processing Job State

Store ephemeral video processing state in Redis instead of polluting the database:

```typescript
export async function setJobState(jobId: string, state: ProcessingJob) {
  await redis.setex(
    `job:${jobId}`,
    3600, // 1 hour — jobs finish or expire
    JSON.stringify(state)
  );
}

export async function getJobState(jobId: string): Promise<ProcessingJob | null> {
  const data = await redis.get(`job:${jobId}`);
  return data ? JSON.parse(data) : null;
}
```

## Scaled Production: Redis Cluster with Sentinel

At scale (10,000+ concurrent users), a single Redis instance becomes a bottleneck and a single point of failure. Deploy Redis Sentinel for automatic failover or Redis Cluster for horizontal sharding.

### Infrastructure Setup with Docker Compose

```yaml
# docker-compose.redis.yml
version: "3.8"
services:
  redis-primary:
    image: redis:7-alpine
    command: redis-server --appendonly yes --maxmemory 2gb --maxmemory-policy allkeys-lru
    volumes:
      - redis-primary-data:/data
    ports:
      - "6379:6379"

  redis-replica-1:
    image: redis:7-alpine
    command: redis-server --replicaof redis-primary 6379 --appendonly yes
    depends_on:
      - redis-primary

  redis-replica-2:
    image: redis:7-alpine
    command: redis-server --replicaof redis-primary 6379 --appendonly yes
    depends_on:
      - redis-primary

  sentinel-1:
    image: redis:7-alpine
    command: redis-sentinel /etc/redis/sentinel.conf
    volumes:
      - ./config/sentinel.conf:/etc/redis/sentinel.conf
    depends_on:
      - redis-primary

volumes:
  redis-primary-data:
```

Sentinel configuration (`config/sentinel.conf`):

```
port 26379
sentinel monitor miniop-primary redis-primary 6379 2
sentinel down-after-milliseconds miniop-primary 5000
sentinel failover-timeout miniop-primary 10000
sentinel parallel-syncs miniop-primary 1
```

### Production Redis Client with Sentinel Support

```typescript
import Redis from "ioredis";

const sentinels = [
  { host: process.env.REDIS_SENTINEL_1!, port: 26379 },
  { host: process.env.REDIS_SENTINEL_2!, port: 26379 },
  { host: process.env.REDIS_SENTINEL_3!, port: 26379 },
];

export const redis = new Redis({
  sentinels,
  name: "miniop-primary",
  role: "master",
  sentinelRetryStrategy: (times) => Math.min(times * 300, 3000),
  maxRetriesPerRequest: 3,
  enableOfflineQueue: true,
});

export const redisReadonly = new Redis({
  sentinels,
  name: "miniop-primary",
  role: "slave",
  preferredSlaves: [
    { ip: process.env.REDIS_REPLICA_1!, port: "6379", prio: 1 },
    { ip: process.env.REDIS_REPLICA_2!, port: "6379", prio: 2 },
  ],
});
```

### Read/Write Splitting

Route read-heavy cache lookups to replicas and writes to the primary:

```typescript
export async function getCachedClip(clipId: string) {
  const cached = await redisReadonly.get(`clip:${clipId}`);
  return cached ? JSON.parse(cached) : null;
}

export async function setCachedClip(clipId: string, data: ClipData, ttl = 300) {
  await redis.setex(`clip:${clipId}`, ttl, JSON.stringify(data));
}
```

### Cache Warming Strategy

After deployments or cache flushes, proactively warm the most-accessed data:

```typescript
export async function warmCache() {
  const recentProjects = await db.project.findMany({
    where: { updatedAt: { gte: new Date(Date.now() - 86400000) } },
    include: { clips: { take: 50, orderBy: { createdAt: "desc" } } },
    take: 200,
  });

  const pipe = redis.pipeline();
  for (const project of recentProjects) {
    pipe.setex(
      `project:${project.id}`,
      600,
      JSON.stringify(project)
    );
    for (const clip of project.clips) {
      pipe.setex(`clip:${clip.id}`, 600, JSON.stringify(clip));
    }
  }
  await pipe.exec();
  console.log(`Warmed ${recentProjects.length} projects`);
}
```

### Monitoring

Track hit rates, memory usage, and latency with Redis INFO and Prometheus:

```bash
redis-cli INFO stats | grep -E "keyspace_hits|keyspace_misses"
redis-cli INFO memory | grep used_memory_human
redis-cli --latency-history -i 5
```

Key metrics to alert on:
- **Hit rate below 80%**: Review TTLs and cache key patterns
- **Memory usage above 75% of maxmemory**: Scale up or increase eviction pressure
- **Replication lag above 1 second**: Check network and replica health
- **Connected clients above 500**: Review connection pooling configuration

A properly configured Redis layer reduces MiniOp's average API response time from 120ms (database hits) to under 5ms (cache hits) for metadata endpoints, and provides the distributed state infrastructure needed for real-time processing job tracking.
