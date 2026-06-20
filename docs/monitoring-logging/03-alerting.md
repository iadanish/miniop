# Alerting

This document defines alert rules, escalation policies, and notification integrations for MiniOp across free-tier and production deployments.

## Alerting Philosophy

MiniOp alerts follow three principles: every alert must be actionable, alerts should wake someone only when a human needs to intervene, and false positives must be fixed within one week. A noisy alert is worse than no alert.

## Free Tier: Prometheus Alertmanager + Email/Slack

### Alertmanager Setup

Add Alertmanager to the existing Docker Compose monitoring stack:

```yaml
# Add to docker-compose.monitoring.yml
  alertmanager:
    image: prom/alertmanager:v0.27.0
    ports:
      - "9093:9093"
    volumes:
      - ./monitoring/alertmanager.yml:/etc/alertmanager/alertmanager.yml
      - alertmanager-data:/alertmanager
    command:
      - "--config.file=/etc/alertmanager/alertmanager.yml"
      - "--storage.path=/alertmanager"

volumes:
  alertmanager-data:
```

### Alertmanager Configuration

```yaml
# monitoring/alertmanager.yml
global:
  resolve_timeout: 5m
  smtp_from: "alerts@miniop.example.com"
  smtp_smarthost: "smtp.gmail.com:587"
  smtp_auth_username: "${SMTP_USER}"
  smtp_auth_password: "${SMTP_PASSWORD}"

route:
  group_by: ["alertname", "severity"]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: "default"
  routes:
    - match:
        severity: critical
      receiver: "critical-pager"
      group_wait: 10s
      repeat_interval: 1h
    - match:
        severity: warning
      receiver: "warnings"
      repeat_interval: 12h

receivers:
  - name: "default"
    email_configs:
      - to: "oncall@miniop.example.com"
        send_resolved: true

  - name: "critical-pager"
    slack_configs:
      - api_url: "${SLACK_WEBHOOK_URL}"
        channel: "#miniop-alerts"
        title: "{{ .GroupLabels.alertname }}"
        text: "{{ range .Alerts }}{{ .Annotations.summary }}\n{{ end }}"
        send_resolved: true
    email_configs:
      - to: "oncall@miniop.example.com"
        send_resolved: true

  - name: "warnings"
    slack_configs:
      - api_url: "${SLACK_WEBHOOK_URL}"
        channel: "#miniop-warnings"
        title: "{{ .GroupLabels.alertname }}"
        text: "{{ .Annotations.description }}"
        send_resolved: true

inhibit_rules:
  - source_match:
      severity: "critical"
    target_match:
      severity: "warning"
    equal: ["alertname"]
```

### Prometheus Alert Rules

