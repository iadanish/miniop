# MiniOp Development Workflow

## Overview

This document defines the development workflow for MiniOp, covering branch strategies, CI/CD pipelines, code review, testing, and deployment processes. It scales from a 3-person free-tier team shipping from a monorepo to a 30+ person organization with independent services and automated quality gates.

---

## Phase 1: Free Tier Workflow (3-8 people)

### Repository Structure — Monorepo

```
minio/
├── apps/
│   ├── web/                    # Next.js frontend
│   └── api/                    # Express.js API server
├── packages/
│   ├── shared-types/           # TypeScript type definitions
│   ├── ui-components/          # Shared React components
│   └── ml-client/              # Python ML service client
├── services/
│   ├── video-worker/           # BullMQ video processing
│   ├── transcription/          # Whisper wrapper
│   └── clip-scorer/            # GPT-4 clip analysis
├── infra/
│   ├── docker-compose.yml
│   ├── railway.toml
│   └── terraform/
├── .github/
│   └── workflows/
├── package.json                # Workspace root
├── turbo.json                  # Turborepo config
└── pnpm-workspace.yaml
```

### Branch Strategy — Simplified Trunk-Based

```yaml
# .github/branch-protection.yml
branches:
  main:
    required_reviews: 1          # Free tier: 1 review sufficient
    require_status_checks: true
    required_checks:
      - "lint"
      - "typecheck"
      - "test"
      - "build"
    allow_force_pushes: false
    allow_deletions: false

  "release/*":
    required_reviews: 2
    required_checks:
      - "lint"
      - "typecheck"
      - "test"
      - "build"
      - "e2e"
```

**Branch naming convention:**
```bash
# Feature branches
feat/video-upload-progress
feat/clip-preview-player
fix/transcription-timeout
chore/update-dependencies
docs/api-documentation

# Commands
git checkout -b feat/clip-scoring-model
git push -u origin feat/clip-scoring-model
```

### CI/CD Pipeline — GitHub Actions

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck

  test:
    runs-on: ubuntu-latest
    needs: lint
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: minio_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
      redis:
        image: redis:7
        ports: ['6379:6379']
    env:
      DATABASE_URL: postgresql://test:test@localhost:5432/minio_test
      REDIS_URL: redis://localhost:6379
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test -- --coverage
      - uses: codecov/codecov-action@v4
        with:
          token: ${{ secrets.CODECOV_TOKEN }}

  build:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - uses: actions/upload-artifact@v4
        with:
          name: build-output
          path: apps/web/.next

  deploy-preview:
    runs-on: ubuntu-latest
    needs: build
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@v4
      - uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          working-directory: apps/web

  deploy-production:
    runs-on: ubuntu-latest
    needs: build
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          working-directory: apps/web
          vercel-args: '--prod'
```

### Video Worker Deployment

```yaml
# .github/workflows/deploy-worker.yml
name: Deploy Video Worker

on:
  push:
    branches: [main]
    paths:
      - 'services/video-worker/**'
      - 'packages/shared-types/**'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Build Docker image
        run: |
          docker build -t minio-video-worker \
            -f services/video-worker/Dockerfile .
          
      - name: Push to registry
        run: |
          echo ${{ secrets.DOCKER_PASSWORD }} | \
            docker login -u ${{ secrets.DOCKER_USERNAME }} --password-stdin
          docker tag minio-video-worker \
            ${{ secrets.DOCKER_REGISTRY }}/minio-video-worker:${{ github.sha }}
          docker push \
            ${{ secrets.DOCKER_REGISTRY }}/minio-video-worker:${{ github.sha }}
            
      - name: Deploy to Railway
        run: |
          railway up --service video-worker \
            --image ${{ secrets.DOCKER_REGISTRY }}/minio-video-worker:${{ github.sha }}
```

### Local Development Setup

```bash
# Clone and setup
git clone https://github.com/miniop/miniop.git
cd miniop
pnpm install

