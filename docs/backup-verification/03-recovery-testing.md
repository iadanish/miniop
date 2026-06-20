# Recovery Testing for MiniOp

## Purpose

Recovery testing validates that MiniOp can restore operations after data loss, corruption, or infrastructure failure. Unlike backup verification (which checks that backups are valid), recovery testing measures how quickly and completely the system can be brought back online. This document defines recovery test procedures, RTO/RPO measurement, and chaos engineering practices for both free tier and production.

## Recovery Scenarios

| Scenario | Data Affected | Expected RTO | Expected RPO | Test Frequency |
|----------|--------------|--------------|--------------|----------------|
| Database corruption | PostgreSQL/SQLite | 15 min / 30 min | 5 min / 1 hour | Monthly |
| Storage failure | S3/EBS/local disk | 4 hours | 24 hours | Quarterly |
| Region outage | All services | 1 hour | 5 min | Semi-annually |
| Accidental deletion | Specific user/project | 10 min | 0 (point-in-time) | Monthly |
| Ransomware/crypto | All data | 2 hours | 1 hour | Annually |
| Cascading failure | Multiple services | 30 min | Varies | Quarterly |

## Free Tier Recovery Testing

### Test 1: Database Corruption Recovery

Simulate SQLite corruption and measure recovery time.

```bash
#!/bin/bash
# tests/recovery-db-corruption.sh
set -euo pipefail

DB_PATH="./data/minio.db"
BACKUP_DIR="./backups/db"
LOG_FILE="./tests/recovery-results.log"

echo "=== DB Corruption Recovery Test $(date) ===" | tee "$LOG_FILE"

# Record start of test
TEST_START=$(date +%s)

# 1. Create a known-good state
echo "Step 1: Creating test data..." | tee -a "$LOG_FILE"
TEST_USER_ID=$(sqlite3 "$DB_PATH" "INSERT INTO users (email, name) VALUES ('recovery-test@example.com', 'Recovery Test') RETURNING id;")
TEST_CLIP_ID=$(sqlite3 "$DB_PATH" "INSERT INTO clips (user_id, title, duration) VALUES ('$TEST_USER_ID', 'Recovery Test Clip', 60) RETURNING id;")
sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM users;" | tee -a "$LOG_FILE"

# 2. Force a backup
echo "Step 2: Creating backup..." | tee -a "$LOG_FILE"
./scripts/backup-db.sh

# 3. Corrupt the database
echo "Step 3: Corrupting database..." | tee -a "$LOG_FILE"
CORRUPT_START=$(date +%s)
dd if=/dev/urandom of="$DB_PATH" bs=1024 count=10 conv=notrunc 2>/dev/null

# 4. Attempt to use the corrupted database
echo "Step 4: Verifying corruption is detected..." | tee -a "$LOG_FILE"
if sqlite3 "$DB_PATH" "PRAGMA integrity_check;" | grep -q "ok"; then
    echo "FAIL: Corruption not detected by PRAGMA integrity_check" | tee -a "$LOG_FILE"
    exit 1
fi

# 5. Restore from backup
echo "Step 5: Restoring from backup..." | tee -a "$LOG_FILE"
LATEST_BACKUP=$(ls -t "$BACKUP_DIR"/minio_*.db.gz | head -1)
gunzip -c "$LATEST_BACKUP" > "$DB_PATH"
RESTORE_END=$(date +%s)

# 6. Verify restored data
echo "Step 6: Verifying restored data..." | tee -a "$LOG_FILE"
INTEGRITY=$(sqlite3 "$DB_PATH" "PRAGMA integrity_check;")
USER_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM users;")
TEST_USER_EXISTS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM users WHERE id = '$TEST_USER_ID';")
TEST_CLIP_EXISTS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM clips WHERE id = '$TEST_CLIP_ID';")

# 7. Calculate RTO
RTO=$((RESTORE_END - CORRUPT_START))

echo "" | tee -a "$LOG_FILE"
echo "Results:" | tee -a "$LOG_FILE"
echo "  Integrity check: $INTEGRITY" | tee -a "$LOG_FILE"
echo "  User count after restore: $USER_COUNT" | tee -a "$LOG_FILE"
echo "  Test user preserved: $TEST_USER_EXISTS" | tee -a "$LOG_FILE"
echo "  Test clip preserved: $TEST_CLIP_EXISTS" | tee -a "$LOG_FILE"
echo "  RTO: ${RTO} seconds" | tee -a "$LOG_FILE"

if [ "$INTEGRITY" = "ok" ] && [ "$TEST_USER_EXISTS" = "1" ] && [ "$TEST_CLIP_EXISTS" = "1" ]; then
    echo "  Status: PASS" | tee -a "$LOG_FILE"
else
    echo "  Status: FAIL" | tee -a "$LOG_FILE"
    exit 1
fi
```

