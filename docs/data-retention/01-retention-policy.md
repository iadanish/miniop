# MiniOp Data Retention Policy

## Overview

MiniOp processes video content, generates AI-driven clips, and stores user media across multiple storage tiers. This policy defines how long each data category persists, what triggers retention changes, and how the system enforces these rules automatically. The policy applies to both the free-tier single-node deployment and the scaled production multi-region setup.

## Data Classification

MiniOp categorizes all stored data into five classes:

| Class | Description | Examples | Free Tier Retention | Production Retention |
|-------|-------------|----------|--------------------|--------------------|
| **Source Media** | Original uploaded videos | MP4, MOV, MKV files | 30 days | 90 days |
| **Derived Clips** | AI-generated clips and edits | Short clips, thumbnails, transcripts | 30 days | 90 days |
| **Metadata** | Processing logs, scene analysis, embeddings | JSON manifests, vector embeddings | 90 days | 365 days |
| **User Account** | Profile, preferences, billing | Email, API keys, subscription tier | Account lifetime | Account lifetime + 30 days |
| **Audit Logs** | Access logs, API calls, admin actions | Structured log entries | 14 days | 180 days |

## Free Tier Implementation

The free tier runs on a single node with local disk storage and Supabase PostgreSQL. Retention enforcement uses a scheduled cron job that runs daily at 03:00 UTC.

### Configuration

Set retention periods in `config/retention.yaml`:

```yaml
retention:
  source_media:
    days: 30
    action: delete  # delete | archive
  derived_clips:
    days: 30
    action: delete
  metadata:
    days: 90
    action: delete
  user_account:
    days: -1  # -1 means account lifetime
    action: anonymize_on_deletion
  audit_logs:
    days: 14
    action: delete

storage:
  type: local
  path: /var/minio-op/media
  database_url: postgresql://postgres:[password]@db.[project-ref].supabase.co:5432/postgres
```

### Retention Enforcement Script

The `retention-worker` service queries the database for expired records and removes associated files:

```python
# services/retention_worker.py
import os
import psycopg2
from datetime import datetime, timedelta, timezone
from pathlib import Path

MEDIA_ROOT = Path("/var/minio-op/media")

def get_expired_records(conn, table, retention_days):
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT id, file_path FROM {table} WHERE created_at < %s AND deleted_at IS NULL",
            (cutoff,)
        )
        return cur.fetchall()

def delete_media_file(file_path: str):
    full_path = MEDIA_ROOT / file_path
    if full_path.exists():
        full_path.unlink()
        return True
    return False

def run_retention_cycle():
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        for table, days in [
            ("source_media", 30),
            ("derived_clips", 30),
            ("audit_logs", 14),
        ]:
            records = get_expired_records(conn, table, days)
            for record_id, file_path in records:
                if file_path:
                    delete_media_file(file_path)
                with conn.cursor() as cur:
                    cur.execute(
                        f"UPDATE {table} SET deleted_at = NOW() WHERE id = %s",
                        (record_id,)
                    )
            conn.commit()
            print(f"[retention] {table}: marked {len(records)} records as deleted")
    finally:
        conn.close()
```

### Crontab Entry

```
0 3 * * * /usr/bin/python3 /opt/minio-op/services/retention_worker.py >> /var/log/minio-op/retention.log 2>&1
```

### PostgreSQL Schema Support

Each table with retention requirements includes a `deleted_at` column and an index for efficient queries:

```sql
ALTER TABLE source_media ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_source_media_retention ON source_media(created_at) WHERE deleted_at IS NULL;

ALTER TABLE derived_clips ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_derived_clips_retention ON derived_clips(created_at) WHERE deleted_at IS NULL;

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_audit_logs_retention ON audit_logs(created_at) WHERE deleted_at IS NULL;
```

## Scaled Production Implementation

Production uses object storage (S3-compatible), PostgreSQL with read replicas, and a distributed task queue. Retention enforcement moves from a cron job to a Celery worker that processes retention batches in parallel.

### Storage Lifecycle Configuration

S3 lifecycle policies handle the first pass of retention without any application code:

```json
{
  "Rules": [
    {
      "ID": "source-media-retention",
      "Filter": { "Prefix": "source-media/" },
      "Status": "Enabled",
      "Expiration": { "Days": 90 },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 7 }
    },
    {
      "ID": "derived-clips-retention",
      "Filter": { "Prefix": "derived-clips/" },
      "Status": "Enabled",
      "Expiration": { "Days": 90 }
    },
    {
      "ID": "temp-uploads-cleanup",
      "Filter": { "Prefix": "temp-uploads/" },
      "Status": "Enabled",
      "Expiration": { "Days": 1 }
    }
  ]
}
```

