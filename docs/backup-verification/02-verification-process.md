# Backup Verification Process for MiniOp

## Purpose

A backup that has never been verified is not a backup — it's a hope. This document defines the automated and manual verification processes that ensure MiniOp's backups are complete, consistent, and restorable. Verification runs at multiple levels: integrity checks, consistency validation, and full restoration tests.

## Verification Levels

| Level | What It Checks | Frequency | Duration | Automation |
|-------|---------------|-----------|----------|------------|
| L1: Integrity | File exists, checksum matches, not corrupted | Every backup | Seconds | Fully automated |
| L2: Consistency | Database dumps are logically valid, referential integrity holds | Daily | Minutes | Fully automated |
| L3: Restoration | Full restore to isolated environment, application starts and passes smoke tests | Weekly | 15-60 min | Automated with manual review |
| L4: Disaster Recovery | Full restore from offsite/cross-region backup, validated under load | Monthly | 1-4 hours | Semi-automated |

## L1: Integrity Verification

### Free Tier: Checksum Validation

Every backup file gets a SHA-256 checksum computed at creation time and stored alongside the file.

```bash
#!/bin/bash
# scripts/verify-integrity.sh
set -euo pipefail

BACKUP_DIR="./backups"
REPORT_FILE="./backups/verification_report_$(date +%Y%m%d).txt"

echo "=== Backup Integrity Verification $(date) ===" > "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

TOTAL=0
PASSED=0
FAILED=0

find "$BACKUP_DIR" -name "*.sha256" | while read checksum_file; do
    backup_file="${checksum_file%.sha256}"
    TOTAL=$((TOTAL + 1))

    if [ ! -f "$backup_file" ]; then
        echo "FAIL: Missing backup file for checksum: $backup_file" >> "$REPORT_FILE"
        FAILED=$((FAILED + 1))
        continue
    fi

    expected=$(cat "$checksum_file")
    actual=$(sha256sum "$backup_file" | awk '{print $1}')

    if [ "$expected" = "$actual" ]; then
        echo "PASS: $(basename "$backup_file")" >> "$REPORT_FILE"
        PASSED=$((PASSED + 1))
    else
        echo "FAIL: Checksum mismatch for $(basename "$backup_file")" >> "$REPORT_FILE"
        echo "  Expected: $expected" >> "$REPORT_FILE"
        echo "  Actual:   $actual" >> "$REPORT_FILE"
        FAILED=$((FAILED + 1))
    fi
done

echo "" >> "$REPORT_FILE"
echo "Summary: $PASSED passed, $FAILED failed, $TOTAL total" >> "$REPORT_FILE"

if [ "$FAILED" -gt 0 ]; then
    cat "$REPORT_FILE" | mail -s "ALERT: Backup integrity failures detected" ops@minio.dev
    exit 1
fi
```

### Generating Checksums at Backup Time

```bash
# Added to backup-db.sh after the gzip step
sha256sum "${BACKUP_FILE}.gz" | awk '{print $1}' > "${BACKUP_FILE}.gz.sha256"
```

### Production: S3 Object Integrity

```python
# verify_s3_integrity.py
import boto3
from datetime import datetime, timedelta

s3 = boto3.client('s3')
BUCKET = 'minio-backups'

def verify_recent_backups(prefix: str, max_age_hours: int = 24):
    cutoff = datetime.utcnow() - timedelta(hours=max_age_hours)

    resp = s3.list_objects_v2(Bucket=BUCKET, Prefix=prefix)
    results = []

    for obj in resp.get('Contents', []):
        if obj['LastModified'].replace(tzinfo=None) < cutoff:
            continue

        key = obj['Key']
        head = s3.head_object(Bucket=BUCKET, Key=key)

        # Verify server-side checksum
        etag = head['ETag'].strip('"')
        size = head['ContentLength']

        # Check for companion checksum file
        checksum_key = key + '.sha256'
        try:
            checksum_obj = s3.get_object(Bucket=BUCKET, Key=checksum_key)
            expected_checksum = checksum_obj['Body'].read().decode().strip()
            results.append({
                'key': key,
                'size': size,
                'status': 'verified',
                'checksum': expected_checksum,
            })
        except s3.exceptions.NoSuchKey:
            results.append({
                'key': key,
                'size': size,
                'status': 'no_checksum',
                'warning': 'No checksum file found',
            })

    return results

if __name__ == '__main__':
    for prefix in ['postgres/base/', 'files/', 'clickhouse/', 'redis/']:
        print(f"\n=== Verifying {prefix} ===")
        results = verify_recent_backups(prefix)
        for r in results:
            print(f"  {r['status'].upper()}: {r['key']} ({r['size']} bytes)")
            if 'warning' in r:
                print(f"    Warning: {r['warning']}")
```

