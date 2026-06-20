# Horizontal Scaling — MiniOp Video Clipping Platform

## Scaling Overview

MiniOp's architecture is designed to scale horizontally from a single Docker Compose instance to a multi-node Kubernetes cluster. The key scaling units are the API servers (stateless, scale on request volume), the workers (CPU/GPU-bound, scale on queue depth), and the database (scale via read replicas and connection pooling). This document covers the practical steps for scaling each component.

## Scaling Units

```
                    ┌─────────────────────────────────────┐
                    │            Load Balancer             │
                    └──────────┬──────────┬───────────────┘
                               │          │
                    ┌──────────▼──┐  ┌────▼──────────┐
                    │  API Server │  │  API Server    │
                    │  Instance 1 │  │  Instance 2    │
                    └──────┬──────┘  └───────┬────────┘
                           │                 │
                    ┌──────▼─────────────────▼────────┐
                    │         Redis (Queue)            │
                    └──────┬──────────┬───────────────┘
                           │          │
                    ┌──────▼──┐  ┌────▼──────────┐
                    │ Worker  │  │  Worker        │
                    │ (CPU)   │  │  (GPU)         │
                    └─────────┘  └────────────────┘
```

## API Server Scaling

API servers are stateless — they hold no session state, no in-memory caches, and no local file state. Every request is authenticated via JWT (no server-side sessions), and all data comes from PostgreSQL and Redis. This means you can run as many API server instances as you need behind a load balancer.

### Docker Compose (Small Scale)

```yaml
# docker-compose.scale.yml
services:
  api:
    image: minio/server:latest
    command: ["server"]
    deploy:
      replicas: 3
    ports:
      - "8080-8082:8080"
    environment:
      - DATABASE_URL=postgres://minio:secret@postgres:5432/minio
      - REDIS_URL=redis://redis:6379
    depends_on:
      - postgres
      - redis
```

```bash
docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d --scale api=3
```

### Kubernetes (Production)

```yaml
# k8s/api-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio-api
  namespace: minio
spec:
  replicas: 3
  selector:
    matchLabels:
      app: minio-api
  template:
    metadata:
      labels:
        app: minio-api
    spec:
      containers:
        - name: api
          image: minio/server:v1.2.3
          command: ["server"]
          ports:
            - containerPort: 8080
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: minio-secrets
                  key: database-url
            - name: REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: minio-secrets
                  key: redis-url
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2"
              memory: "2Gi"
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 20
```

### Horizontal Pod Autoscaler for API

```yaml
# k8s/api-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: minio-api-hpa
  namespace: minio
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: minio-api
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
```

## Worker Scaling

Workers are the bottleneck for video processing. They consume jobs from a Redis-backed queue and execute CPU-intensive (FFmpeg) or GPU-intensive (Whisper) tasks. Workers scale based on queue depth, not request volume.

### Worker Architecture

```go
// internal/queue/consumer.go
package queue

import (
    "context"
    "log/slog"
    "sync"
    "time"
)

type Consumer struct {
    rdb         RedisClient
    queueName   string
    processors  map[string]Processor
    concurrency int
    maxRetries  int
}

func (c *Consumer) Run(ctx context.Context) error {
    var wg sync.WaitGroup

    for i := 0; i < c.concurrency; i++ {
        wg.Add(1)
        go func(workerID int) {
            defer wg.Done()
            slog.Info("worker started", "worker_id", workerID)

            for {
                select {
                case <-ctx.Done():
                    slog.Info("worker stopping", "worker_id", workerID)
                    return
                default:
                    job, err := c.dequeue(ctx, 5*time.Second)
                    if err != nil {
                        continue // timeout or transient error
                    }

                    c.process(ctx, workerID, job)
                }
            }
        }(i)
    }

    wg.Wait()
    return nil
}

func (c *Consumer) process(ctx context.Context, workerID int, job Job) {
    processor, ok := c.processors[job.Type]
    if !ok {
        slog.Error("unknown job type", "type", job.Type, "job_id", job.ID)
        return
    }

    slog.Info("processing job", "worker_id", workerID, "job_id", job.ID, "type", job.Type)
    start := time.Now()

    if err := processor.Process(ctx, job); err != nil {
        slog.Error("job failed", "job_id", job.ID, "error", err, "attempts", job.Attempts)
        if job.Attempts < c.maxRetries {
            c.retry(ctx, job)
        } else {
            c.moveToDeadLetter(ctx, job)
        }
        return
    }

    slog.Info("job completed", "job_id", job.ID, "duration_ms", time.Since(start).Milliseconds())
}
```

