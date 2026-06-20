# Auto-Scaling — MiniOp Video Clipping Platform

## Why Auto-Scaling for Video Processing

Video processing workloads are bursty by nature. A user uploads a 4-hour podcast and expects clips within minutes. During that burst, the system needs 10x the normal compute capacity. Five minutes later, the queue is empty and those expensive GPU instances should be terminated. Manual scaling can't respond fast enough — auto-scaling is essential for both cost efficiency and user experience.

## Scaling Dimensions

MiniOp scales independently along three axes:

1. **API servers** — scale on request rate and CPU utilization
2. **CPU workers** — scale on FFmpeg job queue depth
3. **GPU workers** — scale on Whisper transcription queue depth

Each dimension has different scaling triggers, cooldown periods, and instance types. They are managed by separate auto-scalers.

## KEDA — Kubernetes Event-Driven Autoscaling

MiniOp uses KEDA for worker auto-scaling because it scales based on Redis queue depth, which is a direct measure of pending work — not a proxy metric like CPU utilization.

### Installation

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.14.0
```

### CPU Worker Auto-Scaler

```yaml
# k8s/autoscaling/cpu-worker-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: minio-cpu-worker-scaler
  namespace: minio
spec:
  scaleTargetRef:
    name: minio-worker-cpu
  minReplicaCount: 1
  maxReplicaCount: 20
  pollingInterval: 15
  cooldownPeriod: 120
  advanced:
    restoreToOriginalReplicaCount: false
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 60
          policies:
            - type: Pods
              value: 4
              periodSeconds: 60
        scaleDown:
          stabilizationWindowSeconds: 300
          policies:
            - type: Percent
              value: 50
              periodSeconds: 120
  triggers:
    - type: redis
      metadata:
        address: redis.minio.svc.cluster.local:6379
        listName: "minio:jobs:transcription"
        listLength: "3"
        activationListLength: "1"
      authenticationRef:
        name: redis-auth
    - type: redis
      metadata:
        address: redis.minio.svc.cluster.local:6379
        listName: "minio:jobs:scene_detection"
        listLength: "3"
        activationListLength: "1"
      authenticationRef:
        name: redis-auth
    - type: redis
      metadata:
        address: redis.minio.svc.cluster.local:6379
        listName: "minio:jobs:clip_generation"
        listLength: "3"
        activationListLength: "1"
      authenticationRef:
        name: redis-auth
```

Key configuration decisions:

- **`minReplicaCount: 1`**: Always keep at least one worker running to avoid cold-start latency
- **`maxReplicaCount: 20`**: Cap at 20 pods to prevent runaway costs
- **`cooldownPeriod: 120`**: Wait 2 minutes after queue empties before scaling down
- **`listLength: "3"`**: Scale up when there are 3+ pending jobs per existing pod
- **`activationListLength: "1"`**: Activate from zero when at least 1 job is queued

### GPU Worker Auto-Scaler

GPU nodes are expensive ($3-5/hour for a T4). The GPU scaler is more aggressive about scaling down:

```yaml
# k8s/autoscaling/gpu-worker-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: minio-gpu-worker-scaler
  namespace: minio
spec:
  scaleTargetRef:
    name: minio-worker-gpu
  minReplicaCount: 0
  maxReplicaCount: 5
  pollingInterval: 30
  cooldownPeriod: 180
  advanced:
    restoreToOriginalReplicaCount: false
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 30
          policies:
            - type: Pods
              value: 2
              periodSeconds: 60
        scaleDown:
          stabilizationWindowSeconds: 600
          policies:
            - type: Pods
              value: 1
              periodSeconds: 300
  triggers:
    - type: redis
      metadata:
        address: redis.minio.svc.cluster.local:6379
        listName: "minio:jobs:transcription"
        listLength: "2"
        activationListLength: "1"
      authenticationRef:
        name: redis-auth
```

GPU worker differences:
- **`minReplicaCount: 0`**: Scale to zero when idle (save GPU costs)
- **`cooldownPeriod: 180`**: 3-minute cooldown (GPU startup takes ~90 seconds)
- **`maxReplicaCount: 5`**: Limit GPU instances to control costs
- **`scaleDown stabilizationWindowSeconds: 600`**: Wait 10 minutes before scaling down to avoid thrashing

### GPU Node Provisioning

GPU nodes are in a separate node group with a taint to prevent non-GPU workloads from scheduling:

```hcl
# terraform/eks-gpu-nodes.tf
resource "aws_eks_node_group" "gpu" {
  cluster_name    = aws_eks_cluster.minio.name
  node_group_name = "minio-gpu"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.private_subnet_ids

  instance_types = ["g4dn.xlarge"]  # T4 GPU, 4 vCPU, 16GB RAM
  capacity_type  = "SPOT"            # Use spot for 70% cost savings

  scaling_config {
    desired_size = 0
    min_size     = 0
    max_size     = 5
  }

  taint {
    key    = "nvidia.com/gpu"
    value  = "present"
    effect = "NO_SCHEDULE"
  }

  labels = {
    "accelerator" = "nvidia-tesla-t4"
  }
}
```

Spot instances are acceptable for GPU workers because:
1. Jobs are checkpointed — a spot interruption just requeues the job
2. Transcription jobs are idempotent — running them twice produces the same result
3. The queue consumer handles visibility timeouts gracefully

## API Server Auto-Scaling (HPA)

API servers use the standard Kubernetes HPA with CPU and custom metrics:

```yaml
# k8s/autoscaling/api-hpa.yaml
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
    - type: Pods
      pods:
        metric:
          name: http_requests_per_second
        target:
          type: AverageValue
          averageValue: "100"
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
        - type: Percent
          value: 100
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 25
          periodSeconds: 120
