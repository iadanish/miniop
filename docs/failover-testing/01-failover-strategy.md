# MiniOp Failover Strategy

## Overview

Failover is the automatic or manual switch from a failing component to a healthy backup. MiniOp requires failover at four layers: database, storage, compute, and AI inference. This document defines failover strategies for free-tier single-node deployments and production multi-region clusters.

## Failover Layers

```
┌─────────────────────────────────────────────────────────────┐
│                      Load Balancer                          │
│                   (DNS / Cloud LB)                          │
└─────────────┬───────────────────────────────┬───────────────┘
              │                               │
      ┌───────▼────────┐              ┌───────▼────────┐
      │   Region A     │              │   Region B     │
      │ ┌────────────┐ │              │ ┌────────────┐ │
      │ │ API (3)    │ │              │ │ API (3)    │ │
      │ └─────┬──────┘ │              │ └─────┬──────┘ │
      │       │        │              │       │        │
      │ ┌─────▼──────┐ │   async     │ ┌─────▼──────┐ │
      │ │ PostgreSQL │ │──────rep────│ │ PostgreSQL │ │
      │ │  Primary   │ │             │ │  Replica   │ │
      │ └────────────┘ │              │ └────────────┘ │
      │ ┌────────────┐ │   mc mirror │ ┌────────────┐ │
      │ │   MinIO    │ │─────────────│ │   MinIO    │ │
      │ │  Primary   │ │             │ │  Backup    │ │
      │ └────────────┘ │              │ └────────────┘ │
      └────────────────┘              └────────────────┘
```

## Database Failover

### Free Tier — Manual PostgreSQL Failover

The free tier runs a single PostgreSQL instance. Failover means restoring from backup.

```bash
#!/bin/bash
# /opt/minio/scripts/db-failover.sh
set -euo pipefail

echo "=== PostgreSQL Failover $(date) ==="

# 1. Stop application to prevent writes
cd /opt/minio && docker compose stop api worker

# 2. Check if PostgreSQL is truly down
if docker compose exec postgres pg_isready -U minio 2>/dev/null; then
  echo "PostgreSQL is responding. Aborting failover."
  docker compose start api worker
  exit 0
fi

# 3. Attempt restart first
echo "Attempting restart..."
docker compose restart postgres
sleep 5

if docker compose exec postgres pg_isready -U minio 2>/dev/null; then
  echo "Restart successful."
  docker compose start api worker
  exit 0
fi

# 4. Restore from backup
echo "Restart failed. Restoring from backup..."
LATEST_BACKUP=$(ls -t /backups/postgres/*.dump | head -1)
echo "Using backup: $LATEST_BACKUP"

docker compose down postgres
docker volume rm minio_pgdata || true
docker compose up -d postgres
sleep 10

docker compose exec -T postgres pg_restore -U minio -d minio \
  --clean --if-exists "$LATEST_BACKUP"

# 5. Verify
docker compose exec postgres psql -U minio -c "SELECT count(*) FROM jobs;"

# 6. Restart application
docker compose start api worker

echo "Failover complete. Verify application health."
```

### Production — Automatic PostgreSQL Failover with Patroni

```yaml
# kubernetes/patroni-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: patroni-config
  namespace: minio-prod
data:
  patroni.yml: |
    scope: minio-pg
    namespace: /minio-pg/
    name: ${HOSTNAME}
    
    restapi:
      listen: 0.0.0.0:8008
      connect_address: ${HOSTNAME}:8008
    
    etcd3:
      hosts: etcd-0.etcd:2379,etcd-1.etcd:2379,etcd-2.etcd:2379
    
    bootstrap:
      dcs:
        ttl: 30
        loop_wait: 10
        retry_timeout: 10
        maximum_lag_on_failover: 1048576
        synchronous_mode: true
        postgresql:
          use_pg_rewind: true
          parameters:
            max_connections: 200
            shared_buffers: 2GB
            effective_cache_size: 6GB
            wal_level: replica
            hot_standby: "on"
            max_wal_senders: 5
            max_replication_slots: 5
            wal_log_hints: "on"
            synchronous_commit: "on"
            synchronous_standby_names: "*"
      
      initdb:
        - encoding: UTF8
        - data-checksums
    
    postgresql:
      listen: 0.0.0.0:5432
      connect_address: ${HOSTNAME}:5432
      data_dir: /var/lib/postgresql/data/pgdata
      authentication:
        superuser:
          username: postgres
          password: ${POSTGRES_PASSWORD}
        replication:
          username: replicator
          password: ${REPLICATOR_PASSWORD}
```