### CPU Workers (FFmpeg)

CPU workers handle scene detection, clip generation, and caption burning. They scale linearly with CPU cores.

```yaml
# k8s/worker-cpu-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio-worker-cpu
  namespace: minio
spec:
  replicas: 3
  selector:
    matchLabels:
      app: minio-worker
      worker-type: cpu
  template:
    spec:
      containers:
        - name: worker
          image: minio/server:v1.2.3
          command: ["worker"]
          env:
            - name: WORKER_CONCURRENCY
              value: "4"  # 4 FFmpeg jobs per pod
            - name: WORKER_TYPE
              value: "cpu"
          resources:
            requests:
              cpu: "2"
              memory: "4Gi"
            limits:
              cpu: "4"
              memory: "8Gi"
```

### GPU Workers (Whisper)

GPU workers handle transcription. They require NVIDIA GPU nodes.

```yaml
# k8s/worker-gpu-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio-worker-gpu
  namespace: minio
spec:
  replicas: 2
  selector:
    matchLabels:
      app: minio-worker
      worker-type: gpu
  template:
    spec:
      nodeSelector:
        accelerator: nvidia-tesla-t4
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      containers:
        - name: worker
          image: minio/server-gpu:v1.2.3
          command: ["worker"]
          env:
            - name: WORKER_CONCURRENCY
              value: "2"  # 2 Whisper jobs per GPU
            - name: WORKER_TYPE
              value: "gpu"
            - name: WHISPER_DEVICE
              value: "cuda"
          resources:
            requests:
              cpu: "2"
              memory: "8Gi"
              nvidia.com/gpu: "1"
            limits:
              cpu: "4"
              memory: "16Gi"
              nvidia.com/gpu: "1"
```

### Queue-Based Autoscaling

Workers scale based on Redis queue depth using KEDA (Kubernetes Event-driven Autoscaling):

```yaml
# k8s/worker-cpu-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: minio-worker-cpu-scaler
  namespace: minio
spec:
  scaleTargetRef:
    name: minio-worker-cpu
  minReplicaCount: 1
  maxReplicaCount: 20
  pollingInterval: 15
  cooldownPeriod: 60
  triggers:
    - type: redis
      metadata:
        address: redis.minio.svc.cluster.local:6379
        listName: "minio:jobs:cpu"
        listLength: "5"  # Scale up when queue depth > 5 per pod
```

## Load Balancing

### Kubernetes Service

```yaml
# k8s/api-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: minio-api
  namespace: minio
spec:
  selector:
    app: minio-api
  ports:
    - port: 80
      targetPort: 8080
  type: ClusterIP
```

### Ingress

```yaml
# k8s/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: minio-api
  namespace: minio
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/certificate-arn: $CERT_ARN
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS": 443}]'
spec:
  rules:
    - host: api.minio.dev
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: minio-api
                port:
                  number: 80
```

## Scaling Checklist

| Component | Free Tier | Small (10x) | Production (100x) |
|-----------|-----------|-------------|-------------------|
| API servers | 1 | 3 | 10+ (HPA) |
| CPU workers | 1 | 3 | 20+ (KEDA) |
| GPU workers | 0 | 1 | 5+ (KEDA) |
| PostgreSQL | Single | Primary + 1 replica | Primary + 3 replicas + PgBouncer |
| Redis | Single | Sentinel (3 nodes) | Cluster (6 nodes) |
| Object storage | Local MinIO | S3 bucket | S3 + CloudFront CDN |

## Monitoring Scaling Metrics

Key metrics to watch when scaling:

```yaml
# Prometheus recording rules
groups:
  - name: minio-scaling
    rules:
      - record: minio:queue_depth
        expr: redis_list_length{queue="minio:jobs"}

      - record: minio:worker_utilization
        expr: worker_active_jobs / worker_concurrency

      - record: minio:api_rps
        expr: rate(http_requests_total[5m])

      - record: minio:api_p95_latency
        expr: histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))
```

Scale up when:
- Queue depth > 5 per worker for 2+ minutes
- Worker utilization > 80% sustained
- API p95 latency > 500ms

Scale down when:
- Queue depth = 0 for 5+ minutes
- Worker utilization < 30% sustained
- API p95 latency < 100ms with current replica count
