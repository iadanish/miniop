# MiniOp Chaos Engineering

## Purpose

Chaos engineering intentionally introduces failures into MiniOp's infrastructure to verify that resilience mechanisms (circuit breakers, retries, failover, backup recovery) actually work under real failure conditions. This is not optional — untested failover paths are failover paths that will fail when you need them most.

## Principles

1. **Start small**: Begin with the least destructive experiments and increase scope
2. **Production-like staging**: Run chaos experiments in an environment that mirrors production
3. **Automate**: Manual chaos testing is just "breaking things randomly"
4. **Blast radius control**: Every experiment must have an abort mechanism
5. **Learn and improve**: Every experiment produces findings that improve the system

## Chaos Toolkit Setup

### Installation

```bash
# Install Chaos Toolkit
pip install chaostoolkit chaostoolkit-kubernetes chaostoolkit-prometheus

# Or via Docker
docker pull chaostoolkit/chaostoolkit
```

### Configuration

```json
// chaos/experiments/config.json
{
  "runtime": {
    "type": "python",
    "command": "chaos",
    "settings": {
      "chaostoolkit": {
        "log_level": "info"
      }
    }
  },
  "secrets": {
    "kubernetes": {
      "KUBECONFIG": "~/.kube/config"
    },
    "prometheus": {
      "PROMETHEUS_URL": "http://prometheus:9090"
  },
  "extensions": [
    {
      "name": "chaostoolkit-kubernetes",
      "pkg": "chaostoolkit_kubernetes"
    },
    {
      "name": "chaostoolkit-prometheus",
      "pkg": "chaostoolkit_prometheus"
    }
  ]
}
```

## Experiment 1: API Pod Failure

**Hypothesis**: When an API pod is killed, Kubernetes reschedules it within 60 seconds with zero user-visible errors.

```json
// chaos/experiments/api-pod-kill.json
{
  "title": "API Pod Failure Recovery",
  "description": "Verify API pods recover from sudden termination",
  "steady-state-hypothesis": {
    "title": "API serves requests normally",
    "probes": [
      {
        "type": "probe",
        "name": "api-responds",
        "tolerance": 200,
        "provider": {
          "type": "http",
          "url": "https://api.minio-dev.internal/health",
          "timeout": 5
        }
      },
      {
        "type": "probe",
        "name": "error-rate-low",
        "tolerance": 0.01,
        "provider": {
          "type": "python",
          "module": "chaosaddons.probes",
          "func": "check_error_rate",
          "arguments": {
            "prometheus_url": "http://prometheus:9090",
            "query": "rate(minio_errors_total[5m]) / rate(minio_api_requests_total[5m])",
            "threshold": 0.01
          }
        }
      }
    ]
  },
  "method": [
    {
      "type": "action",
      "name": "kill-random-api-pod",
      "provider": {
        "type": "python",
        "module": "chaosaddons.actions",
        "func": "kill_random_pod",
        "arguments": {
          "namespace": "minio-prod",
          "label_selector": "app=minio-api",
          "grace_period": 0
        }
      },
      "pauses": {
        "after": 30
      }
    }
  ],
  "rollbacks": [
    {
      "type": "action",
      "name": "ensure-pods-running",
      "provider": {
        "type": "python",
        "module": "chaosaddons.actions",
        "func": "wait_for_pods_ready",
        "arguments": {
          "namespace": "minio-prod",
          "label_selector": "app=minio-api",
          "min_replicas": 3,
          "timeout": 120
        }
      }
    }
  ]
}
```

```bash
# Run the experiment
chaos run chaos/experiments/api-pod-kill.json

# Expected output:
# Steady state hypothesis: API serves requests normally [PASSED]
# Action: kill-random-api-pod [COMPLETED]
# Paused 30s...
# Steady state hypothesis: API serves requests normally [PASSED]
# Rollback: ensure-pods-running [COMPLETED]
```

## Experiment 2: Database Failover

**Hypothesis**: When the primary PostgreSQL instance is terminated, the replica promotes within 30 seconds and the application reconnects without user errors.