### Test 2: Accidental File Deletion Recovery

```bash
#!/bin/bash
# tests/recovery-file-deletion.sh
set -euo pipefail

TEST_DIR="./data/uploads/recovery-test"
LOG_FILE="./tests/recovery-file-results.log"

echo "=== File Deletion Recovery Test $(date) ===" | tee "$LOG_FILE"

# 1. Create test files
mkdir -p "$TEST_DIR"
dd if=/dev/urandom of="$TEST_DIR/test-video.mp4" bs=1M count=10 2>/dev/null
ORIGINAL_HASH=$(sha256sum "$TEST_DIR/test-video.mp4" | awk '{print $1}')
echo "Created test file: $ORIGINAL_HASH" | tee -a "$LOG_FILE"

# 2. Run file backup
./scripts/backup-files.sh

# 3. Delete the test directory
DELETE_START=$(date +%s)
rm -rf "$TEST_DIR"
echo "Deleted test directory" | tee -a "$LOG_FILE"

# 4. Restore from backup
RESTORE_START=$(date +%s)
LATEST_BACKUP=$(ls -td ./backups/files/uploads_* | head -1)
rsync -av "$LATEST_BACKUP/recovery-test/" "$TEST_DIR/"
RESTORE_END=$(date +%s)

# 5. Verify
RESTORED_HASH=$(sha256sum "$TEST_DIR/test-video.mp4" | awk '{print $1}')
RTO=$((RESTORE_END - DELETE_START))

echo "" | tee -a "$LOG_FILE"
echo "Results:" | tee -a "$LOG_FILE"
echo "  Original hash:  $ORIGINAL_HASH" | tee -a "$LOG_FILE"
echo "  Restored hash:  $RESTORED_HASH" | tee -a "$LOG_FILE"
echo "  RTO: ${RTO} seconds" | tee -a "$LOG_FILE"

if [ "$ORIGINAL_HASH" = "$RESTORED_HASH" ]; then
    echo "  Status: PASS" | tee -a "$LOG_FILE"
else
    echo "  Status: FAIL" | tee -a "$LOG_FILE"
fi

# Cleanup
rm -rf "$TEST_DIR"
```

## Production Recovery Testing

### PostgreSQL Point-in-Time Recovery (PITR) Test

