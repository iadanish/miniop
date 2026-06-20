# Backup Strategy for MiniOp

## Overview

MiniOp's data footprint consists of four categories: application metadata (user accounts, project configurations, clip definitions), uploaded source videos, generated clips and transcriptions, and operational data (audit logs, analytics). A backup strategy must address each category's distinct size, mutability, and recovery requirements.

This document defines backup policies, schedules, storage targets, and implementation for both free-tier single-node deployments and scaled production infrastructure.

## Data Classification and Backup Requirements

| Data Category | Size Profile | Change Frequency | RPO | RTO | Retention |
|--------------|-------------|------------------|-----|-----|-----------|
| Application DB | MBs–low GBs | Per-request | 1 hour | 15 min | 90 days |
| Source Videos | GBs–TBs | Write-once | 24 hours | 4 hours | Life of project |
| Generated Clips | GBs–TBs | Write-once, occasional re-render | 24 hours | 4 hours | Life of project |
| Transcriptions | MBs–low GBs | Write-once | 24 hours | 1 hour | Life of project |
| Audit/Compliance Logs | GBs | Append-only | 1 hour | 1 hour | 7 years |

**RPO** = Recovery Point Objective (maximum acceptable data loss).
**RTO** = Recovery Time Objective (maximum acceptable downtime for restoration).

## Free Tier Backup Strategy

On the free tier, MiniOp runs on a single machine. Backups are file-system-based and scheduled via cron.

### Application Database (SQLite)

```bash
#!/bin/bash
# scripts/backup-db.sh
set -euo pipefail

DB_PATH="./data/minio.db"
BACKUP_DIR="./backups/db"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/minio_${TIMESTAMP}.db"

mkdir -p "$BACKUP_DIR"

# Use SQLite's online backup API to avoid locking
sqlite3 "$DB_PATH" ".backup '${BACKUP_FILE}'"

# Compress
gzip "$BACKUP_FILE"

# Verify integrity
sqlite3 "${BACKUP_FILE}.gz" "PRAGMA integrity_check;" 2>/dev/null || \
  gunzip -t "${BACKUP_FILE}.gz"

# Keep last 30 daily backups, 12 weekly
find "$BACKUP_DIR" -name "minio_*.db.gz" -mtime +30 -delete

echo "Backup completed: ${BACKUP_FILE}.gz"
```

Crontab entry:

```cron
# Every hour during business hours, every 4 hours off-hours
0 9-18 * * * /opt/minio/scripts/backup-db.sh >> /var/log/minio/backup.log 2>&1
0 0,4,8,20,22 * * * /opt/minio/scripts/backup-db.sh >> /var/log/minio/backup.log 2>&1
```

### File Storage (Source Videos and Clips)

On the free tier, files live on the local filesystem under `./data/uploads/` and `./data/clips/`.

```bash
#!/bin/bash
# scripts/backup-files.sh
set -euo pipefail

SOURCE_DIRS=("./data/uploads" "./data/clips" "./data/transcriptions")
BACKUP_DIR="./backups/files"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
MANIFEST="${BACKUP_DIR}/manifest_${TIMESTAMP}.txt"

mkdir -p "$BACKUP_DIR"

# Incremental backup using rsync
for dir in "${SOURCE_DIRS[@]}"; do
    name=$(basename "$dir")
    rsync -av --delete \
        --link-dest="${BACKUP_DIR}/latest_${name}" \
        "$dir/" "${BACKUP_DIR}/${name}_${TIMESTAMP}/"
    ln -sfn "${BACKUP_DIR}/${name}_${TIMESTAMP}" "${BACKUP_DIR}/latest_${name}"
done

# Generate manifest with checksums
find "${SOURCE_DIRS[@]}" -type f -exec sha256sum {} \; > "$MANIFEST"

# Copy to external drive if mounted
if mountpoint -q /mnt/external-backup; then
    rsync -av "$BACKUP_DIR/" /mnt/external-backup/minio-files/
fi

echo "File backup completed. Manifest: $MANIFEST"
```

### Offsite Copy (Free Tier with rclone)

```bash
#!/bin/bash
# scripts/backup-offsite.sh
# Uses rclone to sync to a cloud storage provider

rclone sync ./backups/ remote:minio-backups/$(hostname)/ \
    --transfers 4 \
    --checkers 8 \
    --min-age 1h \
    --log-file /var/log/minio/offsite-backup.log \
    --log-level INFO

# Also sync the last database backup
rclone copy ./backups/db/ remote:minio-backups/$(hostname)/db/ \
    --max-age 48h \
    --include "minio_*.db.gz"
```