```json
// chaos/experiments/db-failover.json
{
  "title": "Database Failover",
  "description": "Verify automatic PostgreSQL failover under load",
  "steady-state-hypothesis": {
    "title": "Database accepts writes",
    "probes": [
      {
        "type": "probe",
        "name": "db-writable",
        "tolerance": true,
        "provider": {
          "type": "python",
          "module": "chaosaddons.probes",
          "func": "check_db_writable",
          "arguments": {
            "connection_string": "postgresql://minio:${DB_PASSWORD}@pg-primary:5432/minio"
          }
        }
      }
    ]
  },
  "method": [
    {
      "type": "action",
      "name": "generate-load",
      "provider": {
        "type": "process",
        "path": "chaos/scripts/generate-load.sh",
        "arguments": ["--duration", "120", "--rps", "50"]
      },
      "background": true
    },
    {
      "type": "action",
      "name": "kill-primary-postgres",
      "provider": {
        "type": "python",
        "module": "chaosaddons.actions",
        "func": "kill_pod",
        "arguments": {
          "namespace": "minio-prod",
          "name": "patroni-0",
          "grace_period": 0
        }
      },
      "pauses": {
        "after": 60
      }
    }
  ],
  "rollbacks": [
    {
      "type": "action",
      "name": "verify-cluster-healthy",
      "provider": {
        "type": "python",
        "module": "chaosaddons.actions",
        "func": "wait_for_patroni_leader",
        "arguments": {
          "namespace": "minio-prod",
          "timeout": 120
        }
      }
    }
  ]
}
```

```python
# chaos/addons/probes.py
import psycopg2
import requests
from prometheus_api_client import PrometheusConnect

def check_db_writable(connection_string: str) -> bool:
    try:
        conn = psycopg2.connect(connection_string, connect_timeout=5)
        cur = conn.cursor()
        cur.execute("INSERT INTO chaos_test (created_at) VALUES (now()) RETURNING id")
        conn.commit()
        cur.execute("DELETE FROM chaos_test WHERE id = %s", (cur.fetchone()[0],))
        conn.commit()
        cur.close()
        conn.close()
        return True
    except Exception as e:
        print(f"DB not writable: {e}")
        return False

def check_error_rate(prometheus_url: str, query: str, threshold: float) -> bool:
    prom = PrometheusConnect(url=prometheus_url)
    result = prom.custom_query(query)
    if result:
        rate = float(result[0]["value"][1])
        return rate <= threshold
    return True

def check_api_latency(prometheus_url: str, threshold_ms: float) -> bool:
    prom = PrometheusConnect(url=prometheus_url)
    result = prom.custom_query("histogram_quantile(0.99, rate(minio_api_latency_seconds_bucket[5m]))")
    if result:
        latency_s = float(result[0]["value"][1])
        latency_ms = latency_s * 1000
        return latency_ms <= threshold_ms
    return True
```

## Experiment 3: Storage Backend Degradation

**Hypothesis**: When the primary MinIO storage becomes slow (1s latency per operation), the system continues serving from cache and the circuit breaker opens before errors cascade.

```json
// chaos/experiments/storage-degradation.json
{
  "title": "Storage Degradation",
  "description": "Verify behavior under slow storage",
  "steady-state-hypothesis": {
    "title": "Uploads complete within 30s",
    "probes": [
      {
        "type": "probe",
        "name": "upload-success-rate",
        "tolerance": 0.95,
        "provider": {
          "type": "python",
          "module": "chaosaddons.probes",
          "func": "check_upload_success_rate",
          "arguments": {
            "api_url": "https://api.minio-dev.internal",
            "duration_seconds": 30,
            "file_size_mb": 10
          }
        }
      }
    ]
  },
  "method": [
    {
      "type": "action",
      "name": "add-storage-latency",
      "provider": {
        "type": "python",
        "module": "chaosaddons.actions",
        "func": "add_network_latency",
        "arguments": {
          "namespace": "minio-prod",
          "label_selector": "app=minio",
          "latency_ms": 1000,
          "jitter_ms": 200
        }
      },
      "pauses": {
        "after": 120
      }
    }
  ],
  "rollbacks": [
    {
      "type": "action",
      "name": "remove-storage-latency",
      "provider": {
        "type": "python",
        "module": "chaosaddons.actions",
        "func": "remove_network_latency",
        "arguments": {
          "namespace": "minio-prod",
          "label_selector": "app=minio"
        }
      }
    }
  ]
}
```

## Experiment 4: AI Inference Service Failure

**Hypothesis**: When the primary AI inference endpoint becomes unavailable, the circuit breaker opens within 3 failed requests and jobs are retried on the fallback endpoint.

