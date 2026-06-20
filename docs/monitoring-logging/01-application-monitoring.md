# Application Monitoring

This document covers monitoring strategies for MiniOp across free-tier deployments and scaled production environments.

## Architecture Overview

MiniOp's monitoring stack tracks three layers: infrastructure metrics (CPU, memory, disk), application metrics (request latency, queue depth, clip processing time), and business metrics (clips generated, user signups, conversion rates). Each layer uses different tools depending on deployment tier.

## Free Tier: Prometheus + Grafana on a Single Node

For development or low-traffic deployments, run Prometheus and Grafana alongside MiniOp on a single machine.

### Docker Compose Setup

```yaml
# docker-compose.monitoring.yml
version: "3.8"
services:
  prometheus:
    image: prom/prometheus:v2.53.0
    ports:
      - "9090:9090"
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus-data:/prometheus
    command:
      - "--config.file=/etc/prometheus/prometheus.yml"
      - "--storage.tsdb.retention.time=15d"
      - "--storage.tsdb.retention.size=5GB"

  grafana:
    image: grafana/grafana:11.1.0
    ports:
      - "3001:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD: "${GRAFANA_ADMIN_PASSWORD}"
      GF_USERS_ALLOW_SIGN_UP: "false"
    volumes:
      - grafana-data:/var/lib/grafana
      - ./monitoring/grafana/dashboards:/etc/grafana/provisioning/dashboards
      - ./monitoring/grafana/datasources:/etc/grafana/provisioning/datasources

  node-exporter:
    image: prom/node-exporter:v1.8.1
    ports:
      - "9100:9100"
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro

volumes:
  prometheus-data:
  grafana-data:
```

### Prometheus Configuration

```yaml
# monitoring/prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: "miniop-api"
    static_configs:
      - targets: ["host.docker.internal:8000"]
    metrics_path: "/metrics"

  - job_name: "miniop-worker"
    static_configs:
      - targets: ["host.docker.internal:8001"]
    metrics_path: "/metrics"

  - job_name: "node"
    static_configs:
      - targets: ["node-exporter:9100"]

  - job_name: "redis"
    static_configs:
      - targets: ["host.docker.internal:6379"]

  - job_name: "postgres"
    static_configs:
      - targets: ["host.docker.internal:5432"]
```

### Application Metrics Endpoint

MiniOp exposes Prometheus metrics from the FastAPI application:

```python
# app/monitoring/metrics.py
from prometheus_client import Counter, Histogram, Gauge, generate_latest, CONTENT_TYPE_LATEST
from fastapi import Response

CLIPS_CREATED = Counter(
    "miniop_clips_created_total",
    "Total clips generated",
    ["tier", "source_type"]
)

CLIP_PROCESSING_DURATION = Histogram(
    "miniop_clip_processing_seconds",
    "Time to process a clip",
    buckets=[1, 5, 10, 30, 60, 120, 300, 600]
)

ACTIVE_PROCESSING = Gauge(
    "miniop_active_processing_jobs",
    "Currently processing clips"
)

API_REQUEST_DURATION = Histogram(
    "miniop_http_request_duration_seconds",
    "HTTP request latency",
    ["method", "endpoint", "status"],
    buckets=[0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
)

QUEUE_DEPTH = Gauge(
    "miniop_queue_depth",
    "Number of jobs waiting in queue",
    ["queue_name"]
)

STORAGE_USED_BYTES = Gauge(
    "miniop_storage_used_bytes",
    "Total storage consumed"
)

async def metrics_endpoint():
    return Response(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST
    )
```

Integrate metrics collection into the request pipeline with middleware:

```python
# app/monitoring/middleware.py
import time
from starlette.middleware.base import BaseHTTPMiddleware

class MetricsMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        start = time.perf_counter()
        response = await call_next(request)
        duration = time.perf_counter() - start

        API_REQUEST_DURATION.labels(
            method=request.method,
            endpoint=request.url.path,
            status=response.status_code
        ).observe(duration)

        return response
```

Register the middleware and metrics endpoint in your FastAPI app:

```python
# app/main.py
from app.monitoring.metrics import metrics_endpoint
from app.monitoring.middleware import MetricsMiddleware

app = FastAPI(title="MiniOp")
app.add_middleware(MetricsMiddleware)
app.add_api_route("/metrics", metrics_endpoint, methods=["GET"])
```

## Scaled Production: Managed Observability Stack

For production with multiple workers, use a managed or self-hosted observability platform.

### Option A: Grafana Cloud (Free Tier Available)

Grafana Cloud's free tier includes 10K metrics series, 50GB logs, and 50GB traces. Suitable for early production.

```yaml
# monitoring/prometheus.yml - Remote write to Grafana Cloud
global:
  scrape_interval: 10s

remote_write:
  - url: "https://prometheus-us-central1.grafana.net/api/prom/push"
    basic_auth:
      username: "${GRAFANA_CLOUD_INSTANCE_ID}"
      password: "${GRAFANA_CLOUD_API_KEY}"

scrape_configs:
  - job_name: "miniop-api"
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        regex: miniop-api
        action: keep
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
```