```

## Cost Estimation by Scale

| Scale | CPU Workers | GPU Workers | API Servers | Monthly Cost |
|-------|------------|-------------|-------------|--------------|
| Free (self-hosted) | 1 (t3.large) | 0 | 1 | ~$60 |
| Small (100 users) | 2-3 (c5.xlarge) | 1 (g4dn.xlarge spot) | 2 (t3.large) | ~$400 |
| Medium (1K users) | 5-10 (c5.2xlarge) | 2-3 (g4dn.xlarge spot) | 3-5 (c5.xlarge) | ~$1,500 |
| Large (10K users) | 10-20 (c5.4xlarge) | 3-5 (g4dn.2xlarge spot) | 5-10 (c5.2xlarge) | ~$5,000 |

## Scaling Policies — Detailed Behavior

### Scale-Up Scenario

1. User uploads a 2-hour video at 2:00 PM
2. API server creates transcription + scene detection jobs in Redis queue
3. KEDA detects queue depth > threshold (15 seconds polling)
4. KEDA triggers HPA to scale CPU workers from 2 → 6 pods
5. New pods start in ~30 seconds, begin processing jobs
6. If queue is still deep, scale again after 60 seconds (up to max 20)

### Scale-Down Scenario

1. All jobs complete at 2:15 PM
2. Queue depth drops to 0
3. KEDA waits 120 seconds (cooldown period) to confirm queue stays empty
4. HPA begins gradual scale-down: 6 → 4 → 2 over 5 minutes
5. Min replica (1) remains active

### Scale-to-Zero (GPU Workers)

1. No transcription jobs for 10+ minutes
2. GPU worker HPA scales to 0 replicas
3. GPU node group scales to 0 nodes (cluster autoscaler removes idle nodes)
4. Next transcription job arrives → KEDA scales GPU workers to 1
5. Cluster autoscaler provisions a GPU node (~90 seconds)
6. Total cold start: ~2 minutes from job submission to processing start

## Preventing Scaling Thrashing

Thrashing (rapid scale-up followed by immediate scale-down) is prevented by:

1. **Stabilization windows**: Scale-up waits 30-60 seconds; scale-down waits 300-600 seconds
2. **Gradual scale-down**: Never drop more than 50% of pods in a single scale event
3. **Cooldown periods**: KEDA waits 2-3 minutes after queue empties before scaling down
4. **Min replicas**: Always keep at least 1 API server and 1 CPU worker running

## Free-Tier Auto-Scaling

The free-tier single-server deployment uses a simpler approach — process-based scaling within the Docker Compose setup:

```yaml
# docker-compose.yml
services:
  worker:
    image: minio/server:latest
    command: ["worker"]
    environment:
      WORKER_CONCURRENCY: "2"  # 2 concurrent jobs on a 4-core machine
    deploy:
      resources:
        limits:
          cpus: "2.0"
          memory: "4G"
```

The free tier doesn't auto-scale — the user manually adjusts `WORKER_CONCURRENCY` based on their hardware. This is intentional: auto-scaling adds complexity that single-server deployments don't need.

## Monitoring Auto-Scaling

```yaml
# Prometheus alerts for scaling issues
groups:
  - name: minio-scaling-alerts
    rules:
      - alert: QueueBacklogHigh
        expr: redis_list_length{queue=~"minio:jobs:*"} > 50
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Job queue depth is {{ $value }} — workers may be underprovisioned"

      - alert: WorkerAtMaxCapacity
        expr: kube_deployment_status_replicas{deployment="minio-worker-cpu"} == 20
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "CPU workers at max replica count (20) — increase maxReplicaCount or optimize processing"

      - alert: GPUNodeProvisioningSlow
        expr: time() - keda_scaledobject_last_active_time{scaledobject="minio-gpu-worker-scaler"} > 300
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "GPU workers requested but nodes not ready for 5+ minutes"
```

## Scaling Runbook

When scaling issues occur:

```bash
# Check current queue depth
redis-cli llen minio:jobs:transcription
redis-cli llen minio:jobs:scene_detection
redis-cli llen minio:jobs:clip_generation

# Check KEDA scaled object status
kubectl get scaledobjects -n minio
kubectl describe scaledobject minio-cpu-worker-scaler -n minio

# Check HPA status
kubectl get hpa -n minio

# Manual scale if auto-scaler is stuck
kubectl scale deployment minio-worker-cpu --replicas=10 -n minio

# Check node capacity
kubectl top nodes
kubectl describe nodes | grep -A 5 "Allocated resources"
```