```json
// chaos/experiments/ai-inference-failure.json
{
  "title": "AI Inference Failover",
  "description": "Verify AI inference circuit breaker and fallback",
  "steady-state-hypothesis": {
    "title": "Clip extraction completes",
    "probes": [
      {
        "type": "probe",
        "name": "clip-extraction-works",
        "tolerance": true,
        "provider": {
          "type": "python",
          "module": "chaosaddons.probes",
          "func": "check_clip_extraction",
          "arguments": {
            "api_url": "https://api.minio-dev.internal",
            "test_video": "s3://test-videos/sample.mp4"
          }
        }
      }
    ]
  },
  "method": [
    {
      "type": "action",
      "name": "block-ai-endpoint",
      "provider": {
        "type": "python",
        "module": "chaosaddons.actions",
        "func": "block_network_egress",
        "arguments": {
          "namespace": "minio-prod",
          "label_selector": "app=minio-api",
          "destination": "ai-inference.internal",
          "port": 443
        }
      },
      "pauses": {
        "after": 60
      }
    }
  ],
  "rollbacks": [
    {
      "type": "action",
      "name": "unblock-ai-endpoint",
      "provider": {
        "type": "python",
        "module": "chaosaddons.actions",
        "func": "unblock_network_egress",
        "arguments": {
          "namespace": "minio-prod",
          "label_selector": "app=minio-api",
          "destination": "ai-inference.internal",
          "port": 443
        }
      }
    }
  ]
}
```

## Experiment 5: Full Region Outage

**Hypothesis**: When an entire availability zone becomes unreachable, traffic fails over to the DR region within 5 minutes with less than 1 minute of data loss.

```bash
#!/bin/bash
# chaos/scripts/region-outage.sh
set -euo pipefail

echo "=== Region Outage Chaos Experiment ==="
echo "WARNING: This will simulate a full AZ failure in staging"

read -p "Type 'CHAOS' to confirm: " confirm
if [ "$confirm" != "CHAOS" ]; then
  echo "Aborted."
  exit 1
fi

# 1. Verify steady state
echo "Checking steady state..."
curl -sf https://staging-api.minio.dev/health || { echo "Steady state check failed"; exit 1; }

# 2. Block all traffic from AZ-1
echo "Blocking AZ-1 traffic..."
kubectl cordon node-az1-{01,02,03} --dry-run=client  # Preview
kubectl cordon node-az1-{01,02,03}

# 3. Drain pods from AZ-1
echo "Draining AZ-1 nodes..."
kubectl drain node-az1-{01,02,03} --ignore-daemonsets --delete-emptydir-data --timeout=120s

# 4. Trigger DNS failover
echo "Updating DNS to point to AZ-2..."
aws route53 change-resource-record-sets \
  --hosted-zone-id "$ZONE_ID" \
  --change-batch "{
    \"Changes\": [{
      \"Action\": \"UPSERT\",
      \"ResourceRecordSet\": {
        \"Name\": \"staging-api.minio.dev\",
        \"Type\": \"CNAME\",
        \"TTL\": 60,
        \"ResourceRecords\": [{\"Value\": \"staging-api-az2.minio.dev\"}]
      }
    }]
  }"

# 5. Wait and verify
echo "Waiting 120s for DNS propagation..."
sleep 120

echo "Verifying service..."
curl -sf https://staging-api.minio.dev/health || { echo "Service not recovered"; }

# 6. Restore
echo "Restoring AZ-1..."
kubectl uncordon node-az1-{01,02,03}

echo "=== Experiment complete ==="
```

## Chaos Testing Schedule

| Experiment | Frequency | Environment | Duration | Risk |
|---|---|---|---|---|
| API pod kill | Weekly | Staging | 5 min | Low |
| Database failover | Monthly | Staging | 15 min | Medium |
| Storage degradation | Monthly | Staging | 10 min | Low |
| AI inference failure | Monthly | Staging | 10 min | Low |
| Full region outage | Quarterly | Staging | 30 min | High |
| Production pod kill | Quarterly | Production | 5 min | Medium |
| Production DB failover | Annually | Production | 15 min | High |

## Custom Chaos Actions

