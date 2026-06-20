# Logging Strategy

This document defines the logging architecture, structured log formats, retention policies, and query patterns for MiniOp across free-tier and production deployments.

## Logging Architecture

MiniOp uses structured JSON logging throughout. Every log line is machine-parseable, includes correlation IDs for request tracing, and is written to stdout for container-native collection. The stack uses Loki for free-tier and Elasticsearch/OpenSearch for production.

## Free Tier: Promtail + Loki + Grafana

Run Loki alongside Prometheus in the existing Docker Compose setup:

```yaml
# Add to docker-compose.monitoring.yml
  loki:
    image: grafana/loki:3.0.0
    ports:
      - "3100:3100"
    volumes:
      - loki-data:/loki
    command: -config.file=/etc/loki/local-config.yaml

  promtail:
    image: grafana/promtail:3.0.0
    volumes:
      - ./monitoring/promtail.yml:/etc/promtail/config.yml
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
    command: -config.file=/etc/promtail/config.yml

volumes:
  loki-data:
```

### Promtail Configuration

```yaml
# monitoring/promtail.yml
server:
  http_listen_port: 9080

positions:
  filename: /tmp/positions.yaml

clients:
  - url: http://loki:3100/loki/api/v1/push

scrape_configs:
  - job_name: docker
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 5s
    relabel_configs:
      - source_labels: ["__meta_docker_container_label_com_docker_compose_service"]
        target_label: "service"
      - source_labels: ["__meta_docker_container_name"]
        target_label: "container"
    pipeline_stages:
      - docker: {}
      - json:
          expressions:
            level: level
            request_id: request_id
            user_id: user_id
            duration_ms: duration_ms
            method: method
            path: path
            status: status
      - labels:
          level:
          request_id:
      - metrics:
          log_lines_total:
            type: Counter
            description: "Total log lines"
            source: level
            config:
              action: inc
```

### Grafana Data Source

```yaml
# monitoring/grafana/datasources/loki.yml
apiVersion: 1
datasources:
  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100
    jsonData:
      maxLines: 1000
    isDefault: false
```

## Structured Log Format

All MiniOp services emit JSON logs with a consistent schema:

```python
# app/logging_config.py
import structlog
import logging
import sys

def setup_logging(json_output: bool = True):
    processors = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
    ]

    if json_output:
        processors.append(structlog.processors.JSONRenderer())
    else:
        processors.append(structlog.dev.ConsoleRenderer())

    structlog.configure(
        processors=processors,
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.getLevelName(os.getenv("LOG_LEVEL", "INFO"))
        ),
        cache_logger_on_first_use=True,
    )

logger = structlog.get_logger()
```

### Log Entry Schema

Every log line follows this structure:

```json
{
  "event": "clip_processing_started",
  "level": "info",
  "timestamp": "2025-01-15T14:32:01.234567Z",
  "request_id": "req_a1b2c3d4e5f6",
  "user_id": "usr_12345",
  "clip_id": "clip_789",
  "source_url": "https://youtube.com/watch?v=...",
  "duration_ms": null,
  "service": "miniop-worker",
  "environment": "production",
  "version": "1.4.2"
}
```

After processing completes:

```json
{
  "event": "clip_processing_completed",
  "level": "info",
  "timestamp": "2025-01-15T14:35:22.891234Z",
  "request_id": "req_a1b2c3d4e5f6",
  "user_id": "usr_12345",
  "clip_id": "clip_789",
  "duration_ms": 201656,
  "output_size_bytes": 15728640,
  "highlights_found": 3,
  "service": "miniop-worker",
  "environment": "production"
}
```

## Request Correlation Middleware

Propagate a request ID through every log entry for end-to-end tracing:

```python
# app/middleware/correlation.py
import uuid
import structlog
from starlette.middleware.base import BaseHTTPMiddleware

logger = structlog.get_logger()

class CorrelationMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        request_id = request.headers.get("X-Request-ID", str(uuid.uuid4()))

        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(
            request_id=request_id,
            method=request.method,
            path=request.url.path,
            client_ip=request.client.host if request.client else None,
        )

        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id

        return response
```