```bash
# Monitor Patroni cluster status
kubectl exec -n minio-prod patroni-0 -- patronictl list

# Expected output:
# + Cluster: minio-pg (71234567890) ----+----+-----------+
# | Member    | Host       | Role    | State   | TL | Lag in MB |
# +-----------+------------+---------+---------+----+-----------+
# | patroni-0 | 10.0.1.10  | Leader  | running |  3 |           |
# | patroni-1 | 10.0.1.11  | Replica | running |  3 |         0 |
# | patroni-2 | 10.0.1.12  | Replica | running |  3 |         0 |
# +-----------+------------+---------+---------+----+-----------+

# Manual switchover (planned)
kubectl exec -n minio-prod patroni-0 -- \
  patronictl switchover --master patroni-0 --candidate patroni-1 --force

# Failover is automatic when:
# - Leader becomes unreachable for 30 seconds (ttl)
# - Leader PostgreSQL crashes
# - Leader falls behind by > 1MB (maximum_lag_on_failover)
```

## Storage Failover

### Free Tier — MinIO Single Node

```bash
#!/bin/bash
# /opt/minio/scripts/storage-failover.sh
set -euo pipefail

MINIO_DATA="/var/lib/minio/data"
MINIO_BACKUP="/backups/minio/latest"

# Check if MinIO is responding
if ! mc admin info local 2>/dev/null; then
  echo "MinIO not responding. Attempting restart..."
  docker compose restart minio
  sleep 10
  
  if ! mc admin info local 2>/dev/null; then
    echo "Restart failed. Restoring from backup..."
    docker compose stop minio
    
    # Restore data
    rsync -av --delete "$MINIO_BACKUP/" "$MINIO_DATA/"
    
    docker compose start minio
    sleep 10
    
    # Verify
    mc admin info local
    echo "Storage restored from backup."
  fi
fi
```

### Production — MinIO Distributed with Erasure Coding

```yaml
# kubernetes/minio-distributed.yaml
apiVersion: minio.min.io/v2
kind: Tenant
metadata:
  name: minio-prod
  namespace: minio-prod
spec:
  image: minio/minio:RELEASE.2026-06-15T00-00-00Z
  pools:
  - servers: 4
    volumesPerServer: 4
    volumeClaimTemplate:
      spec:
        accessModes: [ReadWriteOnce]
        resources:
          requests:
            storage: 500Gi
        storageClassName: gp3
  configuration:
    name: minio-config
  requestAutoCert: true
  certConfig:
    commonName: minio-prod
    organizationName: MiniOp
    dnsNames:
    - minio-prod.minio-prod.svc.cluster.local
  features:
    bucketDNS: false
  
  # Erasure coding: 4 servers x 4 volumes = 16 drives
  # Parity: 4 (tolerates 4 drive failures)
  # Effective storage: 12/16 = 75%
  
  env:
  - name: MINIO_STORAGE_CLASS_STANDARD
    value: "EC:4"
  - name: MINIO_PROMETHEUS_AUTH_TYPE
    value: "public"
```

```bash
# Check MinIO cluster health
kubectl exec -n minio-prod minio-prod-pool-0-0 -- mc admin info local

# Drive failure simulation
kubectl exec -n minio-prod minio-prod-pool-0-1 -- rm -rf /data-1/*
# MinIO continues serving from remaining drives
# Auto-heal rebuilds data when drive is replaced

# Monitor healing progress
kubectl exec -n minio-prod minio-prod-pool-0-0 -- mc admin heal local -r
```

## Compute Failover

### Free Tier — Docker Restart Policies

```yaml
# docker-compose.yml
services:
  api:
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 2G
          cpus: '2.0'
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  worker:
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 4G
          cpus: '4.0'
    healthcheck:
      test: ["CMD", "python", "-c", "import redis; r=redis.Redis(); r.ping()"]
      interval: 30s
      timeout: 5s
      retries: 3
```

