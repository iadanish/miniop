# MiniOp Database Rollback Procedures

## Overview

MiniOp uses PostgreSQL 16 as its primary data store. The database holds user accounts, project metadata, clip configurations, processing job state, and billing information. Database migrations are managed by Prisma Migrate in development and applied via `prisma migrate deploy` in CI/CD pipelines.

Database rollback is the highest-risk rollback operation because it can cause data loss. This document covers procedures for both the free tier (single PostgreSQL instance with manual backups) and scaled production (AWS RDS with automated snapshots and point-in-time recovery).

## Migration Safety Classification

Every migration in MiniOp falls into one of three safety tiers. The tier determines the rollback strategy.

### Tier 1: Additive-Only Migrations

These migrations only add new tables, columns, or indexes. They are backward-compatible with the previous application version.

```sql
-- Example: Adding a clip_duration column to the clips table
ALTER TABLE clips ADD COLUMN clip_duration_seconds INTEGER;
CREATE INDEX idx_clips_duration ON clips(clip_duration_seconds);
```

**Rollback strategy**: Revert the application code. The unused column or index causes no harm. Clean it up in the next release cycle.

### Tier 2: Expand-Contract Migrations

These migrations rename or restructure data in two phases. The expand phase adds the new structure alongside the old. The contract phase removes the old structure after all application instances are updated.

```sql
-- Expand phase (deployed with version 1.4.2)
ALTER TABLE clips ADD COLUMN duration_seconds INTEGER;
UPDATE clips SET duration_seconds = clip_duration_seconds;
-- Old column remains, both columns coexist
```

```sql
-- Contract phase (deployed with version 1.5.0, after all 1.4.2 pods are running)
ALTER TABLE clips DROP COLUMN clip_duration_seconds;
```

**Rollback strategy**: If the expand phase fails, revert the migration. If the expand phase succeeds but the application has a bug, the old column still exists, so rolling back the application code is safe. The contract phase is irreversible without a backup restore.

### Tier 3: Destructive Migrations

These migrations drop columns, truncate data, or change constraints in ways that break backward compatibility.

```sql
-- Example: Removing a deprecated field
ALTER TABLE clips DROP COLUMN legacy_format;
```

**Rollback strategy**: These migrations must be preceded by a verified backup. If rollback is needed, restore the backup and redeploy the previous application version. There is no safe partial rollback.

## Free Tier Database Rollback

### Backup Strategy

The free tier runs a cron job that creates hourly pg_dump files and daily full backups:

```bash
# /etc/cron.d/minio-postgres-backup
0 * * * * postgres pg_dump -U minio minio | gzip > /opt/minio/backups/hourly/minio-$(date +\%Y\%m\%d-\%H\%M).sql.gz
0 3 * * * postgres pg_dump -U minio minio | gzip > /opt/minio/backups/daily/minio-$(date +\%Y\%m\%d).sql.gz
# Retain 24 hourly, 30 daily
0 4 * * * find /opt/minio/backups/hourly -mtime +1 -delete
0 4 * * * find /opt/minio/backups/daily -mtime +30 -delete
```

### Rollback Procedure: Migration Failure During Deploy

If `prisma migrate deploy` fails during a deployment, the migration may be partially applied. Prisma tracks applied migrations in the `_prisma_migrations` table.

```bash
# Step 1: Check migration status
docker compose exec api npx prisma migrate status

# Step 2: If the migration is marked as failed, resolve it
# Option A: If the migration can be cleanly reversed
docker compose exec api npx prisma migrate resolve --rolled-back "20240615_add_clip_duration"

# Option B: If the migration partially applied and cannot be reversed
# Restore from the pre-deployment backup
docker compose down
gunzip -c /opt/minio/backups/hourly/minio-20240615-14-00.sql.gz | \
  docker compose exec -T postgres psql -U minio minio
docker compose up -d
```

### Rollback Procedure: Bad Migration Applied Successfully

If the migration applied cleanly but the application behavior is wrong:

```bash
# Step 1: Dump the current state (in case we need forensics)
docker compose exec postgres pg_dump -U minio minio > /opt/minio/backups/post-rollback-$(date +%s).sql

# Step 2: Restore the pre-migration backup
docker compose down
gunzip -c /opt/minio/backups/hourly/minio-20240615-13-00.sql.gz | \
  docker compose exec -T postgres psql -U minio minio

# Step 3: Redeploy the previous application version
sed -i 's/minio\/api:1.4.2/minio\/api:1.4.1/g' docker-compose.prod.yml
docker compose up -d

# Step 4: Verify
docker compose exec api npx prisma migrate status
curl -sf http://localhost:8080/health | jq .
```

## Production Database Rollback

### Backup Strategy

Production uses AWS RDS for PostgreSQL with:

- **Automated snapshots**: Retained for 7 days, taken daily during the maintenance window.
- **Point-in-time recovery (PITR)**: Continuous WAL archiving to S3, enabling restore to any second within the retention period.
- **Manual snapshots**: Taken before every migration deployment via the CI/CD pipeline.

