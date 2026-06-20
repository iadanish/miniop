# Integration Testing Strategy

## Overview

Integration testing verifies that MiniOp's modules work correctly when connected: API routes handle requests through to the database, video processing pipelines chain together, and external service integrations behave as expected. These tests catch the failures that unit tests cannot — schema mismatches, authentication middleware gaps, incorrect query results, and contract violations between services.

## Tooling

Integration tests use **Vitest** with real (or containerized) dependencies. For database tests, MiniOp uses **Testcontainers** to spin up ephemeral PostgreSQL instances. For API route testing, **Supertest** exercises HTTP endpoints against the actual Express/Fastify server.

```bash
pnpm add -D @testcontainers/postgresql supertest @types/supertest
```

### Vitest Integration Configuration

```ts
// vitest.integration.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    setupFiles: ['./tests/integration/setup.ts'],
  },
});
```

### Testcontainers Setup

```ts
// tests/integration/setup.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from '../../src/db/schema';

let container: StartedPostgreSqlContainer;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('minio_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const client = postgres(container.getConnectionUri());
  db = drizzle(client, { schema });

  await migrate(db, { migrationsFolder: './drizzle' });

  globalThis.__TEST_DB__ = db;
  globalThis.__TEST_CONTAINER__ = container;
}, 60_000);

afterAll(async () => {
  await container?.stop();
});
```

## What to Integration Test

### API Route Handlers

Every API route must be tested with a real HTTP request through the full middleware stack:

```ts
// src/api/routes/clips.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app';
import type { Express } from 'express';
import { seedTestData } from '../../../tests/integration/seeds';

describe('POST /api/videos/:id/analyze', () => {
  let app: Express;
  let authToken: string;
  let videoId: string;

  beforeAll(async () => {
    const db = globalThis.__TEST_DB__;
    app = await createApp(db);
    const seed = await seedTestData(db);
    authToken = seed.authToken;
    videoId = seed.videoId;
  });

  it('triggers analysis and returns 202 with job id', async () => {
    const res = await request(app)
      .post(`/api/videos/${videoId}/analyze`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ model: 'default', maxClips: 5 })
      .expect(202);

    expect(res.body.jobId).toMatch(/^job_/);
    expect(res.body.status).toBe('queued');
  });

  it('returns 401 without auth token', async () => {
    await request(app)
      .post(`/api/videos/${videoId}/analyze`)
      .send({ model: 'default' })
      .expect(401);
  });

  it('returns 404 for nonexistent video', async () => {
    await request(app)
      .post('/api/videos/vid_nonexistent/analyze')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ model: 'default' })
      .expect(404);
  });

  it('returns 429 when rate limit exceeded', async () => {
    const requests = Array.from({ length: 11 }, () =>
      request(app)
        .post(`/api/videos/${videoId}/analyze`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ model: 'default' })
    );

    const results = await Promise.all(requests);
    const rateLimited = results.filter((r) => r.status === 429);
    expect(rateLimited.length).toBeGreaterThan(0);
  });
});
```

### Database Layer

Test real queries against a real database. Verify migrations, constraints, and query behavior:

