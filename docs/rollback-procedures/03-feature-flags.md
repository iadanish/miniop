# MiniOp Feature Flags

## Overview

Feature flags (also called feature toggles) are the primary mechanism for decoupling deployment from release in MiniOp. Instead of rolling back an entire deployment when a new feature causes problems, you disable the feature flag and the code path reverts to the previous behavior without redeployment.

MiniOp uses **Unleash** as its feature flag management platform. The free tier runs Unleash as a Docker container alongside the rest of the stack. Production runs Unleash as a managed service with a PostgreSQL backend.

Feature flags are the preferred first response to feature-level regressions. Database rollback and full deployment rollback are reserved for cases where feature flags cannot mitigate the issue (e.g., a migration-related bug or a global performance regression).

## Architecture

### Flag Evaluation Flow

```
Client Request
  → API Gateway (reads flag state from Unleash SDK cache)
    → Application Code
      → if (isEnabled('new-clip-engine')) { useNewEngine() } else { useLegacyEngine() }
```

The Unleash SDK caches flag state locally and refreshes every 15 seconds. This means flag changes propagate within 15 seconds across all API and worker instances, with no redeployment required.

### Free Tier Setup

```yaml
# docker-compose.prod.yml (excerpt)
services:
  unleash:
    image: unleashorg/unleash-server:5
    environment:
      - DATABASE_URL=postgresql://unleash:***@postgres:5432/unleash
      - INIT_ADMIN_API_TOKENS=miniop-admin:*.unleash.insecure
    ports:
      - "4242:4242"
    depends_on:
      - postgres
```

```bash
# Initialize the Unleash database
docker compose exec postgres psql -U postgres -c "CREATE DATABASE unleash;"
docker compose exec postgres psql -U postgres -c "CREATE USER unleash WITH PASSWORD 'unleash_password';"
docker compose exec postgres psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE unleash TO unleash;"
docker compose up -d unleash
```

### Production Setup

```yaml
# Kubernetes ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: unleash-config
  namespace: minio
data:
  DATABASE_URL: "postgresql://unleash:***@rds-unleash.cluster-xyz.us-east-1.rds.amazonaws.com:5432/unleash"
  INIT_ADMIN_API_TOKENS: ""  # Managed via AWS Secrets Manager
```

```yaml
# Kubernetes Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: unleash
  namespace: minio
spec:
  replicas: 2
  selector:
    matchLabels:
      app: unleash
  template:
    metadata:
      labels:
        app: unleash
    spec:
      containers:
        - name: unleash
          image: unleashorg/unleash-server:5
          ports:
            - containerPort: 4242
          envFrom:
            - configMapRef:
                name: unleash-config
          livenessProbe:
            httpGet:
              path: /health
              port: 4242
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /health
              port: 4242
            periodSeconds: 5
```

## SDK Integration

### Node.js API Server

```typescript
// src/lib/feature-flags.ts
import { initialize } from 'unleash-client';

const unleash = initialize({
  url: process.env.UNLEASH_URL || 'http://unleash:4242/api',
  appName: 'minio-api',
  customHeaders: {
    Authorization: process.env.UNLEASH_API_TOKEN || '',
  },
  refreshInterval: 15_000, // 15 seconds
  metricsInterval: 60_000, // send usage metrics every 60s
});

export { unleash };
```

```typescript
// src/services/clip-generator.ts
import { unleash } from '../lib/feature-flags';

export async function generateClip(videoId: string, options: ClipOptions) {
  if (unleash.isEnabled('new-clip-engine')) {
    return newClipEngine(videoId, options);
  }
  return legacyClipEngine(videoId, options);
}
```

### Python Worker

```python
# worker/feature_flags.py
from UnleashClient import UnleashClient
import os

client = UnleashClient(
    url=os.getenv("UNLEASH_URL", "http://unleash:4242/api"),
    app_name="minio-worker",
    custom_headers={"Authorization": os.getenv("UNLEASH_API_TOKEN", "")},
    refresh_interval=15,
)
client.initialize_client()

def is_enabled(flag_name: str) -> bool:
    return client.is_enabled(flag_name)
```

```python
# worker/transcription.py
from worker.feature_flags import is_enabled

def transcribe_video(video_path: str) -> Transcript:
    if is_enabled("whisper-v3-transcription"):
        return whisper_v3_transcribe(video_path)
    return whisper_v2_transcribe(video_path)
```

## Flag Lifecycle

Every MiniOp feature flag follows a defined lifecycle. Flags that do not progress through the lifecycle are technical debt and are tracked for removal.

### Stage 1: Development

Flag is created in Unleash with the naming convention `<team>.<feature>.<variant>`:

```
clip-engine.new-scene-detection
clip-engine.new-scene-detection.enabled
transcription.whisper-v3
billing.metered-pricing
```

The flag is enabled only for development and staging environments:

```bash
# Create flag via Unleash API
curl -X POST http://localhost:4242/api/admin/projects/default/features \
  -H "Authorization: $UNLEASH_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "clip-engine.new-scene-detection",
    "description": "Use the new ML-based scene detection algorithm",
    "type": "release",
    "stale": false
  }'
```

### Stage 2: Canary Release

The flag is enabled for a percentage of users or specific user IDs. This is used for gradual rollout in production.

```bash
# Enable for 10% of users
curl -X PUT http://localhost:4242/api/admin/projects/default/features/clip-engine.new-scene-detection/environments/production/strategies \
  -H "Authorization: $UNLEASH_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "flexibleRollout",
    "parameters": {
      "rollout": "10",
      "stickiness": "userId",
      "groupId": "clip-engine.new-scene-detection"
    }
  }'
```

### Stage 3: General Availability

The flag is enabled for 100% of users. The flag remains in the codebase for one release cycle as a kill switch.

