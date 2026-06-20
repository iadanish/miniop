# Unit Testing Strategy

## Overview

Unit testing forms the foundation of MiniOp's quality assurance. Every isolated function, class, and module must be verifiable without external dependencies. This document defines the standards, tools, and patterns for unit testing across the MiniOp codebase — from local development on the free tier to CI-gated production pipelines.

## Tooling

MiniOp uses **Vitest** as its primary unit test runner for the frontend and shared libraries, and **Jest** for backend Node.js services. Both are configured with TypeScript support, path aliases, and coverage thresholds.

### Vitest Configuration (Frontend / Shared)

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
      exclude: ['src/**/*.d.ts', 'src/**/*.stories.tsx', 'src/main.tsx'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, 'packages/shared/src'),
    },
  },
});
```

### Jest Configuration (Backend Services)

```ts
// jest.config.ts
import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@shared/(.*)$': '<rootDir>/../shared/src/$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
  ],
  coverageThresholds: {
    global: {
      statements: 80,
      branches: 70,
      functions: 80,
      lines: 80,
    },
  },
  setupFilesAfterSetup: ['./tests/setup.ts'],
};

export default config;
```

### Test Setup File

```ts
// tests/setup.ts
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
```

## What to Unit Test

### Pure Business Logic (Highest Priority)

MiniOp's core value lies in clip detection, scene analysis, and highlight scoring. These modules are pure functions with deterministic outputs — they must have 100% branch coverage.

```ts
// src/modules/clip-detection/scoring.test.ts
import { describe, it, expect } from 'vitest';
import { calculateHighlightScore, normalizeTimestamp } from './scoring';