```yaml
# .github/workflows/deploy.yml (excerpt)
- name: Create pre-migration RDS snapshot
  run: |
    aws rds create-db-snapshot \
      --db-instance-identifier minio-prod \
      --db-snapshot-identifier pre-migration-${{ github.sha }} \
      --tags Key=commit,Value=${{ github.sha }} Key=trigger,Value=deploy
```

### Rollback Procedure: Migration Failure During Deploy

```bash
# Step 1: Check Prisma migration status
kubectl exec -n minio deploy/minio-api -- npx prisma migrate status

# Step 2: If migration is failed, resolve it
kubectl exec -n minio deploy/minio-api -- npx prisma migrate resolve --rolled-back "20240615_add_clip_duration"

# Step 3: Roll back the application deployment
kubectl rollout undo deployment/minio-api -n minio
kubectl rollout undo deployment/minio-worker -n minio
```

### Rollback Procedure: Bad Migration Applied, Need Database Restore

This is the most disruptive operation. It requires downtime.

```bash
# Step 1: Scale down all application pods to prevent writes
kubectl scale deployment/minio-api -n minio --replicas=0
kubectl scale deployment/minio-worker -n minio --replicas=0
kubectl scale deployment/minio-scheduler -n minio --replicas=0

# Step 2: Identify the restore point
# If using PITR, determine the timestamp just before the migration
# Example: migration ran at 2024-06-15T14:30:00Z, restore to 14:29:55
RESTORE_TIMESTAMP="2024-06-15T14:29:55Z"

# Step 3: Restore RDS to a new instance (do NOT restore over the production instance)
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier minio-prod \
  --target-db-instance-identifier minio-prod-restored \
  --restore-time "$RESTORE_TIMESTAMP" \
  --db-instance-class db.r6g.xlarge \
  --no-multi-az

# Step 4: Wait for the restored instance to become available
aws rds wait db-instance-available --db-instance-identifier minio-prod-restored

# Step 5: Update the Kubernetes secret to point to the restored instance
RESTORED_ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier minio-prod-restored \
  --query 'DBInstances[0].Endpoint.Address' --output text)

kubectl create secret generic minio-db-credentials -n minio \
  --from-literal=DATABASE_URL="postgresql://minio:${DB_PASSWORD}@${RESTORED_ENDPOINT}:5432/minio" \
  --dry-run=client -o yaml | kubectl apply -f -

# Step 6: Redeploy the previous application version
kubectl set image deployment/minio-api api=minio/api:1.4.1 -n minio
kubectl set image deployment/minio-worker worker=minio/worker:1.4.1 -n minio
kubectl set image deployment/minio-scheduler scheduler=minio/scheduler:1.4.1 -n minio

# Step 7: Scale back up
kubectl scale deployment/minio-api -n minio --replicas=3
kubectl scale deployment/minio-worker -n minio --replicas=5
kubectl scale deployment/minio-scheduler -n minio --replicas=2

# Step 8: Verify
kubectl exec -n minio deploy/minio-api -- npx prisma migrate status
curl -sf https://api.minio.app/health | jq .

# Step 9: After verification, promote the restored instance
# Create a CNAME swap or update the secret to point to the promoted instance
# Then delete the old instance
aws rds delete-db-instance --db-instance-identifier minio-prod --skip-final-snapshot
aws rds modify-db-instance --db-instance-identifier minio-prod-restored \
  --new-db-instance-identifier minio-prod --apply-immediately
```

## Data Loss Scenarios

| Scenario | Free Tier Impact | Production Impact |
|---|---|---|
| Rollback within 1 hour | No data loss (last hourly dump) | No data loss (PITR to pre-migration) |
| Rollback within 24 hours | Up to 1 hour of data loss | No data loss (PITR to any second) |
| Rollback after 24 hours | Up to 24 hours of data loss | Up to 7 days of data loss (snapshot restore) |
| Rollback after 7 days | Data loss since last daily backup | Data loss since last manual snapshot |

## Migration Best Practices to Minimize Rollback Risk

1. **Never deploy a Tier 3 migration without a verified backup.** The CI/CD pipeline enforces this by checking for a pre-migration snapshot before running `prisma migrate deploy`.

2. **Use the expand-contract pattern for all schema changes.** This allows application rollback without database rollback in most cases.

3. **Test migrations against a restored production snapshot** in a staging environment before deploying to production.

4. **Keep migrations small.** A migration that touches more than one table increases the blast radius of failure.

5. **Add columns with defaults carefully.** In PostgreSQL 11+, `ALTER TABLE ADD COLUMN DEFAULT` is fast for constant defaults, but expression defaults still rewrite the table. Use `ALTER TABLE ADD COLUMN ... DEFAULT ... NOT NULL` only when the default is a literal.

```sql
-- Fast (constant default, no table rewrite in PG 11+)
ALTER TABLE clips ADD COLUMN status TEXT DEFAULT 'pending';

-- Slow (expression default, triggers table rewrite)
ALTER TABLE clips ADD COLUMN created_at TIMESTAMPTO DEFAULT NOW();
```

## Related Documents

- [01-rollback-strategy.md](./01-rollback-strategy.md) - Overall rollback strategy and decision matrix
- [03-feature-flags.md](./03-feature-flags.md) - Feature flags as an alternative to database rollback
