# CI/CD Pipeline

## Overview

MiniOp's CI/CD pipeline automates building, testing, and deploying the video clipping platform across development, staging, and production environments. The pipeline handles Python (FastAPI backend), TypeScript (Next.js frontend), GPU-accelerated video processing workers, and infrastructure changes. This document covers both a free-tier setup using GitHub Actions and a scaled production pipeline with self-hosted runners, parallel test suites, and multi-environment promotion.

---

## Free Tier Pipeline (GitHub Actions, < 2,000 minutes/month)

### Repository Structure

```
minio/
├── .github/
│   └── workflows/
│       ├── ci.yml
│       ├── deploy-staging.yml
│       └── deploy-production.yml
├── backend/
│   ├── app/
│   ├── tests/
│   ├── Dockerfile
│   └── requirements.txt
├── frontend/
│   ├── src/
│   ├── tests/
│   ├── Dockerfile
│   └── package.json
├── worker/
│   ├── clip_processor/
│   ├── Dockerfile.gpu
│   └── requirements.txt
└── docker-compose.yml
```

### CI Workflow

`.github/workflows/ci.yml` — runs on every push and pull request:

```yaml
name: CI
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
          cache: pip
          cache-dependency-path: backend/requirements*.txt
      - run: pip install ruff mypy
        working-directory: backend
      - run: ruff check . && ruff format --check .
        working-directory: backend
      - run: mypy app/ --ignore-missing-imports
        working-directory: backend

  lint-frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci
        working-directory: frontend
      - run: npx next lint && npx tsc --noEmit
        working-directory: frontend

  test-backend:
    runs-on: ubuntu-latest
    needs: lint
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: minio
          POSTGRES_PASSWORD: testpass
          POSTGRES_DB: minio_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd="pg_isready -U minio"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=5
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]
    env:
      DATABASE_URL: postgresql://minio:testpass@localhost:5432/minio_test
      REDIS_URL: redis://localhost:6379/0
      S3_ENDPOINT: http://localhost:9000
      S3_ACCESS_KEY: minioadmin
      S3_SECRET_KEY: minioadmin
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
          cache: pip
          cache-dependency-path: backend/requirements*.txt
      - run: |
          pip install -r requirements.txt -r requirements-test.txt
          alembic upgrade head
          pytest tests/ -x --tb=short -q --cov=app --cov-report=xml
        working-directory: backend
      - uses: codecov/codecov-action@v4
        with:
          files: backend/coverage.xml
          flags: backend

  test-frontend:
    runs-on: ubuntu-latest
    needs: lint-frontend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci
        working-directory: frontend
      - run: npx vitest run --coverage
        working-directory: frontend

  build:
    runs-on: ubuntu-latest
    needs: [test-backend, test-frontend]
    if: github.ref == 'refs/heads/main' || github.ref == 'refs/heads/develop'
    strategy:
      matrix:
        service: [backend, frontend]
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v5
        with:
          context: ./${{ matrix.service }}
          push: true
          tags: |
            ghcr.io/${{ github.repository }}/${{ matrix.service }}:${{ github.sha }}
            ghcr.io/${{ github.repository }}/${{ matrix.service }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

### Deploy Workflow (Free Tier — Single VM)

`.github/workflows/deploy-staging.yml`:

```yaml
name: Deploy Staging
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [develop]

jobs:
  deploy:
    runs-on: ubuntu-latest
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.STAGING_HOST }}
          username: deploy
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            cd /opt/minio
            export IMAGE_TAG=${{ github.sha }}
            docker compose pull
            docker compose up -d --remove-orphans
            docker system prune -af --filter "until=72h"
            echo "Deployed $IMAGE_TAG at $(date)" >> /opt/minio/deploy.log
```

This free-tier approach uses a single VM with Docker Compose. The staging server runs `docker compose` with environment-specific overrides. No Kubernetes, no Terraform — just SSH and containers.

---

## Production Pipeline

### Self-Hosted Runners

For production, replace GitHub-hosted runners with self-hosted runners for GPU builds and cost control. Deploy runners on your infrastructure:

```yaml
# .github/workflows/ci-production.yml (partial)
runs-on: [self-hosted, linux, x64]
container:
  image: ghcr.io/minio-project/ci-runner:latest
  options: --gpus all