describe('calculateHighlightScore', () => {
  it('returns high score for loud audio peaks with speech', () => {
    const segment = {
      audioLevel: 0.92,
      hasSpeech: true,
      sentimentScore: 0.85,
      duration: 45,
    };
    const result = calculateHighlightScore(segment);
    expect(result.score).toBeGreaterThanOrEqual(0.8);
    expect(result.confidence).toBeGreaterThan(0.7);
    expect(result.factors).toContain('audio_peak');
    expect(result.factors).toContain('speech_detected');
  });

  it('returns low score for silent segments without speech', () => {
    const segment = {
      audioLevel: 0.05,
      hasSpeech: false,
      sentimentScore: 0.1,
      duration: 10,
    };
    const result = calculateHighlightScore(segment);
    expect(result.score).toBeLessThan(0.3);
  });

  it('handles edge case: zero-duration segment', () => {
    const segment = {
      audioLevel: 0.5,
      hasSpeech: true,
      sentimentScore: 0.5,
      duration: 0,
    };
    const result = calculateHighlightScore(segment);
    expect(result.score).toBe(0);
    expect(result.factors).toContain('zero_duration');
  });

  it('normalizes score to 0-1 range regardless of input magnitude', () => {
    const extreme = {
      audioLevel: 999,
      hasSpeech: true,
      sentimentScore: -50,
      duration: 3600,
    };
    const result = calculateHighlightScore(extreme);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});

describe('normalizeTimestamp', () => {
  it('converts seconds to HH:MM:SS format', () => {
    expect(normalizeTimestamp(3661)).toBe('01:01:01');
    expect(normalizeTimestamp(0)).toBe('00:00:00');
    expect(normalizeTimestamp(59)).toBe('00:00:59');
  });

  it('handles fractional seconds by truncating', () => {
    expect(normalizeTimestamp(61.7)).toBe('00:01:01');
  });

  it('throws on negative input', () => {
    expect(() => normalizeTimestamp(-1)).toThrow('Timestamp cannot be negative');
  });
});
```

### Data Transformation Layers

Clip metadata, user settings, and API response mappers are high-value unit test targets:

```ts
// src/modules/export/formatClipForExport.test.ts
import { describe, it, expect } from 'vitest';
import { formatClipForExport } from './formatClipForExport';
import type { Clip, ExportFormat } from '@shared/types';

const mockClip: Clip = {
  id: 'clip_abc123',
  sourceVideoId: 'vid_xyz',
  startTime: 120,
  endTime: 165,
  title: 'Best moment',
  score: 0.91,
  captions: [
    { start: 120, end: 123, text: 'Welcome everyone' },
    { start: 123, end: 126, text: 'to the show' },
  ],
  aspectRatio: '9:16',
};

describe('formatClipForExport', () => {
  it('formats clip for vertical video export', () => {
    const result = formatClipForExport(mockClip, 'vertical');
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1920);
    expect(result.duration).toBe(45);
    expect(result.captions).toHaveLength(2);
  });

  it('formats clip for horizontal video export', () => {
    const result = formatClipForExport(mockClip, 'horizontal');
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
  });

  it('strips captions when burn-in is disabled', () => {
    const result = formatClipForExport(mockClip, 'vertical', { burnCaptions: false });
    expect(result.captions).toHaveLength(0);
    expect(result.captionFile).toBeDefined();
  });
});
```

### React Component Logic

Test component behavior, not implementation details. Focus on user-facing outcomes:

```tsx
// src/components/ClipTimeline/ClipTimeline.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ClipTimeline } from './ClipTimeline';

const mockClips = [
  { id: '1', startTime: 10, endTime: 40, score: 0.9, title: 'Clip A' },
  { id: '2', startTime: 60, endTime: 90, score: 0.7, title: 'Clip B' },
  { id: '3', startTime: 120, endTime: 150, score: 0.5, title: 'Clip C' },
];

describe('ClipTimeline', () => {
  it('renders all clips in score order', () => {
    render(<ClipTimeline clips={mockClips} onSelect={() => {}} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Clip A');
  });

  it('calls onSelect with clip id when clicked', () => {
    const onSelect = vi.fn();
    render(<ClipTimeline clips={mockClips} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Clip B'));
    expect(onSelect).toHaveBeenCalledWith('2');
  });

  it('displays empty state when no clips provided', () => {
    render(<ClipTimeline clips={[]} onSelect={() => {}} />);
    expect(screen.getByText(/no clips detected/i)).toBeInTheDocument();
  });

  it('highlights the active clip', () => {
    render(<ClipTimeline clips={mockClips} activeClipId="2" onSelect={() => {}} />);
    expect(screen.getByText('Clip B').closest('[data-active]')).toBeInTheDocument();
  });
});
```

## Mocking Strategy

### External Services

Never call real APIs in unit tests. Mock at the module boundary:

```ts
// src/modules/video/videoService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchVideoMetadata } from './videoService';

vi.mock('@/lib/api', () => ({
  httpClient: {
    get: vi.fn(),
  },
}));

import { httpClient } from '@/lib/api';

describe('fetchVideoMetadata', () => {
  beforeEach(() => {
    vi.mocked(httpClient.get).mockReset();
  });

  it('returns parsed metadata on success', async () => {
    vi.mocked(httpClient.get).mockResolvedValue({
      data: { id: 'vid_1', duration: 300, resolution: '1080p' },
    });
    const result = await fetchVideoMetadata('vid_1');
    expect(result.duration).toBe(300);
    expect(httpClient.get).toHaveBeenCalledWith('/api/videos/vid_1/metadata');
  });

  it('throws descriptive error on 404', async () => {
    vi.mocked(httpClient.get).mockRejectedValue({ response: { status: 404 } });
    await expect(fetchVideoMetadata('nonexistent')).rejects.toThrow('Video not found');
  });
});
```

### Database and Storage

Use in-memory mocks for database layer functions. Do not spin up containers for unit tests — that belongs in integration testing.

```ts
// src/repositories/clipRepository.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createClipRepository } from './clipRepository';
import { createMockDb } from '../../tests/mocks/database';

describe('clipRepository', () => {
  let repo: ReturnType<typeof createClipRepository>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
    repo = createClipRepository(db);
  });

  it('inserts clip with generated id', async () => {
    const clip = await repo.create({
      videoId: 'vid_1',
      startTime: 10,
      endTime: 40,
      score: 0.85,
    });
    expect(clip.id).toMatch(/^clip_/);
    expect(db.clips).toHaveLength(1);
  });

  it('retrieves clips by video id sorted by score', async () => {
    await repo.create({ videoId: 'vid_1', startTime: 10, endTime: 40, score: 0.5 });
    await repo.create({ videoId: 'vid_1', startTime: 60, endTime: 90, score: 0.9 });
    await repo.create({ videoId: 'vid_2', startTime: 0, endTime: 30, score: 0.99 });

    const clips = await repo.findByVideoId('vid_1');
    expect(clips).toHaveLength(2);
    expect(clips[0].score).toBeGreaterThan(clips[1].score);
  });
});
```

## Free Tier vs. Production

| Aspect | Free Tier (Local) | Production (CI) |
|--------|-------------------|-----------------|
| Runner | Vitest/Jest in watch mode | Parallelized in GitHub Actions |
| Coverage | Console reporter, no gate | lcov + Codecov, 80% gate |
| Thresholds | Advisory warnings | Hard block on PR merge |
| Parallelism | Single thread | `--shard=1/4` across matrix |
| Mocking | Manual mocks | Shared mock factories in `@minio/test-utils` |

### CI Configuration

```yaml
# .github/workflows/unit-tests.yml
name: Unit Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm vitest run --shard=${{ matrix.shard }}/4 --coverage
      - uses: codecov/codecov-action@v4
        with:
          files: ./coverage/lcov.info
          flags: unit-${{ matrix.shard }}
```

## Running Tests

```bash
# All unit tests
pnpm vitest run

# Watch mode (free tier development)
pnpm vitest

# Single file
pnpm vitest src/modules/clip-detection/scoring.test.ts

# With coverage
pnpm vitest run --coverage

# Jest (backend)
pnpm jest --config jest.config.ts
```

## Naming Conventions

- Test files: `<module>.test.ts` or `<module>.spec.ts`, co-located with source
- Test directories: `tests/` at package root for shared fixtures and mocks
- Describes: Use the module/function name — `describe('calculateHighlightScore', ...)`
- Cases: Use plain language — `it('returns high score for loud audio peaks', ...)`

## Anti-Patterns to Avoid

1. **Testing implementation details** — Don't assert on internal state, mock return values of private functions, or check call order unless behavior depends on it.
2. **Snapshot abuse** — Snapshot tests for React components rot quickly. Use them only for stable, rarely-changing UI like icon sets.
3. **Shared mutable state** — Each test must be independent. Never rely on test execution order.
4. **Over-mocking** — If a function calls another function in the same module, don't mock it. Test the real integration at the unit level.

## Coverage Enforcement

Coverage thresholds are enforced at the package level, not globally. Each package in the monorepo defines its own thresholds in its local config. The global CI gate checks that no package drops below 80% statements.

```bash
# Check coverage locally
pnpm vitest run --coverage --reporter=json-summary

# Enforce thresholds
node scripts/check-coverage.mjs coverage/coverage-summary.json
```

Unit tests must be fast (under 10 seconds for the full suite), deterministic, and runnable offline. If a test requires network, a database, or a running server, it is not a unit test — move it to the integration suite.
