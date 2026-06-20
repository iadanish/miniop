# MiniOp Rollback Strategy

## Overview

MiniOp is an open-source video clipping platform that processes long-form video into short-form clips using AI scene detection, transcript analysis, and engagement scoring. The platform runs on two deployment profiles: a **free-tier single-node deployment** (Docker Compose on a single VPS) and a **scaled production deployment** (Kubernetes with horizontally scaled workers). Rollback procedures differ significantly between these profiles because the failure modes, blast radius, and recovery time objectives are fundamentally different.

This document establishes the rollback strategy that governs all subsystem-specific rollback procedures documented in subsequent files.

## Rollback Principles

### Principle 1: Roll Forward Is Preferred, Roll Back Is the Safety Net

MiniOp's clip generation pipeline is asynchronous. A bad deployment that corrupts clip output can be fixed by redeploying the corrected version and reprocessing queued jobs. Rollback is reserved for cases where:

- The deployment introduces data corruption in PostgreSQL that would compound if left running.
- The deployment causes cascading failures in downstream services (e.g., the transcription worker saturates the GPU queue).
- A security vulnerability is introduced that cannot be patched forward within the acceptable exposure window.

### Principle 2: Database Schema Changes Are the Hard Boundary

Application code can be rolled back in seconds. Database migrations cannot. Any migration that drops columns, renames tables, or changes constraints must follow the expand-contract pattern. A migration that violates this pattern makes the previous application version incompatible, forcing a coordinated rollback rather than a simple redeployment.

### Principle 3: Stateful Services Require Point-in-Time Recovery

MiniOp stores video files in object storage (S3-compatible), clip artifacts in a CDN-backed bucket, and processing state in Redis. Rollback of stateful services means restoring to a known-good snapshot, not just redeploying old code.

## Deployment Profiles

### Free Tier (Docker Compose)

The free tier runs all MiniOp services on a single node:

```yaml
# docker-compose.prod.yml
services:
  api:
    image: minio/api:1.4.2
    environment:
      - DATABASE_URL=postgresql://minio:***@postgres:5432/minio
      - REDIS_URL=redis://redis:6379
  worker:
    image: minio/worker:1.4.2
    environment:
      - DATABASE_URL=postgresql://minio:***@postgres:5432/minio
      - GPU_ENABLED=true
  postgres:
    image: postgres:16-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
  redis:
    image: redis:7-alpine
```

Rollback on the free tier is a full stack operation. You roll back the entire compose stack to a pinned version. There is no partial rollback because all services share a single database instance.

### Scaled Production (Kubernetes)

Production runs separate deployments for each service:

```
minio-api        Deployment  3 replicas
minio-worker     Deployment  5 replicas (GPU node pool)
minio-scheduler  Deployment  2 replicas
minio-frontend   Deployment  3 replicas
```

Rollback in production can target individual deployments. If the worker deployment introduces a regression but the API is fine, you roll back only the worker.

## Rollback Decision Matrix

| Scenario | Free Tier Action | Production Action |
|---|---|---|
| API regression (no DB change) | `docker compose rollback api` | `kubectl rollout undo deployment/minio-api` |
| Worker regression (no DB change) | Full stack rollback | `kubectl rollout undo deployment/minio-worker` |
| DB migration failure during deploy | Restore pg_dump, redeploy previous version | Restore from RDS snapshot, redeploy previous version |
| DB migration succeeds but app has bug | Roll forward with fix (preferred) | Roll forward with fix; if critical, coordinated rollback |
| Redis corruption | Flush Redis, restart workers | Failover to Redis replica, flush primary |
| Object storage corruption | Restore from backup bucket | Restore from versioned S3 bucket |

## Free Tier Rollback Procedure

### Step 1: Pin the Current Bad State

Before rolling back, capture the current state for forensics:

```bash
cd /opt/minio
docker compose logs api > /opt/minio/backups/logs-api-$(date +%s).txt
docker compose logs worker > /opt/minio/backups/logs-worker-$(date +%s).txt
docker compose exec postgres pg_dump -U minio minio > /opt/minio/backups/dump-$(date +%s).sql
```

### Step 2: Edit the Compose File to the Previous Version

```bash
# Edit docker-compose.prod.yml
sed -i 's/minio\/api:1.4.2/minio\/api:1.4.1/g' docker-compose.prod.yml
sed -i 's/minio\/worker:1.4.2/minio\/worker:1.4.1/g' docker-compose.prod.yml
```

### Step 3: Roll Back the Stack

```bash
docker compose down
docker compose up -d
```

### Step 4: Verify

```bash
curl -sf http://localhost:8080/health | jq .
# Expected: {"status":"ok","version":"1.4.1","db":"connected","redis":"connected"}
```