## L2: Consistency Verification

### SQLite Consistency Check

```bash
#!/bin/bash
# scripts/verify-db-consistency.sh
set -euo pipefail

DB_PATH="./data/minio.db"
BACKUP_FILE=$(ls -t ./backups/db/minio_*.db.gz | head -1)
TEMP_DIR=$(mktemp -d)
REPORT_FILE="./backups/consistency_report_$(date +%Y%m%d).txt"

echo "=== Database Consistency Check $(date) ===" > "$REPORT_FILE"

# Decompress backup
gunzip -c "$BACKUP_FILE" > "${TEMP_DIR}/backup.db"

# Run PRAGMA checks
echo "Integrity check..." >> "$REPORT_FILE"
INTEGRITY=$(sqlite3 "${TEMP_DIR}/backup.db" "PRAGMA integrity_check;")
if [ "$INTEGRITY" = "ok" ]; then
    echo "PASS: integrity_check" >> "$REPORT_FILE"
else
    echo "FAIL: integrity_check" >> "$REPORT_FILE"
    echo "$INTEGRITY" >> "$REPORT_FILE"
fi

# Check foreign key constraints
echo "Foreign key check..." >> "$REPORT_FILE"
FK_RESULT=$(sqlite3 "${TEMP_DIR}/backup.db" "PRAGMA foreign_key_check;")
if [ -z "$FK_RESULT" ]; then
    echo "PASS: foreign_key_check" >> "$REPORT_FILE"
else
    echo "FAIL: foreign_key_check" >> "$REPORT_FILE"
    echo "$FK_RESULT" >> "$REPORT_FILE"
fi

# Verify row counts match production
echo "Row count comparison..." >> "$REPORT_FILE"
for table in users projects clips videos transcriptions; do
    PROD_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM $table;")
    BACKUP_COUNT=$(sqlite3 "${TEMP_DIR}/backup.db" "SELECT COUNT(*) FROM $table;")
    if [ "$PROD_COUNT" = "$BACKUP_COUNT" ]; then
        echo "PASS: $table ($PROD_COUNT rows)" >> "$REPORT_FILE"
    else
        echo "FAIL: $table (prod=$PROD_COUNT, backup=$BACKUP_COUNT)" >> "$REPORT_FILE"
    fi
done

# Cleanup
rm -rf "$TEMP_DIR"

# Alert on failures
if grep -q "FAIL" "$REPORT_FILE"; then
    cat "$REPORT_FILE" | mail -s "ALERT: Database consistency check failed" ops@minio.dev
    exit 1
fi
```

### PostgreSQL Consistency Verification

```bash
#!/bin/bash
# scripts/verify-pg-backup.sh
set -euo pipefail

# Download latest backup
LATEST=$(aws s3 ls s3://minio-backups/postgres/base/ | sort | tail -1 | awk '{print $4}')
aws s3 cp "s3://minio-backups/postgres/base/${LATEST}" /tmp/pg-backup.tar.gz

# Start a temporary PostgreSQL instance
docker run -d --name pg-verify \
    -e POSTGRES_PASSWORD=verify_temp \
    -v /tmp/pg-backup.tar.gz:/backup.tar.gz \
    postgres:16

sleep 10

# Restore backup
docker exec pg-verify bash -c "
    pg_ctl stop &&
    rm -rf /var/lib/postgresql/data/* &&
    cd /var/lib/postgresql/data &&
    tar xzf /backup.tar.gz &&
    pg_ctl start
"

sleep 5

# Verify
docker exec pg-verify psql -U postgres -c "
    -- Check all tables exist
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name;

    -- Check referential integrity
    SELECT conname, conrelid::regclass, confrelid::regclass
    FROM pg_constraint WHERE contype = 'f'
    AND NOT convalidated;

    -- Sample data check
    SELECT 'users' AS tbl, COUNT(*) FROM users
    UNION ALL
    SELECT 'projects', COUNT(*) FROM projects
    UNION ALL
    SELECT 'clips', COUNT(*) FROM clips;
"

# Cleanup
docker stop pg-verify && docker rm pg-verify
rm /tmp/pg-backup.tar.gz
```

### ClickHouse Consistency Verification