# Start infrastructure
docker compose -f infra/docker-compose.yml up -d

# Environment variables
cp .env.example .env.local
# Edit .env.local with your keys:
# DATABASE_URL=postgresql://postgres:postgres@localhost:5432/miniop
# REDIS_URL=redis://localhost:6379
# OPENAI_API_KEY=sk-...
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...

# Run development servers
pnpm dev                    # All services via Turborepo
pnpm dev --filter=web       # Frontend only
pnpm dev --filter=api       # API only
pnpm dev --filter=video-worker  # Video worker only

# Database management
pnpm db:generate            # Generate Prisma client
pnpm db:push                # Push schema changes
pnpm db:migrate             # Create migration
pnpm db:seed                # Seed test data
```

### Code Review Process — Free Tier

```markdown
## PR Template (.github/pull_request_template.md)

### What
<!-- Brief description of changes -->

### Why
<!-- Link to issue or explanation -->

### How
<!-- Key implementation decisions -->

### Testing
- [ ] Unit tests pass
- [ ] Manual testing completed
- [ ] No console errors

### Screenshots / Videos
<!-- If UI changes -->

### Checklist
- [ ] Types pass (`pnpm typecheck`)
- [ ] Lint passes (`pnpm lint`)
- [ ] Tests added/updated
- [ ] Docs updated if needed
```

**Review expectations:**
- First review within 4 hours (business hours)
- Author resolves all comments before merge
- Squash merge to keep history clean
- Auto-delete branch after merge

### Testing Strategy — Free Tier

```typescript
// Unit test example — services/api/src/clips/__tests__/scoring.test.ts
import { describe, it, expect, vi } from 'vitest';
import { calculateClipScore } from '../scoring';

describe('calculateClipScore', () => {
  it('scores high-engagement clips above 0.8', () => {
    const clip = {
      transcript: { sentiment: 0.9, keywords: ['viral', 'amazing'] },
      visual: { sceneChanges: 12, faceCount: 2 },
      duration: 45,
    };
    expect(calculateClipScore(clip)).toBeGreaterThan(0.8);
  });

  it('scores low-engagement clips below 0.4', () => {
    const clip = {
      transcript: { sentiment: -0.2, keywords: [] },
      visual: { sceneChanges: 2, faceCount: 0 },
      duration: 300,
    };
    expect(calculateClipScore(clip)).toBeLessThan(0.4);
  });
});
```

```typescript
// Integration test example — services/api/src/__tests__/upload.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import { db } from '../db';

beforeAll(async () => {
  await db.migrate.latest();
});

afterAll(async () => {
  await db.destroy();
});

describe('POST /api/videos/upload', () => {
  it('accepts valid video upload and returns job ID', async () => {
    const res = await request(app)
      .post('/api/videos/upload')
      .attach('video', Buffer.from('fake-video'), 'test.mp4')
      .set('Authorization', `Bearer ${testToken}`)
      .expect(201);

    expect(res.body).toMatchObject({
      jobId: expect.any(String),
      status: 'processing',
    });
  });
});
```

```bash
# Run tests
pnpm test                          # All tests
pnpm test -- --watch               # Watch mode
pnpm test -- --filter=api          # API tests only
pnpm test:e2e                      # End-to-end tests (Playwright)
pnpm test:e2e -- --ui              # Playwright UI mode
```

---

## Phase 2: Scaled Production Workflow (15-40 people)

### Repository Structure — Polyrepo with Shared Packages

```
# Independent repositories
miniop/infra              # Terraform, Kubernetes, shared infra
miniop/platform           # Shared libraries, types, utilities
miniop/web                # Next.js frontend
miniop/api-gateway        # API gateway and auth
miniop/clip-intelligence  # ML models and scoring
miniop/video-pipeline     # Video processing workers
miniop/analytics          # Data pipeline and dashboards