```python
# chaos/addons/actions.py
import subprocess
import random
import time
import logging
from kubernetes import client, config

logger = logging.getLogger("chaosaddons.actions")

def kill_random_pod(namespace: str, label_selector: str, grace_period: int = 0):
    """Kill a random pod matching the label selector."""
    config.load_incluster_config()
    v1 = client.CoreV1Api()
    
    pods = v1.list_namespaced_pod(
        namespace=namespace,
        label_selector=label_selector,
        field_selector="status.phase=Running",
    )
    
    if not pods.items:
        raise Exception(f"No running pods found with selector {label_selector}")
    
    target = random.choice(pods.items)
    logger.info(f"Killing pod {target.metadata.name}")
    
    v1.delete_namespaced_pod(
        name=target.metadata.name,
        namespace=namespace,
        grace_period_seconds=grace_period,
    )
    
    return {"killed_pod": target.metadata.name}

def kill_pod(namespace: str, name: str, grace_period: int = 0):
    """Kill a specific pod by name."""
    config.load_incluster_config()
    v1 = client.CoreV1Api()
    
    logger.info(f"Killing pod {name}")
    v1.delete_namespaced_pod(
        name=name,
        namespace=namespace,
        grace_period_seconds=grace_period,
    )
    return {"killed_pod": name}

def add_network_latency(namespace: str, label_selector: str, latency_ms: int, jitter_ms: int = 0):
    """Add network latency to pods using tc."""
    config.load_incluster_config()
    v1 = client.CoreV1Api()
    
    pods = v1.list_namespaced_pod(
        namespace=namespace,
        label_selector=label_selector,
    )
    
    for pod in pods.items:
        cmd = (
            f"kubectl exec -n {namespace} {pod.metadata.name} -- "
            f"tc qdisc add dev eth0 root netem delay {latency_ms}ms {jitter_ms}ms"
        )
        subprocess.run(cmd, shell=True, check=True)
        logger.info(f"Added {latency_ms}ms latency to {pod.metadata.name}")

def remove_network_latency(namespace: str, label_selector: str):
    """Remove network latency from pods."""
    config.load_incluster_config()
    v1 = client.CoreV1Api()
    
    pods = v1.list_namespaced_pod(
        namespace=namespace,
        label_selector=label_selector,
    )
    
    for pod in pods.items:
        cmd = (
            f"kubectl exec -n {namespace} {pod.metadata.name} -- "
            f"tc qdisc del dev eth0 root"
        )
        subprocess.run(cmd, shell=True, check=False)
        logger.info(f"Removed latency from {pod.metadata.name}")

def wait_for_pods_ready(namespace: str, label_selector: str, min_replicas: int, timeout: int = 120):
    """Wait for minimum number of pods to be ready."""
    config.load_incluster_config()
    v1 = client.CoreV1Api()
    
    start = time.time()
    while time.time() - start < timeout:
        pods = v1.list_namespaced_pod(
            namespace=namespace,
            label_selector=label_selector,
            field_selector="status.phase=Running",
        )
        ready = sum(1 for p in pods.items if p.status.phase == "Running")
        if ready >= min_replicas:
            logger.info(f"{ready} pods ready (needed {min_replicas})")
            return {"ready_pods": ready}
        time.sleep(5)
    
    raise Exception(f"Timeout waiting for {min_replicas} pods (found {ready})")

def wait_for_patroni_leader(namespace: str, timeout: int = 120):
    """Wait for Patroni to elect a new leader."""
    start = time.time()
    while time.time() - start < timeout:
        result = subprocess.run(
            f"kubectl exec -n {namespace} patroni-0 -- patronictl list -f json",
            shell=True, capture_output=True, text=True,
        )
        if result.returncode == 0:
            import json
            members = json.loads(result.stdout)
            leader = [m for m in members if m.get("Role") == "Leader"]
            if leader:
                logger.info(f"Patroni leader elected: {leader[0]['Member']}")
                return {"leader": leader[0]["Member"]}
        time.sleep(5)
    
    raise Exception("Timeout waiting for Patroni leader")
```

## Post-Experiment Analysis

After each experiment, document findings:

```markdown
## Experiment: [Name]
- **Date**: YYYY-MM-DD
- **Environment**: staging / production
- **Hypothesis**: [What we expected]
- **Result**: [What actually happened]
- **Observations**:
  - [Finding 1]
  - [Finding 2]
- **Action Items**:
  - [ ] [Improvement needed]
  - [ ] [Fix required]
- **Next Experiment Date**: YYYY-MM-DD
```
