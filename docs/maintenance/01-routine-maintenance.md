# Routine Maintenance Guide

This document covers recurring maintenance tasks for MiniOp across free-tier self-hosted deployments and scaled production environments. Follow these schedules to keep your clip generation pipeline healthy and prevent drift.

---

## 1. Daily Maintenance

### 1.1 Health Check Verification

Run the built-in health endpoint and verify all subsystems respond:

```bash
curl -sf http://localhost:3000/api/health | jq .
```

Expected response:

```json
{
  "status": "healthy",
  "services": {
    "database": "connected",
    "redis": "connected",
    "storage": "writable",
    "gpu_worker": "available"
  },
  "uptime_seconds": 86400
}
```

For production, configure a cron job that alerts on non-200 responses:

```bash
# /etc/cron.d/miniop-health
*/5 * * * * root /opt/miniop/scripts/health-check.sh --slack-webhook $SLACK_HOOK
```

The `health-check.sh` script should check each service independently and report which component failed. In free tier, a simple `curl` check and email notification suffices.

### 1.2 Log Rotation and Review

MiniOp writes logs to `/var/log/miniop/` in production and `./logs/` in development. Configure logrotate:

```
/var/log/miniop/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0640 miniop miniop
    postrotate
        systemctl reload miniop-api || true
    endscript
}
```

Review error logs daily for patterns:

```bash
grep -c "ERROR" /var/log/miniop/api-$(date +%Y-%m-%d).log
grep "OutOfMemory\|Connection refused\|timeout" /var/log/miniop/api-$(date +%Y-%m-%d).log
```

In free tier (SQLite + local storage), watch for disk space issues:

```bash
df -h /opt/miniop/data
du -sh /opt/miniop/data/clips/*
```

### 1.3 Job Queue Monitoring

Check the clip generation queue depth. Stuck jobs indicate GPU worker failures:

```bash
# Production (PostgreSQL)
psql -U miniop -d miniop -c "
  SELECT status, COUNT(*) FROM clip_jobs
  WHERE created_at > NOW() - INTERVAL '24 hours'
  GROUP BY status ORDER BY count DESC;
"

# Free tier (SQLite)
sqlite3 /opt/miniop/data/miniop.db "
  SELECT status, COUNT(*) FROM clip_jobs
  WHERE created_at > datetime('now', '-1 day')
  GROUP BY status;
"
```

If `pending` jobs exceed 100 or any job has been `processing` for over 30 minutes, investigate the worker:

```bash
docker logs miniop-worker --tail 100
# or for bare-metal:
journalctl -u miniop-worker --since "1 hour ago"
```

---

## 2. Weekly Maintenance

### 2.1 Database Maintenance

**PostgreSQL (Production):**

```sql
-- Analyze tables for query planner freshness
ANALYZE clip_jobs;
ANALYZE users;
ANALYZE clips;

-- Reindex fragmented indexes
REINDEX TABLE clip_jobs;

-- Check table bloat
SELECT schemaname, tablename,
       pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Vacuum to reclaim dead tuples
VACUUM (VERBOSE, ANALYZE) clip_jobs;
```

Schedule via pg_cron or a weekly systemd timer:

```ini
# /etc/systemd/system/miniop-db-maintenance.timer
[Unit]
Description=MiniOp weekly database maintenance

[Timer]
OnCalendar=Sun 03:00
Persistent=true

[Install]
WantedBy=timers.target
```

**SQLite (Free Tier):**

```bash
sqlite3 /opt/miniop/data/miniop.db "VACUUM; ANALYZE;"
```

### 2.2 Storage Cleanup

Clip outputs accumulate. Remove orphaned files whose database records were deleted:

```bash
# Find clips on disk not referenced in DB
node scripts/cleanup-orphaned-clips.js --dry-run
node scripts/cleanup-orphaned-clips.js --execute
```

For production with S3-compatible storage:

```bash
# List objects older than 90 days
aws s3 ls s3://miniop-clips/ --recursive | \
  awk '$1 < "2024-01-01"' | \
  aws s3 rm --recursive --dryrun s3://miniop-clips/ --exclude "*" --include ""
```

