# MiniOp Backup and Recovery Procedures

## Backup Architecture

MiniOp has three stateful components requiring backup: PostgreSQL (job metadata, user accounts, billing), MinIO-compatible object storage (uploaded videos, rendered clips, thumbnails), and Redis (queue state, rate limit counters, session data). Each has different backup characteristics and recovery requirements.

## PostgreSQL Backup

### Free Tier — pg_dump with Cron

```bash
#!/bin/bash
# /opt/minio/scripts/backup-postgres.sh
set -euo pipefail

BACKUP_DIR="/backups/postgres"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=30

mkdir -p "$BACKUP_DIR"

# Full logical backup
docker compose -f /opt/minio/docker-compose.yml exec -T postgres \
  pg_dump -U minio -d minio \
  --format=custom \
  --compress=6 \
  --verbose \
  > "$BACKUP_DIR/minio_${TIMESTAMP}.dump"

# Verify backup integrity
docker compose -f /opt/minio/docker-compose.yml exec -T postgres \
  pg_restore -l "$BACKUP_DIR/minio_${TIMESTAMP}.dump" > /dev/null 2>&1

if [ $? -eq 0 ]; then
  echo "[$TIMESTAMP] Backup verified OK" >> "$BACKUP_DIR/backup.log"
else
  echo "[$TIMESTAMP] BACKUP VERIFICATION FAILED" >> "$BACKUP_DIR/backup.log"
  exit 1
fi

# Prune old backups
find "$BACKUP_DIR" -name "*.dump" -mtime +${RETENTION_DAYS} -delete

# Upload to remote
rclone copy "$BACKUP_DIR/minio_${TIMESTAMP}.dump" \
  remote:minio-backups/postgres/ \
  --progress
```

### Production — WAL Archiving with Continuous Archival

```yaml
# postgresql.conf additions for production
wal_level = replica
archive_mode = on
archive_command = 'aws s3 cp %p s3://minio-wal-archive/%f --storage-class STANDARD_IA'
archive_timeout = 300
max_wal_senders = 3
wal_keep_size = '2GB'
```

```bash
#!/bin/bash
# Production backup via pg_basebackup + WAL
set -euo pipefail

S3_BUCKET="s3://minio-postgres-backups"
WAL_BUCKET="s3://minio-wal-archive"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Base backup (weekly full)
pg_basebackup -h pg-primary.minio-prod.svc.cluster.local \
  -U replicator \
  -D /tmp/base_${TIMESTAMP} \
  --format=tar \
  --gzip \
  --checkpoint=fast \
  --wal-method=stream \
  --progress

# Upload base backup
aws s3 sync /tmp/base_${TIMESTAMP}/ \
  "${S3_BUCKET}/base_${TIMESTAMP}/" \
  --storage-class STANDARD_IA

# Cleanup local
rm -rf /tmp/base_${TIMESTAMP}

# Retention: keep 4 weekly, 12 monthly
aws s3 ls "${S3_BUCKET}/" | \
  awk '{print $2}' | \
  sort | \
  head -n -16 | \
  xargs -I {} aws s3 rm "${S3_BUCKET}/{}" --recursive
```

### Recovery — PostgreSQL

**Scenario 1: Restore to latest point in time (free tier)**

```bash
# Stop the application
cd /opt/minio && docker compose stop api worker

# Drop and recreate the database
docker compose exec postgres psql -U minio -c "DROP DATABASE minio;"
docker compose exec postgres psql -U minio -c "CREATE DATABASE minio;"

# Restore from backup
docker compose exec -T postgres \
  pg_restore -U minio -d minio \
  --clean --if-exists \
  --verbose \
  /backups/postgres/minio_20260620_020000.dump

# Restart
docker compose start api worker
```

**Scenario 2: Point-in-time recovery (production)**

```bash
# 1. Stop primary
kubectl scale statefulset/pg-primary -n minio-prod --replicas=0

# 2. Provision new volume from snapshot
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pg-recovery
  namespace: minio-prod
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 500Gi
  dataSource:
    name: pg-snapshot-latest
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
EOF

# 3. Create recovery instance
kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: pg-recovery
  namespace: minio-prod
spec:
  serviceName: pg-recovery
  replicas: 1
  selector:
    matchLabels:
      app: pg-recovery
  template:
    metadata:
      labels:
        app: pg-recovery
    spec:
      containers:
      - name: postgres
        image: postgres:16
        env:
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: pg-recovery
EOF

# 4. Configure recovery to specific time
kubectl exec -n minio-prod pg-recovery-0 -- bash -c "
cat > /var/lib/postgresql/data/pgdata/recovery.signal <<SIGNAL
restore_command = 'aws s3 cp s3://minio-wal-archive/%f %p'
recovery_target_time = '2026-06-20 14:30:00+00'
recovery_target_action = 'promote'
SIGNAL
"

# 5. Start recovery
kubectl exec -n minio-prod pg-recovery-0 -- pg_ctl start -D /var/lib/postgresql/data/pgdata

# 6. Verify
kubectl exec -n minio-prod pg-recovery-0 -- \
  psql -U minio -c "SELECT count(*) FROM jobs WHERE created_at < '2026-06-20 14:30:00';"

# 7. Promote and redirect traffic
kubectl exec -n minio-prod pg-recovery-0 -- \
  pg_ctl promote -D /var/lib/postgresql/data/pgdata
```