### Stage 4: Removal

After one release cycle at GA, the flag and its fallback code path are removed:

```typescript
// Before removal
if (unleash.isEnabled('new-clip-engine')) {
  return newClipEngine(videoId, options);
}
return legacyClipEngine(videoId, options);

// After removal
return newClipEngine(videoId, options);
```

## Emergency Kill Switch Procedure

When a feature causes production issues, the kill switch procedure is the fastest way to mitigate without a full rollback.

### Step 1: Identify the Faulty Feature Flag

```bash
# List all flags and their status
curl -s http://localhost:4242/api/admin/projects/default/features \
  -H "Authorization: $UNLEASH_API_TOKEN" | jq '.features[] | {name, type, stale}'

# Check a specific flag's strategies
curl -s http://localhost:4242/api/admin/projects/default/features/clip-engine.new-scene-detection/environments/production/strategies \
  -H "Authorization: $UNLEASH_API_TOKEN" | jq .
```

### Step 2: Disable the Flag

```bash
curl -X PUT http://localhost:4242/api/admin/projects/default/features/clip-engine.new-scene-detection/environments/production/on \
  -H "Authorization: $UNLEASH_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

### Step 3: Verify Propagation

Wait 15 seconds for SDK caches to refresh, then verify:

```bash
# Check from the API server's perspective
curl -s http://localhost:8080/api/internal/flags | jq '.[] | select(.name == "clip-engine.new-scene-detection")'
# Expected: {"name":"clip-engine.new-scene-detection","enabled":false}

# Check application logs for the flag evaluation
docker compose logs api --tail=20 | grep "clip-engine.new-scene-detection"
```

### Step 4: Monitor Recovery

```bash
# Watch error rates (if using Prometheus/Grafana)
curl -s 'http://localhost:9090/api/v1/query?query=rate(http_requests_total{status=~"5.."}[1m])' | jq '.data.result[].value[1]'

# Watch processing queue depth
curl -s http://localhost:8080/api/internal/jobs/queue-depth | jq .
```

## Flag Types in MiniOp

### Release Flags

Used for gradual rollout of new features. These are temporary and should be removed within 2-4 weeks of GA.

| Flag Name | Purpose | Status |
|---|---|---|
| `clip-engine.new-scene-detection` | ML-based scene detection | Canary (10%) |
| `transcription.whisper-v3` | Whisper V3 transcription model | GA |
| `ui.dark-mode` | Dark mode frontend theme | Development |

### Ops Flags

Used for operational control. These are long-lived and act as circuit breakers.

| Flag Name | Purpose | Default |
|---|---|---|
| `ops.gpu-processing` | Enable GPU-accelerated clip rendering | Enabled |
| `ops.external-transcription` | Fall back to external transcription API if GPU is unavailable | Disabled |
| `ops.rate-limit-strict` | Enable strict rate limiting (used during DDoS mitigation) | Disabled |
| `ops.maintenance-mode` | Return 503 for all non-health endpoints | Disabled |

### Experiment Flags

Used for A/B testing clip generation algorithms. These are permanent fixtures with rotating values.

| Flag Name | Purpose | Current Variant |
|---|---|---|
| `exp.engagement-scoring` | Which engagement scoring model to use | `v3-bayesian` |
| `exp.thumbnail-generation` | Thumbnail extraction strategy | `smart-crop` |

## Rollback via Feature Flags vs. Deployment Rollback

| Scenario | Feature Flag | Deployment Rollback |
|---|---|---|
| New UI component is broken | Disable flag, old UI renders | Roll back frontend deployment |
| New clip algorithm produces bad output | Disable flag, workers use old algorithm | Roll back worker deployment |
| API endpoint has a performance regression | Disable flag, endpoint uses old path | Roll back API deployment |
| Database migration breaks queries | **Cannot fix with flags** | Must roll back deployment + database |
| Global auth middleware failure | **Cannot fix with flags** | Must roll back deployment |

Feature flags are the first line of defense for feature-level issues. They are not a substitute for deployment rollback when the issue is in shared infrastructure, database schema, or authentication.

## Monitoring Flag Health

### Stale Flag Detection

Flags that have been at GA for more than 2 weeks without being removed are flagged as stale:

```bash
# Query Unleash for stale flags
curl -s http://localhost:4242/api/admin/projects/default/features \
  -H "Authorization: $UNLEASH_API_TOKEN" | \
  jq '.features[] | select(.stale == true) | {name, createdAt}'
```

### Flag Usage Metrics

Unleash tracks how often each flag is evaluated and in what state. This data identifies unused flags and flags that are never disabled:

```bash
# Get metrics for the last hour
curl -s http://localhost:4242/api/admin/metrics/features \
  -H "Authorization: $UNLEASH_API_TOKEN" | jq '.data.lastHour'
```

### CI/CD Enforcement

The CI pipeline enforces flag hygiene:

```yaml
# .github/workflows/flag-hygiene.yml
name: Feature Flag Hygiene
on:
  schedule:
    - cron: '0 9 * * 1'  # Every Monday at 9am
jobs:
  check-stale-flags:
    runs-on: ubuntu-latest
    steps:
      - name: Find stale flags
        run: |
          STALE=$(curl -s "$UNLEASH_URL/api/admin/projects/default/features" \
            -H "Authorization: $UNLEASH_API_TOKEN" | \
            jq '[.features[] | select(.stale == true)] | length')
          if [ "$STALE" -gt 0 ]; then
            echo "::warning::$STALE stale feature flags found. Please remove them."
          fi
```

## Related Documents

- [01-rollback-strategy.md](./01-rollback-strategy.md) - Overall rollback strategy and decision matrix
- [02-database-rollback.md](./02-database-rollback.md) - Database migration rollback procedures