```

Self-hosted runner registration:

```bash
# On the runner machine
mkdir actions-runner && cd actions-runner
curl -o actions-runner-linux-x64.tar.gz -L https://github.com/actions/runner/releases/download/v2.311.0/actions-runner-linux-x64-2.311.0.tar.gz
tar xzf actions-runner-linux-x64.tar.gz
./config.sh --url https://github.com/minio-project/minio --token $RUNNER_TOKEN --labels self-hosted,linux,x64,gpu
./svc.sh install && ./svc.sh start
```

### Multi-Environment Promotion

Production deploys require manual approval and run against a Kubernetes cluster:

```yaml
# .github/workflows/deploy-production.yml
name: Deploy Production
on:
  push:
    tags: ["v*"]

jobs:
  promote:
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://minio.clip
    steps:
      - uses: actions/checkout@v4

      - name: Verify tag matches version
        run: |
          TAG=${GITHUB_REF#refs/tags/v}
          BACKEND_VER=$(grep 'version' backend/app/__init__.py | cut -d'"' -f2)
          [ "$TAG" = "$BACKEND_VER" ] || { echo "Version mismatch"; exit 1; }

      - uses: azure/k8s-set-context@v4
        with:
          kubeconfig: ${{ secrets.KUBE_CONFIG }}

      - name: Deploy to production
        run: |
          export IMAGE_TAG=${GITHUB_REF#refs/tags/v}
          envsubst < k8s/production/kustomization.yml > k8s/production/kustomization.yml.tmp
          mv k8s/production/kustomization.yml.tmp k8s/production/kustomization.yml
          kubectl apply -k k8s/production/
          kubectl rollout status deployment/minio-api -n minio --timeout=300s
          kubectl rollout status deployment/minio-frontend -n minio --timeout=120s
```

### Database Migrations in CI

Migrations run as a Kubernetes Job before the application rollout:

```yaml
# k8s/overlays/production/migration-job.yml
apiVersion: batch/v1
kind: Job
metadata:
  name: minio-migrate
  annotations:
    argocd.argoproj.io/hook: PreSync
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: ghcr.io/minio-project/backend:${IMAGE_TAG}
          command: ["alembic", "upgrade", "head"]
          envFrom:
            - secretRef:
                name: minio-db-credentials
```

### Secrets Management

Free tier uses GitHub repository secrets. Production uses External Secrets Operator syncing from AWS Secrets Manager:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: minio-secrets
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secretsmanager
    kind: ClusterSecretStore
  target:
    name: minio-secrets
  data:
    - secretKey: DATABASE_URL
      remoteRef:
        key: minio/production/database-url
    - secretKey: OPENAI_API_KEY
      remoteRef:
        key: minio/production/openai-key
```

### Pipeline Monitoring

Track pipeline health with GitHub Actions metrics exported to Prometheus:

```yaml
- name: Export pipeline metrics
  if: always()
  run: |
    curl -X POST ${{ secrets.PROMETHEUS_PUSHGATEWAY }}/metrics/job/ci \
      --data-binary "ci_duration_seconds{repo=\"minio\",branch=\"${{ github.ref_name }}\"} $SECONDS"
```

---

## Caching Strategy

| Cache Target | Free Tier | Production |
|---|---|---|
| Python deps | `actions/setup-python` cache | Self-hosted runner persistent `/root/.cache/pip` |
| Node modules | `actions/setup-node` cache | Self-hosted runner persistent `node_modules` |
| Docker layers | `cache-from: type=gha` | Registry-based cache (`type=registry`) |
| Test DB | Recreated each run | Persistent test database on shared volume |

### Optimizing Free Tier Minutes

- Use `concurrency` groups to cancel redundant runs.
- Skip CI for documentation-only changes using `paths-ignore: ['docs/**', '*.md']`.
- Cache aggressively — pip installs cost 2-3 minutes per run.
- Run frontend and backend tests in parallel jobs.
- Use `if: github.event_name == 'push'` to skip expensive jobs on PRs that only need lint.

---

## Rollback Procedure

```bash
# Immediate rollback to previous version
kubectl rollout undo deployment/minio-api -n minio
kubectl rollout undo deployment/minio-frontend -n minio

# Rollback to specific revision
kubectl rollout undo deployment/minio-api -n minio --to-revision=5

# Verify
kubectl rollout status deployment/minio-api -n minio
```

For the free-tier Docker Compose setup:

```bash
ssh staging "cd /opt/minio && git log --oneline deploy.log"
ssh staging "cd /opt/minio && IMAGE_TAG=<previous-sha> docker compose up -d"
```

---

## Summary

Start with the free-tier GitHub Actions pipeline using Docker Compose on a single VM. Graduate to self-hosted runners and Kubernetes when GPU builds become a bottleneck or when you need multi-replica deployments. The pipeline structure (lint → test → build → deploy) remains the same; only the execution infrastructure and deployment targets change.