```ts
// src/repositories/clipRepository.integration.test.ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createClipRepository } from './clipRepository';
import { videos, clips } from '../db/schema';
import { eq } from 'drizzle-orm';

describe('clipRepository (integration)', () => {
  let db: ReturnType<typeof drizzle>;
  let repo: ReturnType<typeof createClipRepository>;

  beforeAll(() => {
    db = globalThis.__TEST_DB__;
    repo = createClipRepository(db);
  });

  beforeEach(async () => {
    await db.delete(clips);
    await db.delete(videos);
  });

  it('persists clip to database and retrieves it', async () => {
    await db.insert(videos).values({
      id: 'vid_test',
      userId: 'user_1',
      originalUrl: 'https://example.com/video.mp4',
      duration: 300,
      status: 'processed',
    });

    const created = await repo.create({
      videoId: 'vid_test',
      startTime: 30,
      endTime: 75,
      score: 0.88,
      title: 'Highlight moment',
    });

    const found = await repo.findById(created.id);
    expect(found).toBeDefined();
    expect(found!.videoId).toBe('vid_test');
    expect(found!.score).toBe(0.88);
  });

  it('enforces foreign key constraint on video deletion', async () => {
    await db.insert(videos).values({
      id: 'vid_fk_test',
      userId: 'user_1',
      originalUrl: 'https://example.com/video.mp4',
      duration: 300,
      status: 'processed',
    });

    await repo.create({ videoId: 'vid_fk_test', startTime: 0, endTime: 30, score: 0.5 });

    await expect(
      db.delete(videos).where(eq(videos.id, 'vid_fk_test'))
    ).rejects.toThrow(/foreign key/i);
  });

  it('returns clips sorted by score descending by default', async () => {
    await db.insert(videos).values({
      id: 'vid_sort',
      userId: 'user_1',
      originalUrl: 'https://example.com/video.mp4',
      duration: 600,
      status: 'processed',
    });

    await repo.create({ videoId: 'vid_sort', startTime: 0, endTime: 30, score: 0.3 });
    await repo.create({ videoId: 'vid_sort', startTime: 60, endTime: 90, score: 0.9 });
    await repo.create({ videoId: 'vid_sort', startTime: 120, endTime: 150, score: 0.6 });

    const clips = await repo.findByVideoId('vid_sort');
    expect(clips.map((c) => c.score)).toEqual([0.9, 0.6, 0.3]);
  });
});
```

### Video Processing Pipeline

Integration tests for the processing pipeline verify that stages hand off data correctly:

```ts
// src/modules/processing/pipeline.integration.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { createPipeline } from './pipeline';
import { createMockTranscriptionService } from '../../../tests/mocks/transcription';
import { createMockStorageService } from '../../../tests/mocks/storage';
import path from 'path';

describe('video processing pipeline (integration)', () => {
  let pipeline: ReturnType<typeof createPipeline>;
  const testVideoPath = path.resolve(__dirname, '../../../tests/fixtures/sample.mp4');

  beforeAll(() => {
    const db = globalThis.__TEST_DB__;
    const transcription = createMockTranscriptionService();
    const storage = createMockStorageService();

    pipeline = createPipeline({ db, transcription, storage });
  });

  it('processes video through all stages and produces clips', async () => {
    const result = await pipeline.process({
      videoPath: testVideoPath,
      userId: 'user_test',
      options: { maxClips: 3, minClipDuration: 15, maxClipDuration: 60 },
    });

    expect(result.clips).toHaveLength(3);
    expect(result.clips[0]).toHaveProperty('startTime');
    expect(result.clips[0]).toHaveProperty('endTime');
    expect(result.clips[0]).toHaveProperty('score');
    expect(result.clips[0].score).toBeGreaterThan(result.clips[2].score);
    expect(result.metadata.duration).toBeGreaterThan(0);
    expect(result.metadata.resolution).toBeDefined();
  });

  it('handles video with no speech gracefully', async () => {
    const result = await pipeline.process({
      videoPath: testVideoPath,
      userId: 'user_test',
      options: { maxClips: 5, minClipDuration: 10 },
    });

    expect(result.clips.length).toBeGreaterThanOrEqual(0);
    expect(result.warnings).toContain('low_speech_confidence');
  });

  it('cleans up temporary files after processing', async () => {
    const result = await pipeline.process({
      videoPath: testVideoPath,
      userId: 'user_test',
      options: { maxClips: 1 },
    });

    const fs = await import('fs/promises');
    for (const tempPath of result.tempFiles) {
      await expect(fs.access(tempPath)).rejects.toThrow();
    }
  });
});
```

### External Service Integration

Test real integrations with external APIs using contract tests and sandboxed environments:

