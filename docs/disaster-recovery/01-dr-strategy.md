# MiniOp Disaster Recovery Strategy

## Overview

MiniOp processes video uploads, performs AI-driven clip extraction, and serves rendered outputs to end users. A disaster affecting any layer — storage, compute, database, or AI inference — can halt the entire pipeline. This document defines the disaster recovery (DR) strategy for both free-tier single-node deployments and scaled production clusters.

## Threat Model

| Threat | Free Tier Impact | Production Impact | RTO Target | RPO Target |
|---|---|---|---|---|
| Primary disk failure | Complete outage | Partial degradation | 4 hours (manual) | 24 hours |
| Database corruption | Job history lost | Partial data loss | 1 hour | 1 hour |
| Storage backend failure | Uploads fail | Uploads fail | 30 minutes | 0 (replicated) |
| AI model corruption | Clips fail | Clips fail | 2 hours | 0 |
| Full region outage | N/A | Complete outage | 4 hours | 15 minutes |
| Ransomware / compromise | Complete loss | Complete loss | 8 hours | Last clean backup |

## Free Tier DR Strategy

The free tier runs as a single Docker Compose instance. Disaster recovery relies on scheduled backups and manual restoration.

### Architecture

```
┌─────────────────────────────┐
│  Single Node (Docker Compose)│
│  ┌───────┐ ┌──────┐ ┌─────┐│
│  │ MinIO │ │Postgres│ │Redis││
│  └───┬───┘ └───┬────┘ └──┬──┘│
│      └─────────┼─────────┘   │
│           S3-compatible      │
└─────────────────────────────┘
          │
    ┌─────▼──────┐
    │  cron backup │
    │  → /backups  │
    └─────┬──────┘
          │
    ┌─────▼──────────┐
    │  Remote (rclone) │
    │  → S3/GDrive/etc │
    └─────────────────┘
```

### Backup Schedule

```bash
# /etc/cron.d/minio-backup
# Full backup daily at 2 AM UTC
0 2 * * * root /opt/minio/scripts/backup.sh full
# Incremental every 6 hours
0 */6 * * * root /opt/minio/scripts/backup.sh incremental
# WAL archiving every 15 minutes (PostgreSQL)
*/15 * * * * root /opt/minio/scripts/archive-wal.sh
```

### DR Runbook — Free Tier

**Scenario: Disk failure or corruption detected**

1. Stop all services:
   ```bash
   cd /opt/minio && docker compose down
   ```

2. Provision replacement disk or reattach volume.

3. Restore database from latest backup:
   ```bash
   # Decompress and restore PostgreSQL
   gunzip -c /backups/postgres/latest.sql.gz | \
     docker compose exec -T postgres psql -U minio -d minio
   ```

4. Restore MinIO object storage:
   ```bash
   # Sync from backup location
   rclone sync /backups/minio/ minio-data/ --progress
   ```

5. Restore Redis state (optional — Redis is ephemeral for queue state):
   ```bash
   docker compose cp /backups/redis/dump.rdb redis:/data/dump.rdb
   docker compose restart redis
   ```

6. Verify integrity:
   ```bash
   docker compose up -d
   docker compose exec api python manage.py check --deploy
   docker compose exec api python manage.py verify_storage_integrity
   ```

7. Requeue any jobs that were in-flight:
   ```bash
   docker compose exec api python manage.py requeue_stale_jobs --older-than 30m
   ```

## Production DR Strategy

Production runs across multiple availability zones with automated failover.

### Architecture

```
┌──────────── AZ-1 ────────────┐  ┌──────────── AZ-2 ────────────┐
│  ┌─────────┐  ┌───────────┐  │  │  ┌─────────┐  ┌───────────┐  │
│  │ App (3) │  │ Postgres  │  │  │  │ App (3) │  │ Postgres  │  │
│  └────┬────┘  │ Primary   │  │  │  └────┬────┘  │ Replica   │  │
│       │       └─────┬─────┘  │  │       │       └─────┬─────┘  │
│  ┌────▼────┐        │        │  │  ┌────▼────┐        │        │
│  │  MinIO  │────────┼────────│  │  │  MinIO  │        │        │
│  │ Primary │        │        │  │  │ Replica │        │        │
│  └─────────┘        │        │  │  └─────────┘        │        │
└─────────────────────┼────────┘  └─────────────────────┼────────┘
                      │                                  │
              ┌───────▼──────────────────────────────────▼───┐
              │           Shared WAL Archive (S3)             │
              └──────────────────────────────────────────────┘
```