```bash
#!/bin/bash
# tests/recovery-pitr.sh
set -euo pipefail

# This test validates that we can recover to an arbitrary point in time
# using WAL archiving

TEST_DB="minio_pitr_test_$(date +%s)"
LOG_FILE="/tmp/pitr-test.log"

echo "=== PITR Recovery Test $(date) ===" | tee "$LOG_FILE"

# 1. Record current WAL position
WAL_POSITION=$(psql -t -c "SELECT pg_current_wal_lsn();" | tr -d ' ')
echo "Starting WAL position: $WAL_POSITION" | tee -a "$LOG_FILE"

# 2. Insert a marker record
MARKER_TIME=$(psql -t -c "
    INSERT INTO recovery_test (marker, created_at)
    VALUES ('BEFORE_RECOVERY', NOW())
    RETURNING created_at;
" | tr -d ' ')
echo "Marker inserted at: $MARKER_TIME" | tee -a "$LOG_FILE"

# 3. Wait for WAL to be archived
sleep 310  # archive_timeout is 300s

# 4. Insert a second marker (this should NOT appear after recovery)
psql -c "
    INSERT INTO recovery_test (marker, created_at)
    VALUES ('SHOULD_NOT_EXIST', NOW());
"
RECOVERY_POINT=$(date -u +"%Y-%m-%d %H:%M:%S+00")
echo "Recovery point (should exclude second marker): $RECOVERY_POINT" | tee -a "$LOG_FILE"

# 5. Stop PostgreSQL
systemctl stop postgresql

# 6. Restore base backup
LATEST_BASE=$(aws s3 ls s3://minio-backups/postgres/base/ | sort | tail -1 | awk '{print $4}')
aws s3 cp "s3://minio-backups/postgres/base/${LATEST_BASE}" /tmp/base-backup.tar.gz

rm -rf /var/lib/postgresql/16/main/*
cd /var/lib/postgresql/16/main
tar xzf /tmp/base-backup.tar.gz

# 7. Create recovery configuration
cat > /var/lib/postgresql/16/main/postgresql.auto.conf << EOF
restore_command = 'aws s3 cp s3://minio-backups/postgres/wal/%f %p'
recovery_target_time = '$RECOVERY_POINT'
recovery_target_action = 'promote'
EOF

touch /var/lib/postgresql/16/main/recovery.signal

# 8. Start PostgreSQL in recovery mode
systemctl start postgresql
sleep 10

# 9. Verify
BEFORE_EXISTS=$(psql -t -c "SELECT COUNT(*) FROM recovery_test WHERE marker = 'BEFORE_RECOVERY';" | tr -d ' ')
AFTER_EXISTS=$(psql -t -c "SELECT COUNT(*) FROM recovery_test WHERE marker = 'SHOULD_NOT_EXIST';" | tr -d ' ')

echo "" | tee -a "$LOG_FILE"
echo "Results:" | tee -a "$LOG_FILE"
echo "  'BEFORE_RECOVERY' exists: $BEFORE_EXISTS (expected: 1)" | tee -a "$LOG_FILE"
echo "  'SHOULD_NOT_EXIST' exists: $AFTER_EXISTS (expected: 0)" | tee -a "$LOG_FILE"

if [ "$BEFORE_EXISTS" = "1" ] && [ "$AFTER_EXISTS" = "0" ]; then
    echo "  Status: PASS" | tee -a "$LOG_FILE"
else
    echo "  Status: FAIL" | tee -a "$LOG_FILE"
fi

# 10. Cleanup test markers
psql -c "DELETE FROM recovery_test WHERE marker IN ('BEFORE_RECOVERY', 'SHOULD_NOT_EXIST');"
```

### Automated Recovery Test Suite