Bind `user_id` after authentication:

```python
# app/middleware/auth.py
async def get_current_user(request):
    user = await authenticate(request)
    structlog.contextvars.bind_contextvars(user_id=user.id)
    return user
```

## Log Levels by Component

| Component | DEBUG | INFO | WARN | ERROR |
|-----------|-------|------|------|-------|
| API Server | Request/response bodies | Requests, auth events | Slow queries (>1s), rate limiting | Unhandled exceptions, DB failures |
| Worker | FFmpeg command lines | Job start/end, duration | Retry attempts, slow processing | Job failures, OOM kills |
| Scheduler | Cron evaluations | Job dispatching | Missed schedules | Scheduler crashes |
| Uploader | Chunk progress | Upload start/complete | Retry on transient errors | Permanent upload failures |

Set per-component levels via environment variable:

```bash
LOG_LEVEL=INFO                  # Default for all
LOG_LEVEL_WORKER=DEBUG          # Override for worker only
LOG_LEVEL_API=WARNING           # Override for API only
```

## Scaled Production: ELK Stack (Elasticsearch + Logstash + Kibana)

For production with multiple nodes, deploy the ELK stack on Kubernetes:

```yaml
# k8s/elasticsearch.yaml (StatefulSet)
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: elasticsearch
spec:
  serviceName: elasticsearch
  replicas: 3
  selector:
    matchLabels:
      app: elasticsearch
  template:
    metadata:
      labels:
        app: elasticsearch
    spec:
      containers:
        - name: elasticsearch
          image: docker.elastic.co/elasticsearch/elasticsearch:8.14.0
          ports:
            - containerPort: 9200
            - containerPort: 9300
          env:
            - name: cluster.name
              value: miniop-logs
            - name: discovery.seed_hosts
              value: "elasticsearch-0.elasticsearch,elasticsearch-1.elasticsearch,elasticsearch-2.elasticsearch"
            - name: cluster.initial_master_nodes
              value: "elasticsearch-0,elasticsearch-1,elasticsearch-2"
            - name: ES_JAVA_OPTS
              value: "-Xms2g -Xmx2g"
            - name: xpack.security.enabled
              value: "false"
          volumeMounts:
            - name: data
              mountPath: /usr/share/elasticsearch/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 100Gi
```

### Filebeat DaemonSet

```yaml
# k8s/filebeat.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: filebeat
spec:
  selector:
    matchLabels:
      app: filebeat
  template:
    metadata:
      labels:
        app: filebeat
    spec:
      containers:
        - name: filebeat
          image: docker.elastic.co/beats/filebeat:8.14.0
          args: ["-c", "/etc/filebeat.yml", "-e"]
          volumeMounts:
            - name: config
              mountPath: /etc/filebeat.yml
              subPath: filebeat.yml
            - name: varlog
              mountPath: /var/log
              readOnly: true
            - name: containers
              mountPath: /var/lib/docker/containers
              readOnly: true
      volumes:
        - name: config
          configMap:
            name: filebeat-config
        - name: varlog
          hostPath:
            path: /var/log
        - name: containers
          hostPath:
            path: /var/lib/docker/containers
```

### Filebeat Configuration

```yaml
# k8s/filebeat-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: filebeat-config
data:
  filebeat.yml: |
    filebeat.autodiscover:
      providers:
        - type: kubernetes
          node: ${NODE_NAME}
          hints.enabled: true
          hints.default_config.enabled: false
          templates:
            - condition:
                contains:
                  kubernetes.labels.app: miniop
              config:
                - type: container
                  paths:
                    - /var/lib/docker/containers/${data.kubernetes.container.id}/*.log
                  json.keys_under_root: true
                  json.add_error_key: true

    output.elasticsearch:
      hosts: ["elasticsearch:9200"]
      index: "miniop-logs-%{+yyyy.MM.dd}"

    setup.ilm.enabled: false
    setup.template.name: miniop-logs
    setup.template.pattern: miniop-logs-*
```

## Retention Policies

### Free Tier (Loki)