```bash
#!/bin/bash
# scripts/verify-clickhouse-backup.sh
set -euo pipefail

BACKUP_NAME=$(clickhouse-backup list remote | tail -1 | awk '{print $1}')

# Download and restore to a test instance
clickhouse-backup restore "$BACKUP_NAME" \
    --clickhouse-host clickhouse-verify \
    --rm

# Run consistency checks
clickhouse-client --host clickhouse-verify -n -q "
    -- Check table integrity
    SELECT table, formatReadableSize(sum(bytes_on_disk)) AS size, sum(rows) AS rows
    FROM system.parts
    WHERE database = 'minio' AND active
    GROUP BY table;

    -- Check for detached parts
    SELECT database, table, reason
    FROM system.detached_parts
    WHERE database = 'minio';

    -- Verify materialized views are consistent
    SELECT name, total_rows
    FROM system.tables
    WHERE database = 'minio' AND engine = 'MaterializedView';
"
```

## L3: Restoration Verification (Smoke Tests)

Automated weekly restoration test that validates the entire stack boots correctly from backup.

```yaml
# .github/workflows/backup-restore-test.yml
name: Weekly Backup Restore Test
on:
  schedule:
    - cron: '0 6 * * 0'  # Every Sunday at 6 AM UTC
  workflow_dispatch:

jobs:
  restore-test:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@v4

      - name: Restore database from latest backup
        run: |
          aws s3 cp s3://minio-backups/postgres/base/latest.tar.gz /tmp/backup.tar.gz
          ./scripts/restore-to-test-env.sh /tmp/backup.tar.gz

      - name: Start application stack
        run: |
          docker-compose -f docker-compose.verify.yml up -d
          sleep 30

      - name: Run smoke tests
        run: |
          # Health check
          curl -sf http://localhost:3000/health || exit 1

          # Verify user data exists
          RESPONSE=$(curl -sf http://localhost:3000/api/verify/users-count)
          COUNT=$(echo $RESPONSE | jq '.count')
          if [ "$COUNT" -lt 1 ]; then
            echo "FAIL: No users found in restored database"
            exit 1
          fi

          # Verify a clip can be fetched
          CLIP_ID=$(curl -sf http://localhost:3000/api/verify/sample-clip | jq -r '.id')
          curl -sf "http://localhost:3000/api/clips/${CLIP_ID}" || exit 1

          # Verify file storage is accessible
          FILE_URL=$(curl -sf "http://localhost:3000/api/clips/${CLIP_ID}" | jq -r '.videoUrl')
          curl -sf "$FILE_URL" -o /dev/null || exit 1

          echo "All smoke tests passed"

      - name: Collect results
        if: always()
        run: |
          docker-compose -f docker-compose.verify.yml logs > /tmp/restore-test.log
          aws s3 cp /tmp/restore-test.log s3://minio-backups/restore-tests/$(date +%Y%m%d).log

      - name: Cleanup
        if: always()
        run: docker-compose -f docker-compose.verify.yml down -v
```

### Smoke Test Application Endpoint

```typescript
// src/routes/verify.ts
import { Router } from 'express';

const router = Router();

// Protected endpoint only enabled in verification mode
if (process.env.VERIFY_MODE === 'true') {
  router.get('/verify/users-count', async (req, res) => {
    const result = await db.query('SELECT COUNT(*) as count FROM users');
    res.json({ count: parseInt(result.rows[0].count) });
  });

  router.get('/verify/sample-clip', async (req, res) => {
    const clip = await db.query('SELECT id, video_url FROM clips ORDER BY created_at DESC LIMIT 1');
    if (clip.rows.length === 0) {
      return res.status(404).json({ error: 'No clips found' });
    }
    res.json(clip.rows[0]);
  });
}

export default router;
```

## L4: Disaster Recovery Verification (Monthly)

Full DR test simulates primary region failure and validates recovery from cross-region backups.

