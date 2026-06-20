# Database Scaling — MiniOp Video Clipping Platform

## Database Architecture

MiniOp uses PostgreSQL as its primary relational database for storing users, projects, clips, jobs, and audit logs. The free tier uses a PostgreSQL `jobs` table with `pg_cron` for job dispatch (see `system-architecture/01-overview.md`). At production scale, Redis is added for high-throughput job queues (BullMQ), rate limiting counters, and session caching. This document covers scaling both systems from a single-server free-tier deployment to a production cluster handling millions of clips.

## PostgreSQL — Free-Tier Single Server

The free tier runs a single PostgreSQL 16 instance with no replication. This handles up to ~10,000 clips/month comfortably.

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: minio
      POSTGRES_USER: minio
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
    ports:
      - "5432:5432"
    command: >
      postgres
        -c shared_buffers=256MB
        -c effective_cache_size=768MB
        -c work_mem=16MB
        -c maintenance_work_mem=128MB
        -c max_connections=50
        -c random_page_cost=1.1
        -c log_min_duration_statement=200
```

PostgreSQL tuning for a 4GB RAM server:
- `shared_buffers=256MB` (25% of RAM)
- `effective_cache_size=768MB` (75% of RAM)
- `work_mem=16MB` (per-operation sort/hash memory)
- `max_connections=50` (enough for API + worker processes)

## Schema Design for Scale

### Core Tables

```sql
-- Users and organizations
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    tier TEXT NOT NULL DEFAULT 'free',
    org_id TEXT REFERENCES orgs(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE orgs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Projects group clips
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    org_id TEXT REFERENCES orgs(id),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_projects_user ON projects(user_id, created_at DESC);

-- Clips are the primary entity
CREATE TABLE clips (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    source_video_url TEXT NOT NULL,
    source_duration_sec FLOAT NOT NULL,
    start_sec FLOAT NOT NULL,
    end_sec FLOAT NOT NULL,
    score FLOAT,
    virality_tags JSONB DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'processing',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_clips_user_time ON clips(user_id, created_at DESC);
CREATE INDEX idx_clips_project ON clips(project_id, created_at DESC);
CREATE INDEX idx_clips_status ON clips(status) WHERE status = 'processing';

-- Clip variants (different aspect ratios, resolutions)
CREATE TABLE clip_variants (
    id TEXT PRIMARY KEY,
    clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    aspect_ratio TEXT NOT NULL,
    resolution TEXT NOT NULL,
    storage_url TEXT NOT NULL,
    captions_url TEXT,
    size_bytes BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_variants_clip ON clip_variants(clip_id);

-- Jobs track async processing
CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    clip_set_id TEXT,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    progress_pct INT DEFAULT 0,
    priority INT DEFAULT 0,
    attempts INT DEFAULT 0,
    max_attempts INT DEFAULT 3,
    worker_id TEXT,
    error_message TEXT,
    payload JSONB NOT NULL DEFAULT '{}',
    result JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_jobs_status_priority ON jobs(status, priority DESC, created_at ASC)
    WHERE status IN ('queued', 'retrying');
CREATE INDEX idx_jobs_user ON jobs(user_id, created_at DESC);

-- Usage tracking for quota enforcement
CREATE TABLE usage_counters (
    user_id TEXT NOT NULL,
    month DATE NOT NULL,
    clips_created INT DEFAULT 0,
    processing_seconds INT DEFAULT 0,
    PRIMARY KEY (user_id, month)
);

-- Webhook deliveries
CREATE TABLE webhook_deliveries (
    id TEXT PRIMARY KEY,
    clip_set_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    url TEXT NOT NULL,
    event TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INT DEFAULT 0,
    next_retry_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_webhooks_pending ON webhook_deliveries(next_retry_at)
    WHERE status = 'pending';
```

### Partitioning for High-Volume Tables

The `jobs` and `audit_log` tables grow indefinitely. Partition them by month:

```sql
-- Partition jobs table by month
CREATE TABLE jobs_partitioned (
    LIKE jobs INCLUDING ALL
) PARTITION BY RANGE (created_at);

CREATE TABLE jobs_2026_06 PARTITION OF jobs_partitioned
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE jobs_2026_07 PARTITION OF jobs_partitioned
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
-- Auto-create future partitions via pg_partman or cron job

-- Drop old partitions (retain 90 days)
-- DROP TABLE jobs_2026_03;
```

## Connection Pooling with PgBouncer

At scale, each API server and worker opens database connections. Without pooling, 10 API servers × 20 connections each = 200 connections, which saturates PostgreSQL's default `max_connections=100`.

PgBouncer sits between the application and PostgreSQL:

```ini
# pgbouncer/pgbouncer.ini
[databases]
minio = host=postgres port=5432 dbname=minio

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt

pool_mode = transaction
default_pool_size = 25
max_client_conn = 500
max_db_connections = 50

server_idle_timeout = 300
server_lifetime = 3600
```

`pool_mode = transaction` means connections are returned to the pool after each transaction completes, not after the client disconnects. This allows 500 clients to share 50 database connections.

Docker Compose with PgBouncer:

```yaml
services:
  pgbouncer:
    image: edoburu/pgbouncer:latest
    environment:
      DATABASE_URL: postgres://minio:secret@postgres:5432/minio
      MAX_CLIENT_CONN: 500
      DEFAULT_POOL_SIZE: 25
      POOL_MODE: transaction
    ports:
      - "6432:6432"
    depends_on:
      - postgres

  api:
    environment:
      DATABASE_URL: postgres://minio:secret@pgbouncer:6432/minio
```

## Read Replicas

Read replicas offload read-heavy queries (clip listing, project browsing) from the primary:

```yaml
# AWS RDS with read replica
# terraform/rds.tf
resource "aws_db_instance" "primary" {
  identifier     = "minio-primary"
  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.r6g.large"
  allocated_storage = 100

  db_name  = "minio"
  username = "minio"
  password = var.db_password

  multi_az            = true
  backup_retention_period = 7
  deletion_protection = true
}

resource "aws_db_instance" "replica" {
  identifier     = "minio-replica-1"
  replicate_source_db = aws_db_instance.primary.identifier
  instance_class = "db.r6g.large"

  # Allow promotion to primary if needed
  lifecycle {
    prevent_destroy = false
  }
}
```

Application-level read/write splitting:

```go
// internal/config/db.go
package config

import "database/sql"

type DBRouter struct {
    Primary *sql.DB
    Replica *sql.DB
}

func (r *DBRouter) Read() *sql.DB {
    if r.Replica != nil {
        return r.Replica
    }
    return r.Primary
}

func (r *DBRouter) Write() *sql.DB {
    return r.Primary
}

// Usage in repository:
func (repo *ClipRepo) List(ctx context.Context, userID string) ([]*Clip, error) {
    rows, err := repo.db.Read().QueryContext(ctx, "SELECT * FROM clips WHERE user_id = $1", userID)
    // ...
}

func (repo *ClipRepo) Create(ctx context.Context, clip *Clip) error {
    _, err := repo.db.Write().ExecContext(ctx, "INSERT INTO clips ...", clip.ID, clip.UserID)
    // ...
}
```

## Redis Scaling (Scaled Production Only)

The free tier does not use Redis. Job queuing is handled by the PostgreSQL `jobs` table with `pg_cron` polling (see `system-architecture/01-overview.md`). Redis is introduced at production scale for workloads that outgrow PostgreSQL-based polling.

Redis handles three distinct workloads with different scaling needs:

### Job Queue (BullMQ)

At scale, replace the PostgreSQL polling loop with Redis Lists for sub-second job dispatch. The recommended approach uses BullMQ (Node.js) or Redis Lists directly (Go):

```go
// Redis List-based job queue
// Enqueue: LPUSH minio:jobs:cpu {job_json}
// Dequeue: BRPOPLPUSH minio:jobs:cpu minio:jobs:processing 30
// Complete: LREM minio:jobs:processing 1 {job_json}
// Retry: RPUSH minio:jobs:cpu {job_json}
```

For Node.js services, BullMQ provides retry logic, rate limiting, and priority queues out of the box. See `performance/01-optimization-strategy.md` §3.1 for the BullMQ TypeScript example.

### Rate Limiting Counters

```go
// Sliding window counter
// Key: rl:{user_id}:{minute_timestamp}
// Value: request count
// TTL: 2 minutes
```

### Caching

```go
// Clip metadata cache
// Key: clip:{clip_id}
// Value: JSON serialized clip
// TTL: 5 minutes
```

### Redis Sentinel (High Availability)

For production, use Redis Sentinel for automatic failover:

```yaml
# docker-compose.redis-sentinel.yml
services:
  redis-primary:
    image: redis:7-alpine
    command: redis-server --appendonly yes --requirepass ${REDIS_PASSWORD}
    volumes:
      - redis-data:/data

  redis-replica-1:
    image: redis:7-alpine
    command: redis-server --replicaof redis-primary 6379 --masterauth ${REDIS_PASSWORD} --requirepass ${REDIS_PASSWORD}

  redis-replica-2:
    image: redis:7-alpine
    command: redis-server --replicaof redis-primary 6379 --masterauth ${REDIS_PASSWORD} --requirepass ${REDIS_PASSWORD}

  sentinel-1:
    image: redis:7-alpine
    command: >
      sh -c 'cat > /etc/sentinel.conf << EOF
      port 26379
      sentinel monitor minio-redis redis-primary 6379 2
      sentinel auth-pass minio-redis ${REDIS_PASSWORD}
      sentinel down-after-milliseconds minio-redis 5000
      sentinel failover-timeout minio-redis 10000
      sentinel parallel-syncs minio-redis 1
      EOF
      redis-sentinel /etc/sentinel.conf'
```

### Redis Cluster (Horizontal Scaling)

When a single Redis node can't handle the throughput, shard across a cluster:

```yaml
# k8s/redis-cluster.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-cluster
  namespace: minio
spec:
  serviceName: redis-cluster
  replicas: 6
  selector:
    matchLabels:
      app: redis-cluster
  template:
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          command:
            - redis-server
            - --cluster-enabled
            - "yes"
            - --cluster-config-file
            - /data/nodes.conf
            - --cluster-node-timeout
            - "5000"
            - --appendonly
            - "yes"
          ports:
            - containerPort: 6379
              name: redis
            - containerPort: 16379
              name: gossip
          volumeMounts:
            - name: data
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 10Gi
```

```bash
# Initialize the cluster (3 masters + 3 replicas)
redis-cli --cluster create \
  redis-cluster-0.redis-cluster:6379 \
  redis-cluster-1.redis-cluster:6379 \
  redis-cluster-2.redis-cluster:6379 \
  redis-cluster-3.redis-cluster:6379 \
  redis-cluster-4.redis-cluster:6379 \
  redis-cluster-5.redis-cluster:6379 \
  --cluster-replicas 1 \
  -a ${REDIS_PASSWORD}
```

## Database Migration Strategy

Migrations are applied using `golang-migrate` during deployment:

```bash
# Create a new migration
migrate create -ext sql -dir migrations -seq add_virality_tags_column

# Apply migrations
migrate -database "$DATABASE_URL" -path migrations up

# Rollback last migration
migrate -database "$DATABASE_URL" -path migrations down 1
```

Migration rules:
1. **Never drop columns** — only add. Old code still references them.
2. **Never rename columns** — add new column, backfill, switch code, drop old column in a later migration.
3. **Always add defaults for new columns** — avoids locking the table during ALTER.
4. **Index creation uses CONCURRENTLY** — avoids blocking writes.

```sql
-- migrations/003_add_virality_tags.up.sql
ALTER TABLE clips ADD COLUMN IF NOT EXISTS virality_tags JSONB DEFAULT '[]';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_clips_tags ON clips USING GIN (virality_tags);
```

## Backup Strategy

```bash
# Daily automated backup (cron on primary server)
pg_dump -Fc -Z9 minio > /backups/minio_$(date +%Y%m%d).dump

# Upload to S3
aws s3 cp /backups/minio_$(date +%Y%m%d).dump s3://minio-backups/postgres/

# Retention: 7 daily, 4 weekly, 12 monthly
aws s3 ls s3://minio-backups/postgres/ | \
  awk '{print $4}' | \
  sort | \
  head -n -7 | \
  xargs -I {} aws s3 rm s3://minio-backups/postgres/{}
```

For AWS RDS, automated backups with 7-day retention are configured directly:

```hcl
resource "aws_db_instance" "primary" {
  backup_retention_period = 7
  backup_window           = "03:00-04:00"
  maintenance_window      = "Mon:04:00-Mon:05:00"
}
```

## Scaling Summary

| Metric | Free Tier | Small | Production |
|--------|-----------|-------|------------|
| PostgreSQL | Single instance | Primary + 1 replica | Multi-AZ + 3 replicas + PgBouncer |
| Max connections | 50 | 100 (via PgBouncer) | 500 (via PgBouncer) |
| Job queue | PostgreSQL `jobs` table + pg_cron | Redis Sentinel (3 nodes) | Redis Cluster (6 nodes) + BullMQ |
| Storage | 20GB local SSD | 100GB EBS gp3 | 500GB+ EBS gp3 + snapshots |
| Backup | Manual pg_dump | Daily automated | Continuous (RDS) + point-in-time |
| Partitions | None | Monthly on jobs | Monthly on jobs + audit_log |