```yaml
# loki-config.yaml
schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  retention_period: 30d
  max_query_length: 721h
  max_query_parallelism: 4

compactor:
  working_directory: /loki/compactor
  retention_enabled: true
  retention_delete_delay: 2h
  delete_request_store: filesystem
```

### Production (Elasticsearch ILM)

```json
// PUT _ilm/policy/miniop-logs
{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0ms",
        "actions": {
          "rollover": {
            "max_primary_shard_size": "50gb",
            "max_age": "1d"
          },
          "set_priority": {
            "priority": 100
          }
        }
      },
      "warm": {
        "min_age": "7d",
        "actions": {
          "shrink": {
            "number_of_shards": 1
          },
          "forcemerge": {
            "max_num_segments": 1
          },
          "set_priority": {
            "priority": 50
          }
        }
      },
      "delete": {
        "min_age": "90d",
        "actions": {
          "delete": {}
        }
      }
    }
  }
}
```

## Common Log Queries

### Loki (LogQL)

```logql
# All errors from the worker in the last hour
{service="miniop-worker"} |= "error" | json | level="error" | __error__=""

# Clip processing duration distribution
{service="miniop-worker"} | json | event="clip_processing_completed" | unwrap duration_ms | quantile_over_time(0.95, [5m])

# Requests for a specific user
{service="miniop-api"} | json | user_id="usr_12345"

# Failed clip generations with error details
{service=~"miniop-.*"} | json | event="clip_processing_failed" | line_format "{{.clip_id}}: {{.error_message}}"
```

### Elasticsearch (KQL / Lucene)

```
# Slow requests (>5 seconds)
service:miniop-api AND duration_ms:>5000

# Failed uploads in the last 24 hours
event:upload_failed AND @timestamp:[now-24h TO now]

# FFmpeg errors
service:miniop-worker AND message:*ffmpeg* AND level:error

# Aggregation: top 10 error types
# Use Kibana Discover or:
GET miniop-logs-*/_search
{
  "size": 0,
  "query": { "term": { "level": "error" } },
  "aggs": {
    "top_errors": {
      "terms": { "field": "event.keyword", "size": 10 }
    }
  }
}
```

## Log Enrichment

Enrich logs at the application layer before they leave the container:

```python
# app/logging_config.py (continued)
def add_service_context(logger, method_name, event_dict):
    event_dict["service"] = os.getenv("SERVICE_NAME", "miniop-api")
    event_dict["environment"] = os.getenv("ENVIRONMENT", "development")
    event_dict["version"] = os.getenv("APP_VERSION", "unknown")
    event_dict["hostname"] = os.getenv("HOSTNAME", "unknown")

    k8s_pod = os.getenv("K8S_POD_NAME")
    if k8s_pod:
        event_dict["k8s_pod"] = k8s_pod
        event_dict["k8s_namespace"] = os.getenv("K8S_NAMESPACE", "default")
        event_dict["k8s_node"] = os.getenv("K8S_NODE_NAME", "unknown")

    return event_dict
```

## Debugging Production Issues

When investigating a specific incident:

```bash
# 1. Find the request by ID across all services
curl -G 'http://localhost:3100/loki/api/v1/query_range' \
  --data-urlencode 'query={service=~"miniop-.*"} | json | request_id="req_a1b2c3d4"' \
  --data-urlencode 'start=2025-01-15T14:00:00Z' \
  --data-urlencode 'end=2025-01-15T15:00:00Z' \
  --data-urlencode 'limit=1000' | jq '.data.result[0].values[]'

# 2. Export logs for offline analysis
curl -G 'http://localhost:3100/loki/api/v1/query_range' \
  --data-urlencode 'query={service="miniop-worker"} | json | event="clip_processing_failed"' \
  --data-urlencode 'start=2025-01-15T00:00:00Z' \
  --data-urlencode 'end=2025-01-16T00:00:00Z' \
  --data-urlencode 'limit=5000' | jq -r '.data.result[0].values[][1]' > failed_clips.jsonl

# 3. Parse and summarize errors
jq -s 'group_by(.error_code) | map({code: .[0].error_code, count: length}) | sort_by(-.count)' failed_clips.jsonl
```