### Option B: Datadog

For Datadog, deploy the agent as a DaemonSet on Kubernetes and use the OpenTelemetry library:

```python
# app/monitoring/datadog_setup.py
from ddtrace import patch, tracer
from ddtrace.contrib.fastapi import TraceMiddleware

patch(fastapi=True)

def configure_datadog(app):
    tracer.configure(
        hostname="datadog-agent",
        port=8126,
        service="miniop",
        env=os.getenv("ENVIRONMENT", "production"),
        version=os.getenv("APP_VERSION", "unknown")
    )
```

### Grafana Dashboard Panels

Create a dashboard with these critical panels. Provision via JSON:

```json
{
  "panels": [
    {
      "title": "Request Latency (p50/p95/p99)",
      "targets": [
        {
          "expr": "histogram_quantile(0.50, rate(miniop_http_request_duration_seconds_bucket[5m]))",
          "legendFormat": "p50"
        },
        {
          "expr": "histogram_quantile(0.95, rate(miniop_http_request_duration_seconds_bucket[5m]))",
          "legendFormat": "p95"
        },
        {
          "expr": "histogram_quantile(0.99, rate(miniop_http_request_duration_seconds_bucket[5m]))",
          "legendFormat": "p99"
        }
      ]
    },
    {
      "title": "Clip Processing Duration",
      "targets": [
        {
          "expr": "rate(miniop_clip_processing_seconds_sum[5m]) / rate(miniop_clip_processing_seconds_count[5m])",
          "legendFormat": "avg processing time"
        }
      ]
    },
    {
      "title": "Queue Depth",
      "targets": [
        {
          "expr": "miniop_queue_depth",
          "legendFormat": "{{queue_name}}"
        }
      ]
    },
    {
      "title": "Error Rate",
      "targets": [
        {
          "expr": "rate(miniop_http_request_duration_seconds_count{status=~\"5..\"}[5m]) / rate(miniop_http_request_duration_seconds_count[5m])",
          "legendFormat": "5xx rate"
        }
      ]
    }
  ]
}
```

## Health Check Endpoints

MiniOp exposes structured health checks consumed by load balancers and orchestrators:

```python
# app/health.py
from pydantic import BaseModel
from enum import Enum

class HealthStatus(str, Enum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"

class HealthResponse(BaseModel):
    status: HealthStatus
    version: str
    uptime_seconds: float
    checks: dict[str, HealthStatus]

@app.get("/health", response_model=HealthResponse)
async def health_check():
    checks = {}

    # Database connectivity
    try:
        await database.execute("SELECT 1")
        checks["database"] = HealthStatus.HEALTHY
    except Exception:
        checks["database"] = HealthStatus.UNHEALTHY

    # Redis connectivity
    try:
        await redis.ping()
        checks["redis"] = HealthStatus.HEALTHY
    except Exception:
        checks["redis"] = HealthStatus.UNHEALTHY

    # Storage availability
    try:
        storage.stat("health-check")
        checks["storage"] = HealthStatus.HEALTHY
    except Exception:
        checks["storage"] = HealthStatus.DEGRADED

    overall = HealthStatus.HEALTHY
    if HealthStatus.UNHEALTHY in checks.values():
        overall = HealthStatus.UNHEALTHY
    elif HealthStatus.DEGRADED in checks.values():
        overall = HealthStatus.DEGRADED

    return HealthResponse(
        status=overall,
        version=get_version(),
        uptime_seconds=time.monotonic() - START_TIME,
        checks=checks
    )
```

On Kubernetes, configure liveness and readiness probes:

```yaml
# k8s/deployment.yaml
livenessProbe:
  httpGet:
    path: /health
    port: 8000
  initialDelaySeconds: 10
  periodSeconds: 30
  failureThreshold: 3
readinessProbe:
  httpGet:
    path: /health
    port: 8000
  initialDelaySeconds: 5
  periodSeconds: 10
  failureThreshold: 2
```

## Key Metrics to Track

| Metric | Free Tier Threshold | Production Threshold | Action |
|--------|-------------------|---------------------|--------|
| API p99 latency | > 2s | > 500ms | Investigate slow endpoints |
| Clip processing time | > 600s | > 300s | Check FFmpeg worker scaling |
| Queue depth | > 50 | > 200 | Scale workers |
| Error rate (5xx) | > 1% | > 0.1% | Page on-call |
| Disk usage | > 80% | > 70% | Prune old clips or expand storage |
| Memory usage (worker) | > 90% | > 80% | Worker memory leak or FFmpeg spike |

## Operational Commands

```bash
# Check Prometheus targets status
curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, health: .health}'

# Query a specific metric
curl -s 'http://localhost:9090/api/v1/query?query=miniop_queue_depth' | jq '.data.result'

# Force a Grafana dashboard reload
curl -X POST http://admin:password@localhost:3001/api/admin/provisioning/dashboards/reload

# Generate a diagnostic snapshot
curl http://localhost:8000/metrics > metrics_snapshot_$(date +%s).txt
```