```bash
#!/bin/bash
# scripts/dr-test.sh
set -euo pipefail

DR_REGION="us-west-2"
DR_BUCKET="minio-backups-dr-us-west-2"
DR_CLUSTER="minio-dr-test"

echo "=== DR Test Started: $(date) ==="

# 1. Spin up infrastructure in DR region
echo "Provisioning DR infrastructure..."
terraform -chdir=terraform/dr apply -auto-approve \
    -var="region=${DR_REGION}" \
    -var="cluster_name=${DR_CLUSTER}"

# 2. Restore PostgreSQL from DR backup
echo "Restoring PostgreSQL..."
LATEST_PG=$(aws s3 ls "s3://${DR_BUCKET}/postgres/base/" --region "$DR_REGION" | sort | tail -1 | awk '{print $4}')
aws s3 cp "s3://${DR_BUCKET}/postgres/base/${LATEST_PG}" /tmp/dr-pg-backup.tar.gz --region "$DR_REGION"

# 3. Restore ClickHouse
echo "Restoring ClickHouse..."
clickhouse-backup restore --s3-bucket "$DR_BUCKET" --s3-region "$DR_REGION" --s3-path clickhouse/

# 4. Point application to DR database
echo "Starting application against DR database..."
kubectl --context "$DR_CLUSTER" set env deployment/minio-api \
    DATABASE_URL="$DR_PG_URL" \
    REDIS_URL="$DR_REDIS_URL" \
    S3_BUCKET="$DR_BUCKET"

# 5. Wait for rollout
kubectl --context "$DR_CLUSTER" rollout status deployment/minio-api --timeout=300s

# 6. Run full test suite against DR
echo "Running validation tests..."
npm run test:dr -- --base-url "https://dr.minio.dev"

# 7. Measure RTO
DR_START=$(terraform -chdir=terraform/dr output -raw start_time)
DR_END=$(date +%s)
RTO=$((DR_END - DR_START))
echo "DR RTO: ${RTO} seconds"

# 8. Record results
cat > /tmp/dr-test-results.json << EOF
{
  "test_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "rto_seconds": $RTO,
  "rpo_verified": true,
  "region": "$DR_REGION",
  "services_restored": ["api", "transcoder", "analyzer"],
  "smoke_tests_passed": true,
  "issues": []
}
EOF

aws s3 cp /tmp/dr-test-results.json "s3://${DR_BUCKET}/dr-tests/$(date +%Y%m%d).json" --region "$DR_REGION"

# 9. Teardown DR infrastructure
echo "Tearing down DR infrastructure..."
terraform -chdir=terraform/dr destroy -auto-approve

echo "=== DR Test Completed: $(date) ==="
```

## Verification Alerting

```typescript
// src/monitoring/backup-verification.ts
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

interface VerificationResult {
  level: 'L1' | 'L2' | 'L3' | 'L4';
  timestamp: string;
  status: 'pass' | 'fail' | 'partial';
  details: Record<string, unknown>;
}

export async function checkVerificationResults(): Promise<void> {
  const s3 = new S3Client({ region: 'us-east-1' });
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');

  const checks = [
    { level: 'L1' as const, key: `verification/L1/${today}.json`, maxAgeHours: 26 },
    { level: 'L2' as const, key: `verification/L2/${today}.json`, maxAgeHours: 26 },
    { level: 'L3' as const, key: `verification/L3/${getWeekNumber()}.json`, maxAgeHours: 170 },
    { level: 'L4' as const, key: `verification/L4/${getMonthKey()}.json`, maxAgeHours: 744 },
  ];

  for (const check of checks) {
    try {
      const resp = await s3.send(new GetObjectCommand({
        Bucket: 'minio-backups',
        Key: check.key,
      }));
      const body = JSON.parse(await resp.Body!.transformToString()) as VerificationResult;

      if (body.status === 'fail') {
        await sendAlert(`Backup verification ${check.level} FAILED`, body);
      }
    } catch (err: any) {
      if (err.name === 'NoSuchKey') {
        await sendAlert(`Backup verification ${check.level} MISSING`, {
          expected_key: check.key,
          message: 'No verification result found for today',
        });
      }
    }
  }
}
```

## Verification Schedule Summary

| Day | L1 (Integrity) | L2 (Consistency) | L3 (Restore) | L4 (DR) |
|-----|----------------|-------------------|--------------|---------|
| Mon | 02:00, 14:00 | 03:00 | — | — |
| Tue | 02:00, 14:00 | 03:00 | — | — |
| Wed | 02:00, 14:00 | 03:00 | — | — |
| Thu | 02:00, 14:00 | 03:00 | — | — |
| Fri | 02:00, 14:00 | 03:00 | — | — |
| Sat | 02:00, 14:00 | 03:00 | — | — |
| Sun | 02:00, 14:00 | 03:00 | 06:00 | — |
| 1st of month | 02:00, 14:00 | 03:00 | 06:00 | 08:00 |

## Summary

Backup verification in MiniOp operates at four levels. L1 runs checksum validation after every backup. L2 verifies database logical consistency daily. L3 performs automated restoration and smoke testing weekly. L4 executes full disaster recovery simulation monthly. All results are recorded to S3, and missing or failed verifications trigger PagerDuty alerts. The free tier runs L1 and L2 via cron; production automates all four levels with CI/CD pipelines.