In free tier, enforce disk quotas:

```bash
find /opt/miniop/data/clips -type f -mtime +30 -delete
```

### 2.3 TLS Certificate Check

```bash
# Check certificate expiry
echo | openssl s_client -connect your-domain.com:443 2>/dev/null | \
  openssl x509 -noout -dates

# For Let's Encrypt auto-renewal verification
certbot renew --dry-run
```

---

## 3. Monthly Maintenance

### 3.1 Full Backup

**Production:**

```bash
#!/bin/bash
# scripts/backup-full.sh
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/backups/miniop/$TIMESTAMP"
mkdir -p "$BACKUP_DIR"

# Database dump
pg_dump -U miniop -d miniop -Fc > "$BACKUP_DIR/miniop.dump"

# Upload metadata
cp /opt/miniop/.env "$BACKUP_DIR/env.bak"

# Storage snapshot (S3 lifecycle policies handle this in prod)
aws s3 sync s3://miniop-clips "$BACKUP_DIR/clips/" --storage-class GLACIER

# Retain last 6 monthly backups
ls -dt /backups/miniop/*/ | tail -n +7 | xargs rm -rf
```

**Free Tier:**

```bash
sqlite3 /opt/miniop/data/miniop.db ".backup '/backups/miniop-$TIMESTAMP.db'"
tar czf "/backups/miniop-clips-$TIMESTAMP.tar.gz" /opt/miniop/data/clips/
```

### 3.2 Security Audit

Run dependency vulnerability scanning:

```bash
npm audit --production
# or
pnpm audit --prod

# For Docker images
trivy image miniop/api:latest
trivy image miniop/worker:latest
```

Review user access and API key usage:

```sql
SELECT u.email, COUNT(j.id) AS jobs_last_30d
FROM users u
LEFT JOIN clip_jobs j ON j.user_id = u.id
  AND j.created_at > NOW() - INTERVAL '30 days'
GROUP BY u.email
ORDER BY jobs_last_30d DESC;
```

Rotate API keys and JWT secrets quarterly. Update the `.env` and restart:

```bash
# Generate new secret
openssl rand -hex 32
# Update .env: JWT_SECRET=<new_value>
docker compose restart api
```

### 3.3 Capacity Review

Evaluate resource utilization trends:

```bash
# Disk usage trend
df -h / | tail -1

# Database size growth
psql -U miniop -d miniop -c "
  SELECT pg_database_size('miniop') / (1024*1024) AS size_mb;
"

# Average clip generation time (last 30 days)
psql -U miniop -d miniop -c "
  SELECT DATE(created_at) AS day,
         AVG(EXTRACT(EPOCH FROM (completed_at - created_at))) AS avg_seconds,
         COUNT(*) AS total_clips
  FROM clip_jobs
  WHERE status = 'completed'
    AND created_at > NOW() - INTERVAL '30 days'
  GROUP BY DATE(created_at)
  ORDER BY day;
"
```

If processing times trend upward, investigate GPU utilization or consider scaling workers horizontally.

---

## Maintenance Checklist Summary

| Task | Frequency | Free Tier | Production |
|------|-----------|-----------|------------|
| Health check | Daily | Manual curl | Automated cron + alerting |
| Log review | Daily | Manual grep | Centralized logging (ELK/Loki) |
| Queue depth | Daily | SQLite query | PostgreSQL + Grafana dashboard |
| DB vacuum/analyze | Weekly | sqlite3 VACUUM | pg_cron VACUUM ANALYZE |
| Storage cleanup | Weekly | find -delete | S3 lifecycle + orphan script |
| TLS check | Monthly | certbot --dry-run | Automated renewal + monitoring |
| Full backup | Monthly | Manual sqlite backup | pg_dump + S3 Glacier |
| Security audit | Monthly | npm audit | Trivy + npm audit + key rotation |
| Capacity review | Monthly | Manual df/du | Grafana + SQL trend queries |