# Internal npm packages (published to GitHub Packages)
@miniop/shared-types
@miniop/ui-components
@miniop/api-client
@miniop/logger
@miniop/queue-utils
```

### Branch Strategy — Git Flow with Release Branches

```yaml
# Branch model
main:              # Production-ready code
develop:           # Integration branch
release/v1.2.0:   # Release candidates
feat/*:            # Feature branches
fix/*:             # Bug fixes
hotfix/*:          # Production hotfixes

# Release process
1. Create release branch from develop
2. QA tests release branch
3. Cherry-pick fixes as needed
4. Merge to main + tag
5. Merge back to develop
```

### Multi-Service CI/CD

```yaml
# .github/workflows/platform-ci.yml
name: Platform CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      api: ${{ steps.filter.outputs.api }}
      web: ${{ steps.filter.outputs.web }}
      ml: ${{ steps.filter.outputs.ml }}
      pipeline: ${{ steps.filter.outputs.pipeline }}
    steps:
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            api:
              - 'services/api-gateway/**'
            web:
              - 'apps/web/**'
            ml:
              - 'services/clip-intelligence/**'
            pipeline:
              - 'services/video-pipeline/**'

  api:
    needs: changes
    if: needs.changes.outputs.api == 'true'
    uses: ./.github/workflows/api-ci.yml
    secrets: inherit

  web:
    needs: changes
    if: needs.changes.outputs.web == 'true'
    uses: ./.github/workflows/web-ci.yml
    secrets: inherit

  ml:
    needs: changes
    if: needs.changes.outputs.ml == 'true'
    uses: ./.github/workflows/ml-ci.yml
    secrets: inherit

  pipeline:
    needs: changes
    if: needs.changes.outputs.pipeline == 'true'
    uses: ./.github/workflows/pipeline-ci.yml
    secrets: inherit
```

### Kubernetes Deployment

```yaml
# infra/k8s/video-pipeline/deployment.yml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: video-worker
  namespace: miniop
  labels:
    app: video-worker
    team: video-pipeline
spec:
  replicas: 3
  selector:
    matchLabels:
      app: video-worker
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: video-worker
        team: video-pipeline
    spec:
      containers:
        - name: worker
          image: ghcr.io/miniop/video-worker:latest
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2000m"
              memory: "2Gi"
          env:
            - name: REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: miniop-secrets
                  key: redis-url
            - name: S3_BUCKET
              value: "miniop-videos-prod"
            - name: CONCURRENCY
              value: "5"
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /ready
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
```

### Deployment Pipeline — ArgoCD

```yaml
# infra/argocd/applications/video-pipeline.yml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: video-pipeline
  namespace: argocd
spec:
  project: miniop
  source:
    repoURL: https://github.com/miniop/infra.git
    targetRevision: main
    path: k8s/video-pipeline
  destination:
    server: https://kubernetes.default.svc
    namespace: miniop
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
    retry:
      limit: 3
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

### Feature Flags — LaunchDarkly

```typescript
// packages/feature-flags/src/flags.ts
export const FEATURE_FLAGS = {
  NEW_CLIP_SCORER: 'new-clip-scorer-v2',
  AUTO_CAPTIONS: 'auto-captions-beta',
  BATCH_PROCESSING: 'batch-processing',
  PREMIUM_EXPORT: 'premium-export-formats',
} as const;

// Usage in API
import { FEATURE_FLAGS } from '@miniop/feature-flags';
import { launchDarklyClient } from './ld-client';

export async function processVideo(videoId: string) {
  const useNewScorer = await launchDarklyClient.variation(
    FEATURE_FLAGS.NEW_CLIP_SCORER,
    { userId: video.userId },
    false
  );

  if (useNewScorer) {
    return newClipScorer.process(video);
  }
  return legacyClipScorer.process(video);
}
```

### Code Review — Scaled Process

```yaml
# .github/CODEOWNERS (scaled)
/apps/web/                  @miniop/creator-experience
/services/api-gateway/      @miniop/platform
/services/clip-intelligence/ @miniop/clip-intelligence
/services/video-pipeline/   @miniop/video-pipeline
/infra/                     @miniop/platform
/packages/shared-types/     @miniop/platform @miniop/creator-experience
/.github/                   @miniop/platform
```

**Review SLAs (scaled):**
- First review: 4 hours (business hours)
- Follow-up reviews: 2 hours
- Hotfix reviews: 1 hour
- Architecture reviews: scheduled within 48 hours

### Quality Gates

```yaml
# Required checks before merge (scaled)
required_status_checks:
  - lint
  - typecheck
  - unit-tests
  - integration-tests
  - security-scan          # Snyk / CodeQL
  - license-check          # Ensure compatible licenses
  - bundle-size            # Don't increase bundle by >5%
  - preview-deploy-success # Vercel preview must deploy

# Quality metrics tracked
quality_metrics:
  code_coverage:
    minimum: 80%
    target: 90%
  bundle_size:
    max_increase: "5%"
  lighthouse:
    performance: 90
    accessibility: 95
  api_latency:
    p95: "< 200ms"
```

### Monitoring and Observability

```typescript
// packages/telemetry/src/setup.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_ENDPOINT || 'http://otel-collector:4318/v1/traces',
  }),
  metricReader: new PrometheusExporter({
    port: 9464,
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
```

```yaml
# infra/monitoring/alerts/video-pipeline.yml
groups:
  - name: video-pipeline
    rules:
      - alert: HighProcessingLatency
        expr: histogram_quantile(0.95, rate(video_processing_duration_seconds_bucket[5m])) > 120
        for: 5m
        labels:
          severity: warning
          team: video-pipeline
        annotations:
          summary: "Video processing P95 latency exceeds 2 minutes"
          
      - alert: WorkerQueueBacklog
        expr: bullmq_waiting_jobs{queue="video-processing"} > 100
        for: 10m
        labels:
          severity: critical
          team: video-pipeline
        annotations:
          summary: "Video processing queue has >100 pending jobs"
          
      - alert: TranscodingFailureRate
        expr: rate(video_transcoding_failures_total[15m]) / rate(video_transcoding_total[15m]) > 0.05
        for: 5m
        labels:
          severity: critical
          team: video-pipeline
        annotations:
          summary: "Transcoding failure rate exceeds 5%"
```

### Incident Response Workflow

```bash
# Incident response runbook
# 1. Alert fires in PagerDuty
# 2. On-call acknowledges within SLA
# 3. Create incident channel
/incident create "Video processing degraded" --severity=p2 --team=video-pipeline

# 4. Post status in #incidents
/status investigating - P2 incident, video processing latency elevated

# 5. Debug with observability
# Check Grafana dashboards
# Query Loki for error logs
# Trace specific requests in Tempo

# 6. Mitigate
kubectl scale deployment video-worker --replicas=6 -n miniop

# 7. Resolve and postmortem
/status resolved - Scaled workers, latency returned to normal
/incident close --postmortem=required
```

---

## Appendix: Environment Configuration

```yaml
# .env.schema (documentation of all env vars)
database:
  DATABASE_URL: "postgresql://user:pass@host:5432/minio"
  DATABASE_POOL_SIZE: 10
  DATABASE_SSL: true

redis:
  REDIS_URL: "redis://host:6379"
  REDIS_POOL_SIZE: 5

storage:
  AWS_ACCESS_KEY_ID: ""
  AWS_SECRET_ACCESS_KEY: ""
  S3_BUCKET: "miniop-videos"
  S3_REGION: "us-east-1"
  CDN_URL: "https://cdn.miniop.com"

ai:
  OPENAI_API_KEY: ""
  OPENAI_MODEL: "gpt-4-turbo"
  WHISPER_MODEL: "whisper-large-v3"

monitoring:
  OTEL_ENDPOINT: ""
  SENTRY_DSN: ""
  LOG_LEVEL: "info"
```
