# Performance Testing Strategy

## Overview

Performance testing ensures MiniOp meets latency, throughput, and resource consumption targets under realistic and peak load conditions. For a video processing SaaS, performance is not optional — users uploading 4K videos and expecting sub-minute clip detection will churn if the system is slow. This document defines load testing, stress testing, and continuous performance monitoring using **k6** as the primary tool.

## Performance Targets

| Metric | Free Tier | Pro Tier | Enterprise |
|--------|-----------|----------|------------|
| API response time (p95) | < 500ms | < 300ms | < 200ms |
| Video upload (100MB) | < 30s | < 15s | < 10s |
| Analysis job completion (10min video) | < 5min | < 2min | < 1min |
| Concurrent users | 50 | 500 | 5000 |
| Error rate under load | < 1% | < 0.5% | < 0.1% |
| Uptime SLA | Best effort | 99.9% | 99.99% |

## Tooling

MiniOp uses **k6** (Grafana) for load and stress testing. k6 scripts are written in JavaScript, run from the CLI, and produce machine-readable output for CI integration.

```bash
# Install k6
# macOS
brew install k6

# Windows
winget install k6

# Linux
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

## Load Test Scenarios

### API Load Test

Tests the core API endpoints under sustained load:

```js
// perf/load-test.js
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const apiDuration = new Trend('api_duration', true);

