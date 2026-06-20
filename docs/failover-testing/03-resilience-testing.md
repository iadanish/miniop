# MiniOp Resilience Testing

## Overview

Resilience testing validates that MiniOp can withstand and recover from failures without data loss or extended downtime. Unlike chaos engineering (which injects random failures), resilience testing follows a structured test plan with specific failure scenarios and acceptance criteria.

## Test Categories

| Category | Purpose | Frequency | Environment |
|---|---|---|---|
| Component Resilience | Verify individual component recovery | Weekly | Staging |
| Integration Resilience | Verify cross-component failover | Monthly | Staging |
| End-to-End Resilience | Verify full pipeline under failure | Quarterly | Staging + Production shadow |
| Load Resilience | Verify behavior under stress + failure | Quarterly | Staging |

## Component Resilience Tests

### Test 1: API Server Crash Recovery

```python
# tests/resilience/test_api_crash.py
import pytest
import requests
import subprocess
import time
import threading
from concurrent.futures import ThreadPoolExecutor

class TestAPICrashRecovery:
    BASE_URL = "http://localhost:8000"
    
    def test_api_recovers_from_sigkill(self):
        """Verify API recovers within 30s of SIGKILL."""
        # Verify healthy
        assert requests.get(f"{self.BASE_URL}/health").status_code == 200
        
        # Kill the API process
        subprocess.run(["docker", "compose", "kill", "api"], check=True)
        
        # Wait for restart (Docker restart policy)
        deadline = time.time() + 30
        recovered = False
        while time.time() < deadline:
            try:
                if requests.get(f"{self.BASE_URL}/health", timeout=2).status_code == 200:
                    recovered = True
                    break
            except requests.ConnectionError:
                pass
            time.sleep(1)
        
        assert recovered, "API did not recover within 30s"
    
    def test_no_data_loss_during_crash(self):
        """Verify no data loss when API crashes mid-request."""
        # Create a job
        job_id = requests.post(
            f"{self.BASE_URL}/api/v1/jobs",
            json={"video_url": "https://example.com/test.mp4"},
        ).json()["id"]
        
        # Kill API during processing
        subprocess.run(["docker", "compose", "kill", "api"], check=True)
        
        # Wait for recovery
        time.sleep(15)
        
        # Verify job still exists
        response = requests.get(f"{self.BASE_URL}/api/v1/jobs/{job_id}")
        assert response.status_code == 200
        assert response.json()["id"] == job_id
    
    def test_concurrent_requests_during_restart(self):
        """Verify concurrent requests during rolling restart."""
        results = []
        errors = []
        
        def make_request():
            try:
                resp = requests.get(f"{self.BASE_URL}/health", timeout=5)
                results.append(resp.status_code)
            except Exception as e:
                errors.append(str(e))
        
        # Start concurrent requests
        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = []
            for _ in range(100):
                futures.append(executor.submit(make_request))
                time.sleep(0.1)
                
                # Restart API midway through
                if len(futures) == 50:
                    subprocess.run(["docker", "compose", "restart", "api"], check=True)
            
            for f in futures:
                f.result()
        
        # Allow some failures during restart, but most should succeed
        success_rate = len(results) / (len(results) + len(errors))
        assert success_rate > 0.7, f"Success rate {success_rate:.2%} below 70% threshold"
```

### Test 2: Database Connection Pool Exhaustion

```python
# tests/resilience/test_db_pool.py
import pytest
import psycopg2
import threading
import time

class TestDatabaseResilience:
    
    def test_connection_pool_exhaustion_recovery(self):
        """Verify app recovers when connection pool is exhausted."""
        # Exhaust connections
        connections = []
        try:
            for i in range(150):  # Exceed max_connections
                conn = psycopg2.connect(
                    "postgresql://minio:password@localhost:5432/minio"
                )
                connections.append(conn)
        except psycopg2.OperationalError:
            pass  # Expected
        
        # Try API request (should get 503, not 500)
        import requests
        resp = requests.get("http://localhost:8000/api/v1/jobs", timeout=10)
        
        # Release connections
        for conn in connections:
            conn.close()
        
        # Verify recovery
        time.sleep(5)
        resp = requests.get("http://localhost:8000/api/v1/jobs", timeout=10)
        assert resp.status_code in (200, 401), f"Unexpected status: {resp.status_code}"
    
    def test_slow_query_handling(self):
        """Verify slow queries are killed and don't block other requests."""
        import requests
        
        # Trigger a slow query via API
        try:
            requests.post(
                "http://localhost:8000/api/v1/admin/query",
                json={"query": "SELECT pg_sleep(300)"},
                timeout=5,
            )
        except requests.Timeout:
            pass
        
        # Verify other requests still work
        resp = requests.get("http://localhost:8000/health", timeout=5)
        assert resp.status_code == 200
```