## MinIO Object Storage Backup

### Free Tier — mc mirror

```bash
#!/bin/bash
# /opt/minio/scripts/backup-minio.sh
set -euo pipefail

SOURCE="local/minio-data"
BACKUP_DIR="/backups/minio"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$BACKUP_DIR/$TIMESTAMP"

# Mirror all buckets
mc mirror --overwrite "$SOURCE/uploads" "$BACKUP_DIR/$TIMESTAMP/uploads/"
mc mirror --overwrite "$SOURCE/clips" "$BACKUP_DIR/$TIMESTAMP/clips/"
mc mirror --overwrite "$SOURCE/thumbnails" "$BACKUP_DIR/$TIMESTAMP/thumbnails/"

# Upload to remote
rclone sync "$BACKUP_DIR/$TIMESTAMP/" remote:minio-backups/storage/$TIMESTAMP/

# Prune local (keep last 3)
ls -dt /backups/minio/*/ | tail -n +4 | xargs rm -rf
```

### Production — Cross-Region Replication

```json
// minio-replication-config.json
{
  "role": "arn:aws:iam::minio:role/replication-role",
  "rules": [
    {
      "ID": "replicate-all",
      "Status": "Enabled",
      "Priority": 1,
      "DeleteMarkerReplication": { "Status": "Enabled" },
      "Filter": { "Prefix": "" },
      "Destination": {
        "Bucket": "arn:aws:s3:::minio-backup-us-west",
        "StorageClass": "STANDARD_IA",
        "ReplicationTime": {
          "Status": "Enabled",
          "Time": { "Minutes": 15 }
        },
        "Metrics": {
          "Status": "Enabled",
          "EventThreshold": { "Minutes": 15 }
        }
      }
    }
  ]
}
```

```bash
# Enable versioning (required for replication)
mc version enable local/minio-data

# Set replication policy
mc replicate add local/minio-data \
  --remote-bucket "https://backup-cluster:9000/minio-backup" \
  --replicate "delete,delete-marker,existing-objects"

# Monitor replication lag
mc replicate status local/minio-data
```

### Recovery — MinIO

```bash
# Free tier: restore from backup
mc mirror --overwrite /backups/minio/latest/uploads/ local/minio-data/uploads/
mc mirror --overwrite /backups/minio/latest/clips/ local/minio-data/clips/

# Production: failover to backup cluster
# Update application config to point to backup endpoint
kubectl set env deployment/minio-api \
  MINIO_ENDPOINT=minio-backup.us-west-2.internal:9000 \
  -n minio-prod
```

## Redis Backup

Redis is used for job queues and ephemeral state. In MiniOp, queue state is the critical part — lost jobs can be requeued from PostgreSQL.

### Free Tier

```bash
# Redis RDB snapshot (default every 15 min, configure in redis.conf)
# docker-compose.yml redis section:
#   command: redis-server --save 900 1 --save 300 10 --appendonly yes

# Backup script
docker compose exec redis redis-cli BGSAVE
sleep 5
docker compose cp redis:/data/dump.rdb /backups/redis/dump_$(date +%Y%m%d_%H%M%S).rdb
```

### Production

Production uses Redis Sentinel with AOF persistence. Redis is treated as ephemeral — on recovery, jobs are requeued from PostgreSQL.

```bash
# Requeue lost jobs after Redis recovery
docker compose exec api python manage.py requeue_stale_jobs \
  --older-than 10m \
  --status processing \
  --dry-run  # Remove --dry-run to execute
```

## Backup Monitoring

```python
# monitoring/backup_monitor.py
import os
import datetime
from prometheus_client import Gauge

BACKUP_AGE_HOURS = Gauge(
    'minio_backup_age_hours',
    'Age of latest backup in hours',
    ['component']
)

def check_backup_freshness():
    components = {
        'postgres': '/backups/postgres/',
        'minio': '/backups/minio/',
        'redis': '/backups/redis/',
    }
    
    for component, path in components.items():
        latest = max(
            (os.path.getmtime(os.path.join(path, f)) 
             for f in os.listdir(path) 
             if os.path.isfile(os.path.join(path, f))),
            default=0
        )
        age_hours = (datetime.datetime.now().timestamp() - latest) / 3600
        BACKUP_AGE_HOURS.labels(component=component).set(age_hours)
        
        if age_hours > 24:
            alert_ops_team(component, age_hours)
```

Alert thresholds:
- PostgreSQL backup > 6 hours old (free tier) / > 1 hour (production)
- MinIO backup > 24 hours old (free tier) / replication lag > 15 min (production)
- Redis backup > 1 hour old
