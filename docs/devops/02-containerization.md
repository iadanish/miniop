# Containerization

## Overview

MiniOp runs four distinct services: the FastAPI backend, the Next.js frontend, a GPU-accelerated video processing worker, and supporting infrastructure (PostgreSQL, Redis, MinIO object storage). Each service has its own Dockerfile optimized for build speed, image size, and security. This document covers container design for both free-tier single-machine deployments and production Kubernetes clusters.

---

## Image Architecture

### Backend (FastAPI)

`backend/Dockerfile`:

```dockerfile
FROM python:3.11-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

FROM base AS deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

FROM deps AS runtime
COPY app/ ./app/
COPY alembic/ ./alembic/
COPY alembic.ini .
RUN useradd --create-home --shell /bin/bash appuser
USER appuser

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "4"]
```

Key decisions:
- `python:3.11-slim` over `alpine` — avoids musl/glibc issues with native dependencies (librosa, opencv).
- Multi-stage build separates dependency installation from application code, so code changes don't trigger full reinstall.
- Non-root `appuser` for runtime — required by Kubernetes `runAsNonRoot` security context.
- Uvicorn with 4 workers matches a 2-vCPU pod; tune to `2 * num_cores + 1` for larger instances.

### Frontend (Next.js)

`frontend/Dockerfile`:

```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production=false

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000 || exit 1

CMD ["node", "server.js"]
```

The `next.config.js` must include `output: 'standalone'` to produce a self-contained build without `node_modules`. This reduces the final image from ~500MB to ~120MB.

```js
// next.config.js
module.exports = {
  output: 'standalone',
  experimental: {
    outputStandalone: true,
  },
};
```

### GPU Worker (Video Processing)

`worker/Dockerfile.gpu`:

```dockerfile
FROM nvidia/cuda:12.2.0-runtime-ubuntu22.04 AS base
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3.11-venv python3-pip ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

FROM deps AS runtime
COPY clip_processor/ ./clip_processor/
COPY models/ ./models/

RUN useradd --create-home --shell /bin/bash worker
USER worker

HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD python3 -c "import torch; assert torch.cuda.is_available()" || exit 1

CMD ["python3", "-m", "clip_processor.main"]
```

The GPU worker uses `nvidia/cuda:12.2.0-runtime-ubuntu22.04` as the base because:
- Runtime image (not `devel`) — smaller, contains only runtime libraries.
- CUDA 12.2 matches the PyTorch CUDA build to avoid version mismatches.
- FFmpeg is required for video demuxing and frame extraction.

Build with GPU context flag:

```bash
docker build -f worker/Dockerfile.gpu -t minio-worker:latest .
# On a machine without GPU, use buildx:
docker buildx build --platform linux/amd64 -f worker/Dockerfile.gpu -t minio-worker:latest .
```

---

## Docker Compose (Free Tier)

`docker-compose.yml` for local development and single-VM deployment:

```yaml
version: "3.9"

services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: minio
      POSTGRES_PASSWORD: ${DB_PASSWORD:-changeme}
      POSTGRES_DB: minio
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U minio"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
    volumes:
      - redisdata:/data
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: ${MINIO_PASSWORD:-minioadmin}
    volumes:
      - s3data:/data
    ports:
      - "9000:9000"
      - "9001:9001"
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 10s
      timeout: 5s
      retries: 5

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    environment:
      DATABASE_URL: postgresql://minio:${DB_PASSWORD:-changeme}@postgres:5432/minio
      REDIS_URL: redis://redis:6379/0
      S3_ENDPOINT: http://minio:9000
      S3_ACCESS_KEY: minioadmin
      S3_SECRET_KEY: ${MINIO_PASSWORD:-minioadmin}
      S3_BUCKET: minio-clips
    ports:
      - "8000:8000"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio:
        condition: service_healthy

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    environment:
      NEXT_PUBLIC_API_URL: http://localhost:8000
    ports:
      - "3000:3000"
    depends_on:
      - backend

  worker:
    build:
      context: ./worker
      dockerfile: Dockerfile.gpu
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    environment:
      DATABASE_URL: postgresql://minio:${DB_PASSWORD:-changeme}@postgres:5432/minio
      REDIS_URL: redis://redis:6379/1
      S3_ENDPOINT: http://minio:9000
      S3_ACCESS_KEY: minioadmin
      S3_SECRET_KEY: ${MINIO_PASSWORD:-minioadmin}
      CUDA_VISIBLE_DEVICES: "0"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio:
        condition: service_healthy

volumes:
  pgdata:
  redisdata:
  s3data:
```