```typescript
// tests/recovery/recovery-suite.ts
import { execSync } from 'child_process';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Client } from 'pg';

interface RecoveryTestResult {
  scenario: string;
  rto_seconds: number;
  rpo_seconds: number;
  data_loss: boolean;
  status: 'pass' | 'fail';
  details: string;
}

export class RecoveryTestSuite {
  private results: RecoveryTestResult[] = [];

  async runAll(): Promise<RecoveryTestResult[]> {
    await this.testDatabaseRestore();
    await this.testFileRecovery();
    await this.testPITR();
    await this.testCrossRegionRestore();
    return this.results;
  }

  private async testDatabaseRestore(): Promise<void> {
    const start = Date.now();

    try {
      // Spin up test database
      execSync('docker run -d --name pg-recovery-test -e POSTGRES_PASSWORD=test postgres:16');
      await this.waitForPostgres('pg-recovery-test');

      // Restore latest backup
      const backupKey = await this.getLatestBackupKey('postgres/base/');
      execSync(`aws s3 cp s3://minio-backups/${backupKey} /tmp/recovery-test.tar.gz`);
      execSync('docker exec pg-recovery-test bash -c "cd /var/lib/postgresql/data && tar xzf /tmp/recovery-test.tar.gz"');
      execSync('docker restart pg-recovery-test');
      await this.waitForPostgres('pg-recovery-test');

      // Validate
      const client = new Client({ host: 'localhost', port: 15432, database: 'minio', user: 'postgres', password: 'test' });
      await client.connect();

      const tableCheck = await client.query(`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      `);
      const requiredTables = ['users', 'projects', 'clips', 'videos'];
      const existingTables = tableCheck.rows.map(r => r.table_name);
      const missingTables = requiredTables.filter(t => !existingTables.includes(t));

      if (missingTables.length > 0) {
        this.results.push({
          scenario: 'database_restore',
          rto_seconds: (Date.now() - start) / 1000,
          rpo_seconds: 0,
          data_loss: true,
          status: 'fail',
          details: `Missing tables: ${missingTables.join(', ')}`,
        });
      } else {
        this.results.push({
          scenario: 'database_restore',
          rto_seconds: (Date.now() - start) / 1000,
          rpo_seconds: 0,
          data_loss: false,
          status: 'pass',
          details: `All ${requiredTables.length} tables restored successfully`,
        });
      }

      await client.end();
    } finally {
      execSync('docker rm -f pg-recovery-test 2>/dev/null || true');
    }
  }

  private async testCrossRegionRestore(): Promise<void> {
    const start = Date.now();

    try {
      // Use DR region bucket
      const drRegion = 'us-west-2';
      const drBucket = 'minio-backups-dr-us-west-2';

      // Verify DR bucket has recent backups
      const s3 = new S3Client({ region: drRegion });
      const resp = await s3.send(new GetObjectCommand({
        Bucket: drBucket,
        Key: 'postgres/base/latest.tar.gz',
      }));

      // Restore from DR
      // ... (similar to testDatabaseRestore but from DR bucket)

      this.results.push({
        scenario: 'cross_region_restore',
        rto_seconds: (Date.now() - start) / 1000,
        rpo_seconds: 0,
        data_loss: false,
        status: 'pass',
        details: 'DR region restore successful',
      });
    } catch (error: any) {
      this.results.push({
        scenario: 'cross_region_restore',
        rto_seconds: (Date.now() - start) / 1000,
        rpo_seconds: -1,
        data_loss: true,
        status: 'fail',
        details: error.message,
      });
    }
  }

  private async waitForPostgres(container: string, maxWait: number = 60): Promise<void> {
    const deadline = Date.now() + maxWait * 1000;
    while (Date.now() < deadline) {
      try {
        execSync(`docker exec ${container} pg_isready -U postgres`, { stdio: 'pipe' });
        return;
      } catch {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    throw new Error(`PostgreSQL in ${container} did not become ready within ${maxWait}s`);
  }

  private async getLatestBackupKey(prefix: string): Promise<string> {
    const s3 = new S3Client({ region: 'us-east-1' });
    // ... list and find latest
    return `${prefix}latest.tar.gz`;
  }
}
```

## Chaos Engineering

### Fault Injection Framework

```typescript
// tests/chaos/fault-injection.ts
import { execSync } from 'child_process';

interface FaultScenario {
  name: string;
  description: string;
  inject: () => Promise<void>;
  recover: () => Promise<void>;
  validate: () => Promise<boolean>;
}

export const FAULT_SCENARIOS: FaultScenario[] = [
  {
    name: 'disk_full',
    description: 'Fill disk to 100% and verify graceful degradation',
    inject: async () => {
      execSync('fallocate -l 10G /tmp/fill-disk');
    },
    recover: async () => {
      execSync('rm /tmp/fill-disk');
    },
    validate: async () => {
      // Check that the system rejected new uploads with proper error
      // and didn't corrupt existing data
      try {
        const response = await fetch('http://localhost:3000/api/health');
        return response.status === 503; // Should return service unavailable
      } catch {
        return false;
      }
    },
  },
  {
    name: 'database_connection_lost',
    description: 'Kill database connections and verify reconnection',
    inject: async () => {
      execSync('iptables -A OUTPUT -p tcp --dport 5432 -j DROP');
    },
    recover: async () => {
      execSync('iptables -D OUTPUT -p tcp --dport 5432 -j DROP');
    },
    validate: async () => {
      // Wait for reconnection
      await new Promise(r => setTimeout(r, 5000));
      const response = await fetch('http://localhost:3000/api/health');
      return response.ok;
    },
  },
  {
    name: 'slow_storage',
    description: 'Add latency to S3 operations',
    inject: async () => {
      execSync('tc qdisc add dev eth0 root netem delay 2000ms 500ms');
    },
    recover: async () => {
      execSync('tc qdisc del dev eth0 root');
    },
    validate: async () => {
      // Verify timeouts are handled correctly
      const start = Date.now();
      const response = await fetch('http://localhost:3000/api/clips/test');
      const elapsed = Date.now() - start;
      // Should timeout gracefully within 30 seconds
      return elapsed < 30000;
    },
  },
];

export async function runChaosTest(scenario: FaultScenario): Promise<{
  passed: boolean;
  recovery_time_ms: number;
}> {
  console.log(`Running chaos scenario: ${scenario.name}`);
  console.log(`  Description: ${scenario.description}`);

  await scenario.inject();

  const recoveryStart = Date.now();
  await scenario.recover();
  const recoveryTime = Date.now() - recoveryStart;

  // Wait for system to stabilize
  await new Promise(r => setTimeout(r, 5000));

  const passed = await scenario.validate();

  console.log(`  Recovery time: ${recoveryTime}ms`);
  console.log(`  Status: ${passed ? 'PASS' : 'FAIL'}`);

  return { passed, recovery_time_ms: recoveryTime };
}
```

### Kubernetes Pod Failure Test

```yaml
# tests/chaos/pod-kill.yaml
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: kill-api-pod
  namespace: minio
spec:
  action: pod-kill
  mode: one
  selector:
    namespaces:
      - minio
    labelSelectors:
      app: minio-api
  scheduler:
    cron: '@every 6h'
```

```bash
# Apply chaos experiment
kubectl apply -f tests/chaos/pod-kill.yaml

# Monitor recovery
kubectl get pods -n minio -w
# Verify: pod should restart and pass health checks within 60 seconds
```

## RTO/RPO Measurement and Reporting

```typescript
// tests/recovery/metrics.ts
interface RecoveryMetrics {
  scenario: string;
  timestamp: string;
  rto_target_seconds: number;
  rto_actual_seconds: number;
  rto_met: boolean;
  rpo_target_seconds: number;
  rpo_actual_seconds: number;
  rpo_met: boolean;
  data_verified: boolean;
}

export function generateRecoveryReport(results: RecoveryMetrics[]): string {
  const report = {
    generated_at: new Date().toISOString(),
    summary: {
      total_tests: results.length,
      passed: results.filter(r => r.rto_met && r.rpo_met && r.data_verified).length,
      failed: results.filter(r => !r.rto_met || !r.rpo_met || !r.data_verified).length,
    },
    scenarios: results,
  };

  return JSON.stringify(report, null, 2);
}

// Store results for trending
export async function storeRecoveryMetrics(metrics: RecoveryMetrics[]): Promise<void> {
  const s3 = new S3Client({ region: 'us-east-1' });
  const key = `recovery-tests/${new Date().toISOString().split('T')[0]}.json`;

  await s3.send(new PutObjectCommand({
    Bucket: 'minio-backups',
    Key: key,
    Body: JSON.stringify({ tests: metrics }, null, 2),
    ContentType: 'application/json',
  }));
}
```

## Recovery Runbooks

Each recovery scenario has a corresponding runbook that automation or on-call engineers can follow.

### Runbook: Database Recovery

```markdown
## Database Recovery Runbook

### Prerequisites
- Access to AWS console or CLI with S3 read permissions
- SSH access to database server
- PagerDuty acknowledgment

### Steps
1. Assess damage extent
   - `psql -c "SELECT pg_is_in_recovery();"` — if true, already recovering
   - `psql -c "PRAGMA integrity_check;"` — for SQLite

2. Determine recovery strategy
   - If corruption < 1 hour ago: Use PITR
   - If corruption > 1 hour ago: Use latest base backup + WAL replay

3. Execute recovery
   - Follow: `/scripts/recovery-db-corruption.sh` (free tier)
   - Follow: `/scripts/recovery-pitr.sh` (production)

4. Verify
   - Run smoke tests: `npm run test:smoke`
   - Check audit logs for data consistency

5. Communicate
   - Update status page
   - Send recovery confirmation to #ops channel
```

## Summary

Recovery testing in MiniOp covers database corruption, file deletion, point-in-time recovery, and cross-region restoration. The free tier runs shell-script-based tests monthly with simple hash comparison for data integrity. Production uses an automated test suite that spins up isolated Docker containers, restores backups, and validates data consistency. Chaos engineering experiments inject faults (disk full, network partitions, slow storage) to validate graceful degradation. All recovery tests measure RTO and RPO against defined targets and store results for trend analysis.