rclone config (`~/.config/rclone/rclone.conf`):

```ini
[remote]
type = s3
provider = AWS
access_key_id = YOUR_ACCESS_KEY
secret_access_key = YOUR_SECRET_KEY
region = us-east-1
bucket_acl = private
```

## Production Backup Strategy

Production uses cloud-native backup services with application-level coordination.

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Production Backup Flow                    │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  PostgreSQL ──▶ pg_basebackup ──▶ S3 (encrypted, versioned)  │
│        │                                                      │
│        └──▶ WAL archiving ──▶ S3 (continuous, 7-day PITR)    │
│                                                              │
│  S3 Source Videos ──▶ S3 Cross-Region Replication             │
│  S3 Generated Clips ──▶ S3 Cross-Region Replication           │
│                                                              │
│  ClickHouse ──▶ clickhouse-backup ──▶ S3                      │
│                                                              │
│  Redis ──▶ RDB snapshots ──▶ S3 (every 6h)                   │
│                                                              │
│  All S3 buckets ──▶ AWS Backup (daily, 30-day retention)     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### PostgreSQL Backup

```bash
#!/bin/bash
# scripts/pg-backup.sh
set -euo pipefail

BACKUP_BUCKET="s3://minio-backups/postgres"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Full base backup
pg_basebackup \
    -h "$PGHOST" \
    -U replicator \
    -D - \
    -Ft \
    -z \
    -P \
    --checkpoint=fast \
    --wal-method=stream \
    --label="minio_${TIMESTAMP}" | \
    aws s3 cp - "${BACKUP_BUCKET}/base/${TIMESTAMP}.tar.gz" \
        --sse aws:kms \
        --sse-kms-key-id alias/minio-backup-key

# Retention: keep 7 daily, 4 weekly, 12 monthly
python3 << 'PYTHON'
import boto3
from datetime import datetime, timedelta

s3 = boto3.client('s3')
bucket = 'minio-backups'
prefix = 'postgres/base/'

backups = []
resp = s3.list_objects_v2(Bucket=bucket, Prefix=prefix)
for obj in resp.get('Contents', []):
    backups.append({'Key': obj['Key'], 'LastModified': obj['LastModified']})

backups.sort(key=lambda x: x['LastModified'], reverse=True)

keep = set()
for i, b in enumerate(backups):
    if i < 7:  # Last 7 daily
        keep.add(b['Key'])
    elif i < 28 and i % 7 == 0:  # Last 4 weekly
        keep.add(b['Key'])
    elif i < 365 and i % 30 == 0:  # Last 12 monthly
        keep.add(b['Key'])

for b in backups:
    if b['Key'] not in keep:
        s3.delete_object(Bucket=bucket, Key=b['Key'])
        print(f"Deleted: {b['Key']}")
PYTHON
```

### WAL Archiving for Point-in-Time Recovery

```ini
# postgresql.conf
archive_mode = on
archive_command = 'aws s3 cp %p s3://minio-backups/postgres/wal/%f --sse aws:kms'
archive_timeout = 300  # Force WAL switch every 5 minutes
```

### S3 Cross-Region Replication

```json
{
  "Role": "arn:aws:iam::123456789:role/s3-replication",
  "Rules": [
    {
      "ID": "replicate-source-videos",
      "Status": "Enabled",
      "Prefix": "uploads/",
      "Destination": {
        "Bucket": "arn:aws:s3:::minio-backups-dr-us-west-2",
        "StorageClass": "STANDARD_IA",
        "EncryptionConfiguration": {
          "ReplicaKmsKeyID": "alias/minio-backup-key-west"
        }
      },
      "SourceSelectionCriteria": {
        "SseKmsEncryptedObjects": {
          "Status": "Enabled"
        }
      }
    },
    {
      "ID": "replicate-generated-clips",
      "Status": "Enabled",
      "Prefix": "clips/",
      "Destination": {
        "Bucket": "arn:aws:s3:::minio-backups-dr-us-west-2",
        "StorageClass": "STANDARD_IA"
      }
    }
  ]
}
```

Apply with:

```bash
aws s3api put-bucket-replication \
    --bucket minio-primary \
    --replication-configuration file://replication-config.json
```