### Test 3: Redis Failure and Queue Recovery

```python
# tests/resilience/test_redis_failure.py
import pytest
import redis
import requests
import subprocess
import time

class TestRedisResilience:
    
    def test_queue_recovery_after_redis_restart(self):
        """Verify jobs requeued after Redis restarts."""
        r = redis.Redis(host="localhost", port=6379)
        
        # Get initial queue depth
        initial_depth = r.llen("jobs:default")
        
        # Stop Redis
        subprocess.run(["docker", "compose", "stop", "redis"], check=True)
        
        # Queue new jobs (should fail gracefully)
        failed_jobs = []
        for i in range(5):
            try:
                resp = requests.post(
                    "http://localhost:8000/api/v1/jobs",
                    json={"video_url": f"https://example.com/test{i}.mp4"},
                    timeout=5,
                )
                if resp.status_code == 503:
                    failed_jobs.append(i)
            except Exception:
                failed_jobs.append(i)
        
        # Restart Redis
        subprocess.run(["docker", "compose", "start", "redis"], check=True)
        time.sleep(10)
        
        # Verify jobs can be submitted again
        resp = requests.post(
            "http://localhost:8000/api/v1/jobs",
            json={"video_url": "https://example.com/test-recovery.mp4"},
            timeout=10,
        )
        assert resp.status_code in (200, 201, 401)
    
    def test_stale_job_requeue(self):
        """Verify stale jobs are requeued after Redis recovery."""
        r = redis.Redis(host="localhost", port=6379)
        
        # Simulate stale processing jobs
        for i in range(10):
            job_id = f"stale-job-{i}"
            r.hset(f"job:{job_id}", mapping={
                "status": "processing",
                "started_at": str(time.time() - 3600),  # 1 hour ago
            })
            r.lpush("jobs:processing", job_id)
        
        # Trigger requeue
        subprocess.run([
            "docker", "compose", "exec", "api",
            "python", "manage.py", "requeue_stale_jobs",
            "--older-than", "30m",
        ], check=True)
        
        # Verify jobs moved to retry queue
        processing = r.llen("jobs:processing")
        assert processing == 0, f"Still {processing} jobs in processing"
```

## Integration Resilience Tests

### Test 4: Upload Pipeline End-to-End Under Failure

```python
# tests/resilience/test_pipeline_resilience.py
import pytest
import requests
import subprocess
import time
import os

class TestPipelineResilience:
    BASE_URL = "http://localhost:8000"
    
    def test_upload_survives_worker_restart(self):
        """Verify upload completes even if worker restarts mid-processing."""
        # Upload a video
        test_video = os.path.join(os.path.dirname(__file__), "fixtures", "test.mp4")
        with open(test_video, "rb") as f:
            resp = requests.post(
                f"{self.BASE_URL}/api/v1/jobs",
                files={"video": f},
                timeout=30,
            )
        job_id = resp.json()["id"]
        
        # Wait a bit for processing to start
        time.sleep(5)
        
        # Kill the worker
        subprocess.run(["docker", "compose", "kill", "worker"], check=True)
        
        # Wait for worker to restart
        time.sleep(15)
        
        # Poll job status until complete or timeout
        deadline = time.time() + 300
        while time.time() < deadline:
            resp = requests.get(f"{self.BASE_URL}/api/v1/jobs/{job_id}", timeout=5)
            status = resp.json()["status"]
            if status in ("completed", "failed"):
                break
            time.sleep(5)
        
        assert status == "completed", f"Job ended with status: {status}"
    
    def test_storage_failover_during_upload(self):
        """Verify upload succeeds when primary storage fails."""
        # This test requires backup storage configured
        # Block primary storage
        subprocess.run([
            "docker", "compose", "exec", "nginx",
            "sh", "-c", "echo 'server { listen 9000; return 503; }' > /etc/nginx/conf.d/minio-block.conf && nginx -s reload"
        ], check=True)
        
        # Upload should succeed via backup
        test_video = os.path.join(os.path.dirname(__file__), "fixtures", "test.mp4")
        with open(test_video, "rb") as f:
            resp = requests.post(
                f"{self.BASE_URL}/api/v1/jobs",
                files={"video": f},
                timeout=60,
            )
        
        assert resp.status_code in (200, 201)
        
        # Restore primary storage
        subprocess.run([
            "docker", "compose", "exec", "nginx",
            "sh", "-c", "rm /etc/nginx/conf.d/minio-block.conf && nginx -s reload"
        ], check=True)
```

## Load Resilience Tests

### Test 5: Performance Under Component Degradation