```yaml
# monitoring/rules/miniop-alerts.yml
groups:
  - name: miniop-api
    rules:
      - alert: HighErrorRate
        expr: |
          (
            rate(miniop_http_request_duration_seconds_count{status=~"5.."}[5m])
            /
            rate(miniop_http_request_duration_seconds_count[5m])
          ) > 0.01
        for: 5m
        labels:
          severity: critical
          service: miniop-api
        annotations:
          summary: "Error rate above 1% for 5 minutes"
          description: "{{ $labels.instance }} has {{ $value | humanizePercentage }} error rate"
          runbook: "https://docs.miniop.dev/runbooks/high-error-rate"

      - alert: HighApiLatency
        expr: |
          histogram_quantile(0.99, rate(miniop_http_request_duration_seconds_bucket[5m])) > 2
        for: 10m
        labels:
          severity: warning
          service: miniop-api
        annotations:
          summary: "API p99 latency exceeds 2s"
          description: "p99 latency is {{ $value | humanizeDuration }} on {{ $labels.instance }}"

      - alert: ApiDown
        expr: up{job="miniop-api"} == 0
        for: 2m
        labels:
          severity: critical
          service: miniop-api
        annotations:
          summary: "MiniOp API instance is down"
          description: "{{ $labels.instance }} has been unreachable for 2 minutes"

  - name: miniop-worker
    rules:
      - alert: QueueBacklog
        expr: miniop_queue_depth > 50
        for: 10m
        labels:
          severity: warning
          service: miniop-worker
        annotations:
          summary: "Clip processing queue depth exceeds 50"
          description: "Queue has {{ $value }} pending jobs. Consider scaling workers."

      - alert: QueueCritical
        expr: miniop_queue_depth > 200
        for: 5m
        labels:
          severity: critical
          service: miniop-worker
        annotations:
          summary: "Processing queue critically backed up"
          description: "{{ $value }} jobs pending. Immediate scaling required."

      - alert: SlowClipProcessing
        expr: |
          histogram_quantile(0.95, rate(miniop_clip_processing_seconds_bucket[10m])) > 300
        for: 15m
        labels:
          severity: warning
          service: miniop-worker
        annotations:
          summary: "Clip processing p95 exceeds 5 minutes"
          description: "p95 processing time is {{ $value | humanizeDuration }}"

      - alert: WorkerDown
        expr: up{job="miniop-worker"} == 0
        for: 2m
        labels:
          severity: critical
          service: miniop-worker
        annotations:
          summary: "No workers reporting metrics"
          description: "All worker instances appear to be down"

  - name: miniop-infrastructure
    rules:
      - alert: HighMemoryUsage
        expr: |
          (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) > 0.9
        for: 10m
        labels:
          severity: warning
          service: infrastructure
        annotations:
          summary: "Memory usage above 90%"
          description: "{{ $labels.instance }} at {{ $value | humanizePercentage }} memory"

      - alert: HighDiskUsage
        expr: |
          (1 - (node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})) > 0.8
        for: 5m
        labels:
          severity: warning
          service: infrastructure
        annotations:
          summary: "Disk usage above 80%"
          description: "{{ $labels.instance }} root filesystem at {{ $value | humanizePercentage }}"

      - alert: CriticalDiskUsage
        expr: |
          (1 - (node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})) > 0.95
        for: 2m
        labels:
          severity: critical
          service: infrastructure
        annotations:
          summary: "Disk critically full - clips will fail"
          description: "{{ $labels.instance }} at {{ $value | humanizePercentage }} disk. Immediate cleanup required."

      - alert: HighCPUUsage
        expr: |
          100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) > 90
        for: 15m
        labels:
          severity: warning
          service: infrastructure
        annotations:
          summary: "CPU sustained above 90%"
          description: "{{ $labels.instance }} at {{ $value | printf \"%.1f\" }}% CPU for 15 minutes"

  - name: miniop-database
    rules:
      - alert: DatabaseConnectionPoolExhausted
        expr: miniop_db_pool_connections_active / miniop_db_pool_connections_max > 0.9
        for: 5m
        labels:
          severity: critical
          service: database
        annotations:
          summary: "Database connection pool nearly exhausted"
          description: "{{ $value | humanizePercentage }} of connections in use"

      - alert: SlowDatabaseQueries
        expr: histogram_quantile(0.95, rate(miniop_db_query_duration_seconds_bucket[5m])) > 1
        for: 10m
        labels:
          severity: warning
          service: database
        annotations:
          summary: "Database queries p95 exceeds 1s"
          description: "p95 query time is {{ $value | humanizeDuration }}"

      - alert: RedisConnectionFailed
        expr: miniop_redis_connected == 0
        for: 1m
        labels:
          severity: critical
          service: database
        annotations:
          summary: "Redis connection lost"
          description: "Application cannot reach Redis. Queue and caching are down."
```

Verify rules load correctly:

```bash
# Validate alert rules syntax
docker exec prometheus promtool check rules /etc/prometheus/rules/*.yml

# Test alertmanager config
docker exec alertmanager amtool check-config /etc/alertmanager/alertmanager.yml

# List active alerts
curl -s http://localhost:9093/api/v2/alerts | jq '.[] | {alertname: .labels.alertname, state: .status.state}'

# Silence an alert temporarily
curl -X POST http://localhost:9093/api/v2/silences -H 'Content-Type: application/json' -d '{
  "matchers": [{"name": "alertname", "value": "HighDiskUsage"}],
  "startsAt": "2025-01-15T10:00:00Z",
  "endsAt": "2025-01-15T18:00:00Z",
  "createdBy": "ops-team",
  "comment": "Scheduled maintenance window"
}'
```

## Scaled Production: PagerDuty + Grafana OnCall

For production with SLA requirements, integrate alerting with an incident management platform.

### PagerDuty Integration

