# MiniOp Business Continuity Plan

## Purpose

This document defines how MiniOp maintains service availability and recovers from disruptions. It covers continuity objectives, escalation procedures, communication plans, and recovery validation for both free-tier self-hosted deployments and production infrastructure.

## Service Level Objectives

### Free Tier

| Metric | Target | Measurement |
|---|---|---|
| Upload availability | 95% uptime | Users can upload videos |
| Processing throughput | Best effort | Clips rendered within 10 minutes |
| API availability | 95% uptime | REST endpoints respond |
| Data durability | 99.9% | No data loss on single disk failure |

### Production

| Metric | Target | Measurement |
|---|---|---|
| Upload availability | 99.9% uptime | Users can upload videos |
| Processing throughput | 1000 concurrent jobs | Queue depth < 5000 |
| API availability | 99.95% uptime | p99 latency < 500ms |
| Data durability | 99.999999999% | Cross-region replication |
| Recovery Time Objective | 5 minutes | Automated failover |
| Recovery Point Objective | 0 | Synchronous replication |

## Continuity Architecture

### Free Tier — Single Node Resilience

The free tier maximizes resilience within a single-node constraint:

```yaml
# docker-compose.yml — health checks and restart policies
version: '3.8'
services:
  api:
    image: minio/api:latest
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    deploy:
      resources:
        limits:
          memory: 2G
          cpus: '2.0'
        reservations:
          memory: 512M

  worker:
    image: minio/worker:latest
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "python", "-c", "import redis; r=redis.Redis(); r.ping()"]
      interval: 30s
      timeout: 5s
      retries: 3

  postgres:
    image: postgres:16
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U minio"]
      interval: 10s
      timeout: 5s
      retries: 5
    volumes:
      - pgdata:/var/lib/postgresql/data
    command: >
      postgres
        -c shared_preload_libraries=pg_stat_statements
        -c max_connections=100
        -c shared_buffers=256MB
        -c effective_cache_size=768MB
        -c maintenance_work_mem=64MB
        -c checkpoint_completion_target=0.9
        -c wal_buffers=16MB
        -c default_statistics_target=100

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 3
    command: >
      redis-server
        --save 900 1
        --save 300 10
        --appendonly yes
        --maxmemory 512mb
        --maxmemory-policy allkeys-lru

  nginx:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost/health"]
      interval: 15s
      timeout: 5s
      retries: 3
```

### Production — Multi-AZ with Automated Recovery

```yaml
# kubernetes/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: minio-api-hpa
  namespace: minio-prod
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: minio-api
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  - type: Pods
    pods:
      metric:
        name: jobs_queue_depth
      target:
        type: AverageValue
        averageValue: "100"
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 10
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
      - type: Percent
        value: 100
        periodSeconds: 15
```

## Incident Response Procedures

### Severity Levels

| Level | Description | Response Time | Example |
|---|---|---|---|
| SEV-1 | Complete service outage | 15 minutes | All uploads failing, database down |
| SEV-2 | Major feature degraded | 30 minutes | Processing queue stalled, 50% error rate |
| SEV-3 | Minor feature impacted | 2 hours | Thumbnail generation slow, one region affected |
| SEV-4 | Cosmetic / non-blocking | Next business day | Log noise, minor UI glitches |

### SEV-1 Response Runbook

```bash
# Step 1: Acknowledge the incident
# Update status page
curl -X POST "https://api.statuspage.io/v1/pages/$PAGE_ID/incidents" \
  -H "Authorization: OAuth $STATUSPAGE_TOKEN" \
  -d "incident[name]=Service Outage" \
  -d "incident[status]=investigating" \
  -d "incident[impact_override]=major"

# Step 2: Determine blast radius
# Check each component
docker compose ps  # Free tier
kubectl get pods -n minio-prod -o wide  # Production

# Step 3: Check recent deployments
kubectl rollout history deployment/minio-api -n minio-prod  # Production
git -C /opt/minio log --oneline -5  # Free tier

# Step 4: If recent deployment caused it, rollback
kubectl rollout undo deployment/minio-api -n minio-prod  # Production
cd /opt/minio && git revert HEAD && docker compose up -d --build  # Free tier

# Step 5: If infrastructure issue, follow DR runbook
# See disaster-recovery/01-dr-strategy.md

# Step 6: Communicate resolution
curl -X PATCH "https://api.statuspage.io/v1/pages/$PAGE_ID/incidents/$INCIDENT_ID" \
  -H "Authorization: OAuth $STATUSPAGE_TOKEN" \
  -d "incident[status]=resolved" \
  -d "incident[body]=Root cause identified and resolved. Post-mortem to follow."
```