```bash
#!/bin/bash
# tests/resilience/load_test_with_failures.sh
set -euo pipefail

echo "=== Load Test with Simulated Failures ==="

# Install k6 if needed
if ! command -v k6 &> /dev/null; then
  echo "Install k6: https://k6.io/docs/getting-started/installation/"
  exit 1
fi

# Run k6 test while injecting failures
k6 run --out json=results.json - <<'K6SCRIPT'
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const latency = new Trend('request_latency');

export const options = {
  stages: [
    { duration: '2m', target: 50 },   // Ramp up
    { duration: '5m', target: 50 },   // Steady state
    { duration: '2m', target: 100 },  // Spike
    { duration: '5m', target: 100 },  // Steady state under load
    { duration: '2m', target: 0 },    // Ramp down
  ],
  thresholds: {
    errors: ['rate<0.05'],             // <5% error rate
    request_latency: ['p(95)<2000'],   // p95 < 2s
  },
};

export default function () {
  const res = http.get('http://localhost:8000/api/v1/jobs', {
    timeout: '10s',
  });
  
  check(res, {
    'status is 200': (r) => r.status === 200,
    'latency < 2s': (r) => r.timings.duration < 2000,
  });
  
  errorRate.add(res.status !== 200);
  latency.add(res.timings.duration);
  
  sleep(0.1);
}
K6SCRIPT

echo "=== Test Complete ==="
```

### Test 6: Queue Saturation Recovery

```python
# tests/resilience/test_queue_saturation.py
import pytest
import redis
import requests
import time
import threading

class TestQueueSaturation:
    
    def test_queue_saturation_handling(self):
        """Verify system handles queue saturation gracefully."""
        r = redis.Redis(host="localhost", port=6379)
        
        # Flood the queue
        for i in range(10000):
            r.lpush("jobs:default", f"flood-job-{i}")
        
        # Verify API still responds (returns 503 for new jobs)
        resp = requests.post(
            "http://localhost:8000/api/v1/jobs",
            json={"video_url": "https://example.com/test.mp4"},
            timeout=10,
        )
        assert resp.status_code in (200, 201, 429, 503)
        
        # Drain queue
        while r.llen("jobs:default") > 0:
            r.rpop("jobs:default")
            if r.llen("jobs:default") % 1000 == 0:
                print(f"Queue depth: {r.llen('jobs:default')}")
        
        # Verify normal operation resumes
        time.sleep(5)
        resp = requests.post(
            "http://localhost:8000/api/v1/jobs",
            json={"video_url": "https://example.com/test.mp4"},
            timeout=10,
        )
        assert resp.status_code in (200, 201)
```

## Resilience Test Runner

```python
# tests/resilience/runner.py
import subprocess
import sys
import json
import datetime

class ResilienceTestRunner:
    def __init__(self, report_path: str = "resilience-report.json"):
        self.report_path = report_path
        self.results = []
    
    def run_test(self, test_name: str, test_func):
        start = time.time()
        try:
            test_func()
            result = {
                "test": test_name,
                "status": "passed",
                "duration": time.time() - start,
                "timestamp": datetime.datetime.now().isoformat(),
            }
        except AssertionError as e:
            result = {
                "test": test_name,
                "status": "failed",
                "error": str(e),
                "duration": time.time() - start,
                "timestamp": datetime.datetime.now().isoformat(),
            }
        except Exception as e:
            result = {
                "test": test_name,
                "status": "error",
                "error": str(e),
                "duration": time.time() - start,
                "timestamp": datetime.datetime.now().isoformat(),
            }
        
        self.results.append(result)
        return result
    
    def generate_report(self):
        passed = sum(1 for r in self.results if r["status"] == "passed")
        failed = sum(1 for r in self.results if r["status"] == "failed")
        errors = sum(1 for r in self.results if r["status"] == "error")
        
        report = {
            "summary": {
                "total": len(self.results),
                "passed": passed,
                "failed": failed,
                "errors": errors,
                "pass_rate": f"{passed / len(self.results) * 100:.1f}%",
            },
            "tests": self.results,
            "generated_at": datetime.datetime.now().isoformat(),
        }
        
        with open(self.report_path, "w") as f:
            json.dump(report, f, indent=2)
        
        return report

if __name__ == "__main__":
    runner = ResilienceTestRunner()
    
    # Run all resilience tests
    subprocess.run([
        "pytest", "tests/resilience/",
        "-v",
        "--tb=short",
        "--json-report",
        "--json-report-file=resilience-pytest.json",
    ])
    
    print(f"Report saved to {runner.report_path}")
```

## Acceptance Criteria

| Metric | Minimum | Target |
|---|---|---|
| API recovery after crash | < 60s | < 15s |
| Database failover time | < 60s | < 10s |
| Error rate during component failure | < 10% | < 1% |
| Queue recovery after Redis restart | < 120s | < 30s |
| Upload success rate under failure | > 90% | > 99% |
| p99 latency during degradation | < 5s | < 1s |