```yaml
# monitoring/alertmanager.yml - production receivers
receivers:
  - name: "critical-pager"
    pagerduty_configs:
      - service_key: "${PAGERDUTY_SERVICE_KEY}"
        severity: critical
        description: "{{ .GroupLabels.alertname }}: {{ .CommonAnnotations.summary }}"
        details:
          firing: "{{ .Alerts.Firing | len }}"
          resolved: "{{ .Alerts.Resolved | len }}"
          dashboard: "https://grafana.miniop.example.com/d/miniop-overview"

    slack_configs:
      - api_url: "${SLACK_WEBHOOK_URL}"
        channel: "#miniop-incidents"
        title: "CRITICAL: {{ .GroupLabels.alertname }}"
        text: |
          {{ range .Alerts }}
          *Alert:* {{ .Annotations.summary }}
          *Description:* {{ .Annotations.description }}
          *Runbook:* {{ .Annotations.runbook }}
          {{ end }}
        send_resolved: true
```

### Grafana OnCall Integration

For teams using Grafana OnCall instead of PagerDuty:

```yaml
# monitoring/alertmanager.yml
receivers:
  - name: "oncall"
    webhook_configs:
      - url: "https://oncall.grafana.example.com/api/v1/alerts"
        send_resolved: true
        http_config:
          bearer_token: "${GRAFANA_ONCALL_TOKEN}"
```

Create escalation chains in Grafana OnCall:

```
Escalation Chain: MiniOp Critical
  Step 1 (0 min):  Notify on-call schedule "MiniOp Primary"
  Step 2 (5 min):  Notify on-call schedule "MiniOp Secondary"
  Step 3 (15 min): Notify team lead via SMS
  Step 30 min:      Notify engineering manager
```

### Kubernetes Pod Restart Alerts

For container-level alerting that Prometheus node metrics miss:

```yaml
# monitoring/rules/k8s-pods.yml
groups:
  - name: kubernetes-pods
    rules:
      - alert: PodCrashLooping
        expr: |
          rate(kube_pod_container_status_restarts_total{namespace="miniop"}[15m]) > 0
        for: 5m
        labels:
          severity: critical
          service: kubernetes
        annotations:
          summary: "Pod {{ $labels.pod }} is crash looping"
          description: "{{ $labels.pod }} has restarted {{ $value | humanize }} times in 15 minutes"

      - alert: PodNotReady
        expr: |
          kube_pod_status_ready{namespace="miniop", condition="true"} == 0
        for: 10m
        labels:
          severity: warning
          service: kubernetes
        annotations:
          summary: "Pod {{ $labels.pod }} not ready for 10 minutes"

      - alert: OOMKilled
        expr: |
          kube_pod_container_status_last_terminated_reason{reason="OOMKilled", namespace="miniop"} == 1
        for: 0m
        labels:
          severity: critical
          service: kubernetes
        annotations:
          summary: "Container {{ $labels.container }} was OOM killed"
          description: "Increase memory limits or investigate memory leak in {{ $labels.pod }}"
```

## Business Logic Alerts

Beyond infrastructure, alert on business metrics that indicate user-facing problems:

```yaml
# monitoring/rules/miniop-business.yml
groups:
  - name: miniop-business
    interval: 5m
    rules:
      - alert: NoClipsGenerated
        expr: |
          increase(miniop_clips_created_total[1h]) == 0
        for: 1h
        labels:
          severity: warning
          service: business
        annotations:
          summary: "No clips generated in the last hour"
          description: "During active hours this likely indicates a processing pipeline failure"

      - alert: ClipFailureRateHigh
        expr: |
          (
            rate(miniop_clip_processing_total{status="failed"}[30m])
            /
            rate(miniop_clip_processing_total[30m])
          ) > 0.1
        for: 15m
        labels:
          severity: critical
          service: business
        annotations:
          summary: "Clip failure rate above 10%"
          description: "{{ $value | humanizePercentage }} of clips are failing. Check FFmpeg logs."

      - alert: StorageGrowthRate
        expr: |
          predict_linear(miniop_storage_used_bytes[6h], 86400 * 7) >
          miniop_storage_capacity_bytes * 0.9
        for: 30m
        labels:
          severity: warning
          service: business
        annotations:
          summary: "Storage will exceed 90% within 7 days at current growth rate"
          description: "Current usage: {{ $value | humanize1024 }}B. Plan capacity expansion."

      - alert: ProcessingCapacitySaturated
        expr: |
          avg_over_time(miniop_active_processing_jobs[30m]) /
          miniop_worker_capacity > 0.85
        for: 30m
        labels:
          severity: warning
          service: business
        annotations:
          summary: "Worker capacity above 85% for 30 minutes"
          description: "Average utilization: {{ $value | humanizePercentage }}. Scale workers soon."
```