### SEV-2: Queue Stalled

```bash
# Diagnose
kubectl exec -n minio-prod deploy/minio-api -- python manage.py queue_status

# Check Redis connectivity
kubectl exec -n minio-prod deploy/minio-api -- python -c "
import redis
r = redis.Redis(host='redis-sentinel', port=26379, socket_timeout=5)
print(f'Redis ping: {r.ping()}')
print(f'Queue depth: {r.llen(\"jobs:default\")}')
print(f'Processing: {r.llen(\"jobs:processing\")}')
"

# Check worker health
kubectl get pods -n minio-prod -l app=minio-worker -o wide

# Restart workers if stuck
kubectl rollout restart deployment/minio-worker -n minio-prod

# Requeue stalled jobs
kubectl exec -n minio-prod deploy/minio-api -- \
  python manage.py requeue_stale_jobs --older-than 5m
```

## Communication Matrix

| Audience | Channel | Timing | Owner |
|---|---|---|---|
| Internal team | Slack #incident-response | Immediate | On-call engineer |
| Customers | status.minio.dev | Within 15 min of SEV-1/2 | Incident commander |
| Enterprise customers | Direct email | Within 30 min of SEV-1 | Support lead |
| Post-mortem | Confluence | Within 48 hours | Incident commander |

## Continuity Testing Schedule

### Monthly Tests

```bash
# Backup restoration drill
#!/bin/bash
set -euo pipefail

echo "=== Monthly DR Test $(date) ==="

# 1. Restore PostgreSQL to staging
./scripts/restore-postgres-staging.sh

# 2. Verify data integrity
docker compose -f docker-compose.staging.yml exec api \
  python manage.py verify_data_integrity --full

# 3. Process a test video through the restored pipeline
docker compose -f docker-compose.staging.yml exec api \
  python manage.py process_test_video --verify-output

# 4. Measure restoration time
echo "Restoration completed in ${SECONDS} seconds"

# 5. Document results
echo "[$(date)] DR test: $([ $? -eq 0 ] && echo 'PASS' || echo 'FAIL')" \
  >> /var/log/minio/dr-tests.log
```

### Quarterly Tests

| Test | Procedure | Acceptance Criteria |
|---|---|---|
| Database failover | Kill primary, verify replica promotes | Automatic promotion < 30s |
| Storage failover | Block primary storage, verify redirect | No upload failures |
| Full stack recovery | Restore from backup, verify all services | All services healthy < 30 min |
| Load test after recovery | Run k6 against recovered stack | p99 < 500ms at 2x normal load |

### Annual Test

Full region failover: shift production traffic to DR region, run for 4 hours, shift back.

```bash
# Traffic shift via DNS
aws route53 change-resource-record-sets \
  --hosted-zone-id $ZONE_ID \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.minio.dev",
        "Type": "CNAME",
        "TTL": 60,
        "ResourceRecords": [{"Value": "api.dr-us-west.minio.dev"}]
      }
    }]
  }'
```

## Capacity Planning

Continuity requires headroom. Maintain:

- **Free tier**: 50% disk headroom, 50% memory headroom
- **Production**: N+2 redundancy for all stateless services, N+1 for stateful

```bash
# Check capacity
# Free tier
df -h /var/lib/docker
free -h

# Production
kubectl top nodes -n minio-prod
kubectl get pvc -n minio-prod -o custom-columns=NAME:.metadata.name,CAPACITY:.status.capacity.storage,USED:.status.capacity.storage
```

## Documentation Maintenance

This plan is reviewed and updated:
- After every SEV-1 or SEV-2 incident
- Quarterly as part of the DR testing cycle
- When infrastructure changes significantly (new region, database migration, etc.)

Last reviewed: 2026-06-20
Next scheduled review: 2026-09-20