Start the stack:

```bash
# Without GPU (backend-only processing)
docker compose up -d postgres redis minio backend frontend

# With GPU worker
docker compose --profile gpu up -d
```

---

## Image Size Optimization

| Image | Unoptimized | Optimized | Technique |
|---|---|---|---|
| backend | ~900MB | ~180MB | slim base, no cache, `.dockerignore` |
| frontend | ~500MB | ~120MB | standalone output, alpine |
| worker | ~6.5GB | ~3.2GB | runtime (not devel) base, layer ordering |

Critical `.dockerignore` entries (place in each service directory):

```
__pycache__
*.pyc
.git
.env
node_modules
.next
coverage
*.test.*
tests/
docs/
```

---

## Production Kubernetes Manifests

### Backend Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio-api
  labels:
    app: minio-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: minio-api
  template:
    metadata:
      labels:
        app: minio-api
    spec:
      securityContext:
        runAsNonRoot: true
        fsGroup: 1000
      containers:
        - name: api
          image: ghcr.io/minio-project/backend:${IMAGE_TAG}
          ports:
            - containerPort: 8000
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: "2"
              memory: 2Gi
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /ready
              port: 8000
            initialDelaySeconds: 5
            periodSeconds: 10
          envFrom:
            - secretRef:
                name: minio-secrets
```

### GPU Worker DaemonSet/Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio-worker
spec:
  replicas: 2
  selector:
    matchLabels:
      app: minio-worker
  template:
    spec:
      nodeSelector:
        accelerator: nvidia-tesla-t4
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      containers:
        - name: worker
          image: ghcr.io/minio-project/worker:${IMAGE_TAG}
          resources:
            requests:
              cpu: "2"
              memory: 8Gi
              nvidia.com/gpu: "1"
            limits:
              cpu: "4"
              memory: 16Gi
              nvidia.com/gpu: "1"
          env:
            - name: CUDA_VISIBLE_DEVICES
              value: "0"
            - name: TORCH_NUM_THREADS
              value: "4"
```

---

## Registry Strategy

Free tier: GitHub Container Registry (`ghcr.io`) — included with GitHub Actions, 500MB free storage.

Production: Same registry with retention policies:

```yaml
# .github/workflows/cleanup-registry.yml
- uses: actions/delete-package-versions@v5
  with:
    package-name: backend
    min-versions-to-keep: 10
    delete-only-untagged-versions: true
```

Tag strategy:
- `latest` — latest build from `main`
- `sha-<commit>` — immutable, used in deployments
- `v1.2.3` — release tags for production rollbacks
- `pr-<number>` — ephemeral, auto-cleaned

---

## Security Hardening

```dockerfile
# Apply to all Dockerfiles
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["tini", "--"]
```

Use `tini` as PID 1 to properly handle signal forwarding and zombie reaping. Without it, `uvicorn` spawned via shell form won't receive `SIGTERM` on `docker stop`.

Image scanning in CI:

```yaml
- name: Scan for vulnerabilities
  uses: aquasecurity/trivy-action@master
  with:
    image-ref: ghcr.io/${{ github.repository }}/backend:${{ github.sha }}
    format: table
    exit-code: 1
    severity: CRITICAL,HIGH
```

---

## Summary

Each MiniOp service gets a purpose-built Dockerfile with multi-stage builds, non-root users, and health checks. Start with `docker compose` on a single machine. Move to Kubernetes when you need GPU scheduling, horizontal scaling, or rolling deployments. The container images themselves don't change — only the orchestration layer does.