export const options = {
  stages: [
    { duration: '2m', target: 50 },   // Ramp up to 50 users
    { duration: '5m', target: 50 },   // Hold at 50 users
    { duration: '2m', target: 100 },  // Ramp to 100 users
    { duration: '5m', target: 100 },  // Hold at 100 users
    { duration: '2m', target: 0 },    // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    errors: ['rate<0.01'],
    api_duration: ['p(95)<500'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const AUTH_TOKEN = __ENV.TEST_AUTH_TOKEN;

function getHeaders() {
  return {
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
}

export default function () {
  group('Dashboard API', () => {
    const dashboardRes = http.get(`${BASE_URL}/api/dashboard`, getHeaders());
    check(dashboardRes, {
      'dashboard status is 200': (r) => r.status === 200,
      'dashboard has videos': (r) => JSON.parse(r.body).videos !== undefined,
    });
    apiDuration.add(dashboardRes.timings.duration);
    errorRate.add(dashboardRes.status !== 200);
  });

  group('Video List API', () => {
    const listRes = http.get(
      `${BASE_URL}/api/videos?page=1&limit=20`,
      getHeaders()
    );
    check(listRes, {
      'video list status is 200': (r) => r.status === 200,
      'video list returns array': (r) => Array.isArray(JSON.parse(r.body).data),
    });
    apiDuration.add(listRes.timings.duration);
    errorRate.add(listRes.status !== 200);
  });

  group('Clip Details API', () => {
    const clipRes = http.get(
      `${BASE_URL}/api/clips/clip_load_test_001`,
      getHeaders()
    );
    check(clipRes, {
      'clip details status is 200': (r) => r.status === 200,
      'clip has timestamps': (r) => {
        const body = JSON.parse(r.body);
        return body.startTime !== undefined && body.endTime !== undefined;
      },
    });
    apiDuration.add(clipRes.timings.duration);
    errorRate.add(clipRes.status !== 200);
  });

  sleep(1);
}
```

### Video Upload Stress Test

Tests file upload handling under concurrent load:

```js
// perf/upload-stress.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Rate, Counter } from 'k6/metrics';

const errorRate = new Rate('upload_errors');
const uploadCounter = new Rate('successful_uploads');

export const options = {
  stages: [
    { duration: '1m', target: 10 },
    { duration: '3m', target: 10 },
    { duration: '1m', target: 20 },
    { duration: '3m', target: 20 },
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    upload_errors: ['rate<0.05'],
    http_req_duration: ['p(95)<30000'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const AUTH_TOKEN = __ENV.TEST_AUTH_TOKEN;

// Use a real video file for upload testing
const videoFile = open('../e2e/fixtures/test-video.mp4', 'b');

export default function () {
  const formData = {
    file: http.file(videoFile, 'test-video.mp4', 'video/mp4'),
  };

  const res = http.post(`${BASE_URL}/api/videos/upload`, formData, {
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    timeout: '120s',
  });

  const success = check(res, {
    'upload status is 200 or 201': (r) => r.status === 200 || r.status === 201,
    'upload returns video id': (r) => {
      try {
        return JSON.parse(r.body).videoId !== undefined;
      } catch {
        return false;
      }
    },
  });

  errorRate.add(!success);
  uploadCounter.add(success);

  sleep(2);
}
```

### Analysis Job Throughput Test

Tests the video analysis pipeline under concurrent job submission:

```js
// perf/analysis-throughput.js
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const jobSuccessRate = new Rate('job_success');
const jobCompletionTime = new Trend('job_completion_time');

export const options = {
  scenarios: {
    constant_load: {
      executor: 'constant-arrival-rate',
      rate: 5,                // 5 new jobs per second
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 20,
      maxVUs: 50,
    },
  },
  thresholds: {
    job_success: ['rate>0.95'],
    job_completion_time: ['p(95)<300000'],  // 5 minutes
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const AUTH_TOKEN = __ENV.TEST_AUTH_TOKEN;

function getHeaders() {
  return {
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
}

export default function () {
  group('Submit and Poll Analysis Job', () => {
    // Submit analysis job
    const submitRes = http.post(
      `${BASE_URL}/api/videos/vid_load_test/analyze`,
      JSON.stringify({ model: 'default', maxClips: 5 }),
      getHeaders()
    );

    const submitSuccess = check(submitRes, {
      'job submitted': (r) => r.status === 202,
    });

    if (!submitSuccess) {
      jobSuccessRate.add(false);
      return;
    }

    const jobId = JSON.parse(submitRes.body).jobId;
    const startTime = Date.now();

    // Poll for completion
    let completed = false;
    let attempts = 0;
    const maxAttempts = 60;  // 5 minutes at 5s intervals

    while (!completed && attempts < maxAttempts) {
      sleep(5);
      attempts++;

      const statusRes = http.get(
        `${BASE_URL}/api/jobs/${jobId}`,
        getHeaders()
      );

      if (statusRes.status === 200) {
        const body = JSON.parse(statusRes.body);
        if (body.status === 'completed') {
          completed = true;
          jobCompletionTime.add(Date.now() - startTime);
          jobSuccessRate.add(true);
        } else if (body.status === 'failed') {
          jobSuccessRate.add(false);
          break;
        }
      }
    }

    if (!completed) {
      jobSuccessRate.add(false);
    }
  });
}
```

### WebSocket Connection Test

Tests real-time progress updates via WebSocket:

```js
// perf/websocket-test.js
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';

const wsErrors = new Rate('ws_errors');
const messagesReceived = new Counter('ws_messages');

export const options = {
  stages: [
    { duration: '1m', target: 100 },
    { duration: '3m', target: 100 },
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    ws_errors: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.WS_URL || 'ws://localhost:3000';
const AUTH_TOKEN = __ENV.TEST_AUTH_TOKEN;

export default function () {
  const url = `${BASE_URL}/ws?token=${AUTH_TOKEN}`;

  const res = ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'subscribe',
        channel: 'job_progress',
      }));
    });

    socket.on('message', (data) => {
      const msg = JSON.parse(data);
      messagesReceived.add(1);

      check(msg, {
        'message has type': (m) => m.type !== undefined,
        'progress is valid': (m) =>
          m.type !== 'progress' || (m.progress >= 0 && m.progress <= 100),
      });
    });

    socket.on('error', () => {
      wsErrors.add(1);
    });

    // Keep connection open for observation
    sleep(30);
    socket.close();
  });

  check(res, {
    'websocket connected': (r) => r && r.status === 101,
  });
}
```

## Stress Testing

Stress tests push the system beyond normal capacity to find breaking points:

```js
// perf/stress-test.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const duration = new Trend('req_duration');

export const options = {
  scenarios: {
    ramp_to_breaking: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 100 },
        { duration: '2m', target: 200 },
        { duration: '2m', target: 400 },
        { duration: '2m', target: 600 },
        { duration: '2m', target: 800 },
        { duration: '2m', target: 1000 },
        { duration: '5m', target: 1000 },
        { duration: '2m', target: 0 },
      ],
    },
  },
  thresholds: {
    errors: ['rate<0.05'],   // Allow up to 5% errors during stress
    req_duration: ['p(95)<5000'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const AUTH_TOKEN = __ENV.TEST_AUTH_TOKEN;

export default function () {
  const endpoints = [
    { method: 'GET', url: `${BASE_URL}/api/dashboard` },
    { method: 'GET', url: `${BASE_URL}/api/videos?page=1&limit=20` },
    { method: 'GET', url: `${BASE_URL}/api/clips/clip_stress_001` },
    { method: 'GET', url: `${BASE_URL}/api/user/profile` },
  ];

  const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];

  const res = http.request(
    endpoint.method,
    endpoint.url,
    null,
    {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );

  check(res, {
    'status is ok': (r) => r.status >= 200 && r.status < 400,
  });

  errorRate.add(res.status >= 500);
  duration.add(res.timings.duration);

  sleep(Math.random() * 2);
}
```

## Database Performance Tests

```js
// perf/database-heavy.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const queryDuration = new Trend('query_heavy_endpoint');

export const options = {
  vus: 20,
  duration: '5m',
  thresholds: {
    query_heavy_endpoint: ['p(95)<1000'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const AUTH_TOKEN = __ENV.TEST_AUTH_TOKEN;

export default function () {
  // Search with filters (exercises multiple indexes)
  const searchRes = http.get(
    `${BASE_URL}/api/videos?search=test&sort=createdAt&order=desc&page=1&limit=50&status=processed`,
    {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
    }
  );

  check(searchRes, {
    'search returns 200': (r) => r.status === 200,
    'search completes under 1s': (r) => r.timings.duration < 1000,
  });

  queryDuration.add(searchRes.timings.duration);

  // Aggregation endpoint (clips grouped by score)
  const statsRes = http.get(
    `${BASE_URL}/api/videos/vid_load_test/stats`,
    {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
    }
  );

  check(statsRes, {
    'stats returns 200': (r) => r.status === 200,
    'stats has distribution': (r) => {
      try {
        return JSON.parse(r.body).scoreDistribution !== undefined;
      } catch {
        return false;
      }
    },
  });

  queryDuration.add(statsRes.timings.duration);

  sleep(1);
}
```

## Running Performance Tests

```bash
# Load test (normal traffic simulation)
k6 run perf/load-test.js

# Upload stress test
k6 run perf/upload-stress.js

# Analysis throughput test
k6 run perf/analysis-throughput.js

# WebSocket test
k6 run perf/websocket-test.js

# Stress test (find breaking point)
k6 run perf/stress-test.js

# Database-heavy queries
k6 run perf/database-heavy.js

# With custom environment variables
k6 run --env BASE_URL=https://staging.minio.dev --env TEST_AUTH_TOKEN=xxx perf/load-test.js

# Output JSON for CI
k6 run --out json=results/load-test.json perf/load-test.js

# Cloud output (Grafana Cloud)
k6 run --out cloud perf/load-test.js
```

## Free Tier vs. Production

| Aspect | Free Tier (Local) | Production (CI/CD) |
|--------|-------------------|---------------------|
| Target | localhost | Staging environment |
| VUs | 10-50 | 100-1000 |
| Duration | 2-5 minutes | 15-30 minutes |
| Scenarios | Single scenario | Multi-scenario mix |
| Output | Console + JSON | Grafana dashboards |
| Gate | Advisory | Hard block on deploy |
| Frequency | Manual | Nightly + pre-release |

### CI Integration

```yaml
# .github/workflows/performance-tests.yml
name: Performance Tests
on:
  schedule:
    - cron: '0 3 * * *'  # Nightly at 3 AM
  workflow_dispatch:
    inputs:
      scenario:
        description: 'Test scenario to run'
        type: choice
        options:
          - load-test
          - stress-test
          - upload-stress
          - analysis-throughput

jobs:
  perf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run k6 test
        uses: grafana/k6-action@v0.3.1
        with:
          filename: perf/${{ inputs.scenario || 'load-test' }}.js
        env:
          BASE_URL: ${{ secrets.STAGING_URL }}
          TEST_AUTH_TOKEN: ${{ secrets.STAGING_AUTH_TOKEN }}

      - name: Upload results
        uses: actions/upload-artifact@v4
        with:
          name: k6-results
          path: results/

      - name: Check thresholds
        run: |
          if [ $? -ne 0 ]; then
            echo "::error::Performance test thresholds failed"
            exit 1
          fi
```

## Monitoring and Alerting

Performance tests are complemented by production monitoring:

```ts
// src/middleware/performance.ts
import { Request, Response, NextFunction } from 'express';
import { httpRequestDuration, httpRequestTotal } from '../metrics';

export function performanceMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e6; // ms

    httpRequestDuration.observe(
      { method: req.method, path: req.route?.path || 'unknown', status: res.statusCode },
      duration
    );

    httpRequestTotal.inc({
      method: req.method,
      path: req.route?.path || 'unknown',
      status: res.statusCode,
    });
  });

  next();
}
```

### Grafana Dashboard Queries

```promql
# P95 API latency
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))

# Error rate
rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m])

# Active analysis jobs
analysis_jobs_active

# Video processing throughput
rate(videos_processed_total[1h])
```

## Interpreting Results

k6 produces a summary after each run:

```
  █ THRESHOLDS

    http_req_duration
    ✓ 'p(95)<500' p(95)=234.51ms
    ✓ 'p(99)<1000' p(99)=678.23ms

    errors
    ✓ 'rate<0.01' rate=0.0023

  █ TOTAL RESULTS

    checks_total........: 12450  692.3/s
    checks_succeeded....: 12421  99.76%
    checks_failed.......: 29     0.24%

    http_req_duration...........: avg=89.23ms  min=12.45ms  med=67.89ms  max=1.23s  p(90)=189.45ms  p(95)=234.51ms
    http_reqs...................: 6234   346.15/s
    iteration_duration..........: avg=2.89s    min=1.23s    med=2.67s    max=8.9s   p(90)=4.12s     p(95)=5.67s
    iterations..................: 2078   115.38/s
    vus.........................: 50     min=0    max=50
    vus_max.....................: 50     min=50   max=50
```

Key things to check:
1. **p95 vs. target** — If p95 exceeds the threshold, investigate the slow 5% of requests.
2. **Error rate** — Any non-zero error rate under normal load indicates a bug.
3. **Throughput degradation** — If requests/second drops as VUs increase, the system is saturating.
4. **Memory leaks** — Run extended tests (30+ minutes) and monitor server memory.

## Performance Regression Prevention

Every PR that touches API routes, database queries, or the processing pipeline must include a performance impact note. The nightly k6 run compares results against the baseline:

```bash
# Compare current run with baseline
k6 run --summary-export=results/current.json perf/load-test.js
node scripts/compare-perf.mjs results/baseline.json results/current.json
```

If regression exceeds 10% on any p95 metric, the deploy is blocked until the regression is addressed or the baseline is intentionally updated with justification.