## Production Rollback Procedure

### Step 1: Identify the Faulty Deployment

```bash
kubectl rollout history deployment/minio-api -n minio
kubectl rollout status deployment/minio-api -n minio
```

### Step 2: Roll Back the Specific Deployment

```bash
kubectl rollout undo deployment/minio-api -n minio
# Or rollback to a specific revision:
kubectl rollout undo deployment/minio-api -n minio --to-revision=42
```

### Step 3: Verify Pods Are Healthy

```bash
kubectl get pods -n minio -l app=minio-api
kubectl logs -n minio -l app=minio-api --tail=50
```

### Step 4: Check the Rollout Status

```bash
kubectl rollout status deployment/minio-api -n minio --timeout=300s
```

## Rollback Time Objectives

| Tier | RTO (Recovery Time Objective) | RPO (Recovery Point Objective) |
|---|---|---|
| Free Tier | 15 minutes (full stack restart) | Last pg_dump (hourly cron) |
| Production | 2 minutes per deployment | Point-in-time recovery (RDS, 5-minute granularity) |

## Communication Protocol

When a rollback is executed:

1. **Free Tier**: Post to the project's GitHub Discussions under "Operations" with the rollback reason, affected version, and restored version.
2. **Production**: Open an incident in the incident management tool. Notify the on-call engineer. Post status to the #minio-ops Slack channel.

## Version Tagging Convention

Every MiniOp release follows semantic versioning. Docker images are tagged with the full semver and the Git SHA:

```
minio/api:1.4.2
minio/api:1.4.2-a3b4c5d
```

The semver tag is mutable (it can be repointed), but the SHA tag is immutable. Rollback always targets a SHA tag to guarantee reproducibility. The CI/CD pipeline stores a mapping of version to SHA in the `deployments` table:

```sql
CREATE TABLE deployments (
  id SERIAL PRIMARY KEY,
  version TEXT NOT NULL,
  git_sha TEXT NOT NULL,
  deployed_at TIMESTAMPTZ DEFAULT NOW(),
  deployed_by TEXT,
  migration_id TEXT,
  rollback_of INTEGER REFERENCES deployments(id)
);
```

This table is queried before any rollback to identify the exact image to restore and whether the target version included a database migration.

## Rollback Verification Checklist

After executing a rollback, run this verification checklist before declaring the rollback complete:

### Free Tier

```bash
# 1. Health endpoint returns expected version
curl -sf http://localhost:8080/health | jq .version
# Must match the rolled-back version (e.g., "1.4.1")

# 2. Database connectivity
curl -sf http://localhost:8080/health | jq .db
# Must return "connected"

# 3. Redis connectivity
curl -sf http://localhost:8080/health | jq .redis
# Must return "connected"

# 4. Worker is processing jobs
docker compose logs worker --tail=10 | grep "processing job"

# 5. No error spikes in logs
docker compose logs api --since=2m | grep -c "ERROR"
# Should be 0 or near-0
```

### Production

```bash
# 1. All pods are running and ready
kubectl get pods -n minio --no-headers | grep -v Running
# Should return empty

# 2. Health endpoint across all replicas
for pod in $(kubectl get pods -n minio -l app=minio-api -o name); do
  kubectl exec -n minio $pod -- curl -sf localhost:8080/health | jq .version
done

# 3. No recent restarts
kubectl get pods -n minio -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[0].restartCount}{"\n"}{end}'

# 4. Error rate is within baseline
curl -s 'http://prometheus:9090/api/v1/query?query=rate(http_requests_total{status=~"5.."}[5m])' | jq '.data.result[].value[1]'

# 5. Processing queue is draining
kubectl exec -n minio deploy/minio-scheduler -- curl -sf localhost:8080/api/internal/jobs/queue-depth | jq .
```

## Common Rollback Pitfalls

**Rolling back application code without considering pending jobs.** If the rolled-back version cannot process jobs queued by the newer version, those jobs will fail. Before rollback, check the job queue and either drain it or mark jobs for reprocessing.

**Forgetting to roll back feature flags.** If the new version introduced new feature flags that are enabled, rolling back the code does not disable the flags. When the old code version starts, it will not recognize the new flags, but Unleash will still report them as active. This is usually harmless (unrecognized flags are ignored), but it can cause confusion during debugging.

**Rolling back across a Redis schema change.** If the new version changed the format of data stored in Redis (e.g., job state serialization), the old version will fail to deserialize it. Flush Redis before rolling back, or ensure both versions use the same serialization format.

## Related Documents

- [02-database-rollback.md](./02-database-rollback.md) - Database migration rollback procedures
- [03-feature-flags.md](./03-feature-flags.md) - Feature flag kill switches and gradual rollout controls