```ts
// src/modules/transcription/whisper.integration.test.ts
import { describe, it, expect } from 'vitest';
import { createWhisperClient } from './whisperClient';
import path from 'path';

describe('Whisper API integration', () => {
  const client = createWhisperClient({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'whisper-1',
  });

  it('transcribes audio file and returns segments', async () => {
    const audioPath = path.resolve(__dirname, '../../../tests/fixtures/audio_sample.mp3');
    const result = await client.transcribe(audioPath);

    expect(result.text).toBeTruthy();
    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.segments[0]).toHaveProperty('start');
    expect(result.segments[0]).toHaveProperty('end');
    expect(result.segments[0]).toHaveProperty('text');
    expect(result.language).toBe('en');
  }, 30_000);

  it('returns error for unsupported file format', async () => {
    await expect(
      client.transcribe('/nonexistent/file.xyz')
    ).rejects.toThrow(/unsupported format|not found/i);
  });
});
```

## Test Data Management

### Seeding Strategy

Use factory functions for test data, not raw SQL dumps:

```ts
// tests/integration/seeds.ts
import { eq } from 'drizzle-orm';
import { users, videos, clips } from '../../src/db/schema';
import { generateAuthToken } from '../../src/modules/auth/tokens';

export async function seedTestData(db: any) {
  const userId = 'user_test_001';
  const videoId = 'vid_test_001';

  await db.insert(users).values({
    id: userId,
    email: 'test@minio.dev',
    tier: 'pro',
    credits: 100,
  });

  await db.insert(videos).values({
    id: videoId,
    userId,
    originalUrl: 'https://storage.minio.dev/test/sample.mp4',
    duration: 300,
    status: 'uploaded',
    filename: 'sample.mp4',
  });

  const authToken = await generateAuthToken({ userId, tier: 'pro' });

  return { userId, videoId, authToken };
}
```

### Cleanup Between Tests

Each test file is responsible for its own cleanup. Use `beforeEach` to truncate tables and `afterAll` to stop containers:

```ts
beforeEach(async () => {
  const db = globalThis.__TEST_DB__;
  await db.delete(clips);
  await db.delete(videos);
  await db.delete(users);
});
```

## Free Tier vs. Production

| Aspect | Free Tier (Local) | Production (CI) |
|--------|-------------------|-----------------|
| Database | Local PostgreSQL or Docker | Testcontainers (ephemeral) |
| External APIs | Mocked responses | Sandbox/staging endpoints |
| Test timeout | 30s default | 60s (CI is slower) |
| Parallelism | Sequential | Sequential (shared DB state) |
| Artifacts | Console output | JUnit XML + screenshots |

### CI Pipeline

```yaml
# .github/workflows/integration-tests.yml
name: Integration Tests
on: [pull_request]

jobs:
  integration:
    runs-on: ubuntu-latest
    services:
      redis:
        image: redis:7-alpine
        ports: ['6379:6379']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm vitest run --config vitest.integration.config.ts --reporter=junit
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY_SANDBOX }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: integration-results
          path: test-results/
```

## Running Integration Tests

```bash
# All integration tests
pnpm vitest run --config vitest.integration.config.ts

# Single file
pnpm vitest run src/api/routes/clips.integration.test.ts --config vitest.integration.config.ts

# With Docker (if not using Testcontainers)
docker compose -f docker-compose.test.yml up -d
pnpm vitest run --config vitest.integration.config.ts
docker compose -f docker-compose.test.yml down -v
```

## Environment Variables

```env
# .env.test
DATABASE_URL=postgresql://test:test@localhost:5433/minio_test
REDIS_URL=redis://localhost:6379/1
OPENAI_API_KEY=sk-test-sandbox-key
STORAGE_BUCKET=minio-test
STORAGE_ENDPOINT=http://localhost:9000
```

Integration tests are slower than unit tests (target: under 2 minutes for the full suite). They run on every pull request but not on every push. If an integration test is flaky, it must be fixed or quarantined — never ignored.