## Runbook Integration

Every critical alert links to a runbook. Host runbooks in a structured directory:

```
docs/runbooks/
  high-error-rate.md
  queue-backlog.md
  disk-full.md
  worker-down.md
  database-connection-pool.md
  clip-failure-rate.md
```

Each runbook follows this structure:

```markdown
# Runbook: High Error Rate

## Summary
API is returning 5xx errors above the 1% threshold.

## Impact
Users cannot upload videos or download clips.

## Diagnosis
1. Check which endpoints are failing:
   ```bash
   curl -s 'http://localhost:9090/api/v1/query?query=topk(5, rate(miniop_http_request_duration_seconds_count{status=~"5.."}[5m]))' | jq
   ```
2. Check recent deployments:
   ```bash
   kubectl rollout history deployment/miniop-api -n miniop
   ```
3. Check API logs for stack traces:
   ```bash
   kubectl logs -l app=miniop-api -n miniop --tail=200 | grep -A 10 "Traceback"
   ```

## Remediation
1. If correlated with a deployment: rollback immediately
   ```bash
   kubectl rollout undo deployment/miniop-api -n miniop
   ```
2. If database related: check connection pool and DB health
3. If storage related: check disk space and S3 bucket access

## Escalation
If unresolved after 15 minutes, escalate to #miniop-incidents.
```

## Alert Tuning Workflow

When an alert fires and proves unhelpful, follow this process:

```bash
# 1. Identify the firing alert
curl -s http://localhost:9093/api/v2/alerts | jq '.[] | select(.status.state=="active")'

# 2. Check the rule's firing history in Prometheus
curl -s 'http://localhost:9090/api/v1/alerts' | jq '.data.groups[] | .rules[] | select(.name=="HighErrorRate")'

# 3. If false positive, adjust the threshold or duration in the rules file
# 4. Validate the change
docker exec prometheus promtool check rules /etc/prometheus/rules/*.yml

# 5. Reload Prometheus
curl -X POST http://localhost:9090/-/reload

# 6. Document the change
echo "$(date -Iseconds) | Tuned HighErrorRate threshold from 1% to 2% due to false positives during batch processing" >> docs/alert-tuning-log.md
```

## Alert Severity Definitions

| Severity | Response Time | Wake Someone? | Examples |
|----------|--------------|---------------|----------|
| **Critical** | 15 minutes | Yes, page immediately | API down, data loss, security breach |
| **Warning** | 1 hour | No, next business day | High latency, queue backlog, disk filling |
| **Info** | Next sprint | No | Capacity trend warnings, optimization opportunities |

## Notification Channel Matrix

| Channel | Free Tier | Production | Use For |
|---------|-----------|------------|---------|
| Slack | Webhook | Bot integration | Team awareness, warnings |
| Email | SMTP direct | SES/SendGrid | Audit trail, non-urgent |
| PagerDuty | Not needed | Service integration | Critical paging |
| SMS | Not needed | Twilio/PagerDuty | Last-resort escalation |
| Discord | Webhook | Webhook | Community-facing status |

## Testing Alert Delivery

```bash
# Send a test alert to Alertmanager
curl -X POST http://localhost:9093/api/v2/alerts -H 'Content-Type: application/json' -d '[{
  "labels": {
    "alertname": "TestAlert",
    "severity": "warning",
    "service": "miniop-test"
  },
  "annotations": {
    "summary": "This is a test alert",
    "description": "Testing alert delivery pipeline"
  },
  "startsAt": "2025-01-15T12:00:00Z",
  "endsAt": "2025-01-15T12:05:00Z"
}]'

# Verify Slack delivery
# Check #miniop-warnings for the test message

# Send a critical test
curl -X POST http://localhost:9093/api/v2/alerts -H 'Content-Type: application/json' -d '[{
  "labels": {
    "alertname": "TestCritical",
    "severity": "critical",
    "service": "miniop-test"
  },
  "annotations": {
    "summary": "Critical test alert",
    "description": "Verify PagerDuty escalation works"
  }
}]'
```