```bash
# Watchdog script for free tier
#!/bin/bash
# /opt/minio/scripts/watchdog.sh — runs via cron every minute

cd /opt/minio

# Check each service
for service in api worker postgres redis minio nginx; do
  status=$(docker compose ps --format json "$service" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('State', 'unknown'))
")
  
  if [ "$status" != "running" ]; then
    echo "[$(date)] $service is $status. Restarting..."
    docker compose restart "$service"
  fi
done

# Check disk space
DISK_USAGE=$(df /var/lib/docker | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$DISK_USAGE" -gt 90 ]; then
  echo "[$(date)] CRITICAL: Disk usage at ${DISK_USAGE}%"
  docker system prune -f --volumes
fi
```

### Production — Kubernetes Self-Healing

```yaml
# kubernetes/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio-api
  namespace: minio-prod
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: minio-api
  template:
    metadata:
      labels:
        app: minio-api
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: minio-api
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values: [minio-api]
              topologyKey: kubernetes.io/hostname
      containers:
      - name: api
        image: minio/api:latest
        ports:
        - containerPort: 8000
        livenessProbe:
          httpGet:
            path: /health/live
            port: 8000
          initialDelaySeconds: 15
          periodSeconds: 10
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 8000
          initialDelaySeconds: 5
          periodSeconds: 5
          failureThreshold: 3
        startupProbe:
          httpGet:
            path: /health/live
            port: 8000
          failureThreshold: 30
          periodSeconds: 10
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 2000m
            memory: 2Gi
```

```bash
# Monitor pod health
kubectl get pods -n minio-prod -l app=minio-api -o wide

# Check recent failovers
kubectl get events -n minio-prod --sort-by='.lastTimestamp' | grep -E "Unhealthy|Killing|BackOff"

# Verify zero-downtime deployment
kubectl rollout status deployment/minio-api -n minio-prod --timeout=300s
```

## AI Inference Failover

```python
# minio/services/ai_failover.py
import httpx
import logging
from minio.circuit_breakers import AI_INFERENCE_CB
from minio.circuit_breaker import CircuitOpenError
from minio.errors import APIError, ErrorCode

logger = logging.getLogger("minio.ai_failover")

class AIInferenceService:
    def __init__(self, endpoints: list[str]):
        self.endpoints = endpoints
        self.current_index = 0
    
    def extract_clips(self, video_url: str, options: dict) -> dict:
        last_error = None
        
        for i in range(len(self.endpoints)):
            endpoint_index = (self.current_index + i) % len(self.endpoints)
            endpoint = self.endpoints[endpoint_index]
            
            try:
                result = AI_INFERENCE_CB.call(
                    self._call_endpoint, endpoint, video_url, options
                )
                self.current_index = endpoint_index
                return result
            except CircuitOpenError:
                logger.warning(f"AI endpoint {endpoint} circuit open, trying next")
                continue
            except Exception as e:
                last_error = e
                logger.warning(f"AI endpoint {endpoint} failed: {e}")
                continue
        
        raise APIError(
            code=ErrorCode.AI_SERVICE_UNAVAILABLE,
            message=f"All AI endpoints failed: {last_error}",
            status=503,
            retryable=True,
            retry_after=60,
        )
    
    def _call_endpoint(self, endpoint: str, video_url: str, options: dict) -> dict:
        client = httpx.Client(timeout=120)
        response = client.post(
            f"{endpoint}/v1/extract-clips",
            json={"video_url": video_url, **options},
        )
        if response.status_code >= 500:
            raise Exception(f"AI inference error: {response.status_code}")
        response.raise_for_status()
        return response.json()
```

## Failover Testing Schedule

| Test | Frequency | Procedure | Acceptance Criteria |
|---|---|---|---|
| DB restart | Weekly | Kill primary PostgreSQL pod | Auto-restart < 10s, no data loss |
| DB failover | Monthly | Kill primary, verify replica promotes | Promotion < 30s, app reconnects < 60s |
| Storage drive failure | Quarterly | Remove a drive from MinIO pool | Continues serving, healing completes < 1h |
| Full node failure | Quarterly | Drain a Kubernetes node | Pods reschedule < 2 min, no user impact |
| Region failover | Annually | Switch DNS to DR region | Full service in DR < 5 min |

## Failover Runbook Summary

1. **Detect**: Health checks, circuit breakers, monitoring alerts
2. **Isolate**: Stop sending traffic to failed component
3. **Redirect**: Route to healthy backup (automatic or manual)
4. **Verify**: Confirm backup is serving correctly
5. **Recover**: Fix or replace failed component
6. **Restore**: Switch back when primary is healthy