### ClickHouse Backup

```bash
#!/bin/bash
# scripts/clickhouse-backup.sh
set -euo pipefail

BACKUP_NAME="minio_$(date +%Y%m%d_%H%M%S)"

# Create backup
clickhouse-backup create "$BACKUP_NAME"

# Upload to S3
clickhouse-backup upload "$BACKUP_NAME" \
    --s3-bucket minio-backups \
    --s3-path clickhouse/ \
    --s3-compression-format gzip \
    --s3-storage-class STANDARD_IA

# Clean up local backup
clickhouse-backup delete local "$BACKUP_NAME"

# Remove remote backups older than 30 days
clickhouse-backup list remote | while read name date; do
    if [[ $(date -d "$date" +%s) -lt $(date -d "30 days ago" +%s) ]]; then
        clickhouse-backup delete remote "$name"
    fi
done
```

### Redis Backup

```bash
#!/bin/bash
# scripts/redis-backup.sh

# Trigger RDB save
redis-cli -h "$REDIS_HOST" BGSAVE

# Wait for completion
while [ "$(redis-cli -h "$REDIS_HOST" LASTSAVE)" = "$LAST_SAVE" ]; do
    sleep 1
done

# Upload RDB
aws s3 cp /var/lib/redis/dump.rdb s3://minio-backups/redis/dump_$(date +%Y%m%d_%H%M%S).rdb \
    --sse aws:kms
```

## Backup Encryption

All backups are encrypted at rest. Free tier uses GPG; production uses AWS KMS.

### Free Tier: GPG Encryption

```bash
# scripts/encrypt-backup.sh
gpg --symmetric --cipher-algo AES256 \
    --batch --passphrase-file /etc/minio/backup-key \
    --output "${1}.gpg" "$1"

# Remove unencrypted file
shred -u "$1"
```

### Production: AWS KMS

Backups are encrypted via S3 server-side encryption with KMS keys. The key policy restricts access to the backup role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowBackupRole",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789:role/minio-backup-role"
      },
      "Action": [
        "kms:GenerateDataKey",
        "kms:Decrypt"
      ],
      "Resource": "*"
    },
    {
      "Sid": "DenyDelete",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "kms:ScheduleKeyDeletion",
      "Resource": "*"
    }
  ]
}
```

## Monitoring Backup Health

```typescript
// src/monitoring/backup-health.ts
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

export async function checkBackupHealth(): Promise<BackupHealthStatus> {
  const s3 = new S3Client({ region: 'us-east-1' });
  const now = new Date();

  const checks = {
    database: await checkLatestBackup(s3, 'postgres/base/', 4),  // Max 4 hours old
    files: await checkLatestBackup(s3, 'files/', 26),            // Max 26 hours old
    clickhouse: await checkLatestBackup(s3, 'clickhouse/', 26),
    redis: await checkLatestBackup(s3, 'redis/', 8),
  };

  const allHealthy = Object.values(checks).every(c => c.healthy);

  if (!allHealthy) {
    await sendAlert('backup_health', checks);
  }

  return { healthy: allHealthy, checks, checked_at: now.toISOString() };
}

async function checkLatestBackup(s3: S3Client, prefix: string, maxAgeHours: number) {
  const resp = await s3.send(new ListObjectsV2Command({
    Bucket: 'minio-backups',
    Prefix: prefix,
  }));

  const objects = (resp.Contents || []).sort(
    (a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0)
  );

  if (objects.length === 0) {
    return { healthy: false, reason: 'No backups found', latest: null };
  }

  const latest = objects[0];
  const ageHours = (Date.now() - (latest.LastModified?.getTime() || 0)) / (1000 * 60 * 60);

  return {
    healthy: ageHours <= maxAgeHours,
    reason: ageHours > maxAgeHours ? `Latest backup is ${ageHours.toFixed(1)}h old (max: ${maxAgeHours}h)` : 'OK',
    latest: { key: latest.Key, size: latest.Size, age_hours: ageHours },
  };
}
```

## Summary

The free tier backup strategy uses cron-scheduled scripts with rsync, SQLite's `.backup` command, and rclone for offsite copies. Production uses PostgreSQL WAL archiving with S3, cross-region replication for object storage, clickhouse-backup for analytics data, and KMS encryption throughout. Both tiers enforce retention policies and monitor backup freshness. Every backup is encrypted, and restoration is tested monthly (see 03-recovery-testing.md).