Apply this via the AWS CLI:

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket minioop-production-media \
  --lifecycle-configuration file://s3-lifecycle.json
```

### Celery Retention Worker

The production worker processes retention in configurable batch sizes to avoid overwhelming the database or storage backend:

```python
# workers/retention/tasks.py
from celery import Celery
from datetime import datetime, timedelta, timezone
import boto3

app = Celery("retention", broker="redis://redis:6379/2")

RETENTION_CONFIG = {
    "source_media": {"days": 90, "bucket": "minioop-production-media", "prefix": "source-media/"},
    "derived_clips": {"days": 90, "bucket": "minioop-production-media", "prefix": "derived-clips/"},
    "metadata": {"days": 365, "bucket": "minioop-production-meta", "prefix": "metadata/"},
    "audit_logs": {"days": 180, "bucket": None, "prefix": None},
}

@app.task(queue="retention")
def enforce_retention(data_class: str, batch_size: int = 500):
    config = RETENTION_CONFIG[data_class]
    cutoff = datetime.now(timezone.utc) - timedelta(days=config["days"])

    conn = get_db_connection()
    records = fetch_expired_batch(conn, data_class, cutoff, batch_size)

    s3 = boto3.client("s3") if config["bucket"] else None
    deleted = 0

    for record in records:
        if s3 and record.get("storage_key"):
            s3.delete_object(Bucket=config["bucket"], Key=record["storage_key"])
        soft_delete_record(conn, data_class, record["id"])
        deleted += 1

    conn.commit()
    return {"data_class": data_class, "deleted": deleted}

@app.task(queue="retention")
def schedule_daily_retention():
    for data_class in RETENTION_CONFIG:
        enforce_retention.delay(data_class)
```

### Kubernetes CronJob

In production, the retention scheduler runs as a Kubernetes CronJob:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: minioop-retention-scheduler
  namespace: minioop
spec:
  schedule: "0 3 * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: retention-scheduler
              image: minioop/workers:latest
              command: ["celery", "-A", "workers.retention.tasks", "call", "schedule_daily_retention"]
              env:
                - name: DATABASE_URL
                  valueFrom:
                    secretKeyRef:
                      name: minioop-secrets
                      key: database-url
                - name: REDIS_URL
                  valueFrom:
                    secretKeyRef:
                      name: minioop-secrets
                      key: redis-url
          restartPolicy: OnFailure
```

## GDPR and Compliance Considerations

Under GDPR Article 17 (Right to Erasure), users can request immediate deletion of all their data. This overrides standard retention periods. MiniOp handles this through the data deletion pipeline documented in `03-data-deletion.md`.

Retention policies must account for legal holds. If litigation or a regulatory audit requires preserving data beyond the standard retention period, the `legal_hold` flag on affected records prevents the retention worker from processing them:

```sql
UPDATE source_media SET legal_hold = TRUE WHERE user_id = 'affected-user-uuid';
```

The retention worker checks this flag:

```python
cur.execute(
    "SELECT id, file_path FROM source_media "
    "WHERE created_at < %s AND deleted_at IS NULL AND legal_hold = FALSE",
    (cutoff,)
)
```

## Monitoring and Alerting

Track retention worker health with Prometheus metrics:

```python
from prometheus_client import Counter, Histogram

RETENTION_DELETED = Counter("minioop_retention_deleted_total", "Records deleted by retention", ["data_class"])
RETENTION_DURATION = Histogram("minioop_retention_duration_seconds", "Retention cycle duration", ["data_class"])
RETENTION_ERRORS = Counter("minioop_retention_errors_total", "Retention processing errors", ["data_class"])
```

Alert when the retention worker fails to run for more than 48 hours:

```yaml
# prometheus/alerts.yml
groups:
  - name: minioop-retention
    rules:
      - alert: RetentionWorkerStale
        expr: time() - min(minioop_retention_last_run_timestamp) > 172800
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Retention worker has not run in 48+ hours"
```

## Retention Policy Changes

When adjusting retention periods, apply changes in this order:

1. Update `config/retention.yaml` (free tier) or the `RETENTION_CONFIG` dict (production).
2. If shortening retention, run an immediate manual cycle to clean up records that would now be expired.
3. If extending retention, no immediate action needed—existing records remain until the new cutoff.
4. Document the change in the audit log and notify affected users if the change reduces their data retention window.

Never shorten retention below 7 days without legal review. The 7-day floor gives the engineering team time to respond if a deletion proves unintended.