### Failover Procedure — Automated

```yaml
# kubernetes/dr-failover.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: dr-failover-script
data:
  failover.sh: |
    #!/bin/bash
    set -euo pipefail

    PRIMARY_PG="pg-primary.minio-prod.svc.cluster.local"
    REPLICA_PG="pg-replica.minio-prod.svc.cluster.local"

    # Check primary health
    if ! pg_isready -h "$PRIMARY_PG" -U minio -t 5; then
      echo "Primary unreachable. Promoting replica..."
      
      # Promote replica to primary
      kubectl exec -n minio-prod statefulset/pg-replica -- \
        pg_ctl promote -D /var/lib/postgresql/data
      
      # Update service endpoint
      kubectl patch svc pg-primary -n minio-prod \
        -p '{"spec":{"selector":{"role":"replica"}}}'
      
      # Restart app pods to reconnect
      kubectl rollout restart deployment/minio-api -n minio-prod
      
      # Notify ops team
      curl -X POST "$SLACK_WEBHOOK" \
        -d '{"text":"[DR] PostgreSQL failover completed. Replica promoted to primary."}'
      
      echo "Failover complete."
    else
      echo "Primary healthy. No action needed."
    fi
```

### Failover Procedure — Manual

When automated failover fails or you need controlled switchover:

```bash
# 1. Verify replica is caught up
kubectl exec -n minio-prod pg-replica-0 -- \
  psql -U minio -c "SELECT now() - pg_last_xact_replay_timestamp() AS lag;"

# If lag > 30 seconds, wait or force checkpoint
kubectl exec -n minio-prod pg-replica-0 -- \
  psql -U minio -c "CHECKPOINT;"

# 2. Stop writes to primary
kubectl scale deployment/minio-api -n minio-prod --replicas=0

# 3. Promote replica
kubectl exec -n minio-prod pg-replica-0 -- \
  pg_ctl promote -D /var/lib/postgresql/data

# 4. Point services to new primary
kubectl patch svc pg-primary -n minio-prod \
  -p '{"spec":{"selector":{"statefulset.kubernetes.io/pod-name":"pg-replica-0"}}}'

# 5. Bring app back
kubectl scale deployment/minio-api -n minio-prod --replicas=6

# 6. Verify
kubectl exec -n minio-prod deploy/minio-api -- \
  python manage.py check --deploy --db-primary
```

### RTO/RPO by Tier

| Component | Free Tier RTO | Free Tier RPO | Prod RTO | Prod RPO |
|---|---|---|---|---|
| PostgreSQL | 1 hour | 6 hours | 30 seconds | 0 (sync replica) |
| MinIO Storage | 2 hours | 24 hours | 0 (erasure coding) | 0 |
| Redis Queue | 15 minutes | Loss of in-flight | 0 (Sentinel) | 0 |
| AI Inference | 4 hours | N/A | 30 seconds (pod reschedule) | N/A |
| Full Stack | 4 hours | 24 hours | 5 minutes | 0 |

## Communication Plan

During a disaster event:

1. **Detection** → PagerDuty alert fires (production) or manual detection (free tier)
2. **Triage** → On-call engineer assesses scope, declares DR level (1-3)
3. **Execution** → Runbook followed, status page updated at status.minio.dev
4. **Resolution** → Services restored, post-mortem scheduled within 48 hours

DR Level 1: Single component degraded, automated recovery expected.
DR Level 2: Multiple components affected, manual intervention required.
DR Level 3: Full site down, DR site activation considered.

## Testing This Strategy

DR plans that aren't tested fail. Run these drills:

- **Monthly**: Restore a random backup to staging, verify data integrity
- **Quarterly**: Simulate primary DB failure in staging, execute full failover
- **Annually**: Full region failover drill with production traffic shadow

See `03-business-continuity.md` for the full testing schedule and acceptance criteria.
