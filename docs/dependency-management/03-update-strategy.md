# MiniOp Dependency Update Strategy

## Overview

Keeping dependencies current is a balance between security (patching CVEs fast) and stability (avoiding regressions in a video processing pipeline where failures mean corrupted output or lost jobs). This document defines how MiniOp handles dependency updates across the free-tier self-hosted deployment and scaled production on Kubernetes.

## Update Cadence

### Free Tier (Single Developer / Self-Hosted)

Updates happen monthly. The developer allocates one day per month to dependency maintenance:

1. Run `pip-compile --upgrade` to resolve latest compatible versions
2. Run the full test suite
3. Test video processing with a known-good input file
4. Commit the updated `requirements.txt`
5. Deploy to staging, verify, then promote to production

```bash
# Monthly update workflow
pip-compile requirements.in --upgrade --output-file=requirements.txt
pip install -r requirements.txt
pytest tests/ -x --timeout=120
python scripts/smoke_test.py --input tests/fixtures/sample.mp4
git add requirements.txt
git commit -m "deps: monthly dependency update $(date +%Y-%m)"
```

Critical security patches bypass the monthly cadence and are applied immediately.

### Scaled Production (Team / Kubernetes)

Updates follow a bi-weekly sprint cycle using Renovate for automated PR creation.

**Week 1 — Patch and minor updates:**
- Renovate opens PRs for patch and minor version bumps
- CI runs full test suite + security scans
- Team reviews and merges low-risk updates

**Week 2 — Major updates and manual review:**
- Renovate opens PRs for major version bumps (held until this window)
- Team evaluates breaking changes, runs integration tests
- Merges go to staging for 48-hour soak before production

## Automated Update Tooling

### Renovate Configuration

Renovate runs as a GitHub App. Configuration in `renovate.json`:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:base"],
  "packageRules": [
    {
      "matchUpdateTypes": ["patch"],
      "automerge": true,
      "automergeType": "pr",
      "automergeStrategy": "squash",
      "schedule": ["before 6am on monday"]
    },
    {
      "matchUpdateTypes": ["minor"],
      "automerge": false,
      "groupName": "minor-updates",
      "schedule": ["before 6am on monday"]
    },
    {
      "matchUpdateTypes": ["major"],
      "automerge": false,
      "groupName": "major-updates",
      "schedule": ["before 6am on the first monday of the month"],
      "labels": ["major-update", "needs-review"]
    },
    {
      "matchPackageNames": ["onnxruntime", "onnxruntime-gpu"],
      "schedule": ["before 6am on the first monday of the month"],
      "groupName": "onnxruntime",
      "labels": ["ml-runtime", "needs-testing"]
    },
    {
      "matchPackageNames": ["fastapi", "uvicorn"],
      "groupName": "api-framework",
      "schedule": ["before 6am on monday"]
    },
    {
      "matchPackageNames": ["celery", "kombu", "redis"],
      "groupName": "task-queue",
      "schedule": ["before 6am on monday"]
    }
  ],
  "vulnerabilityAlerts": {
    "enabled": true,
    "labels": ["security"],
    "automerge": true,
    "automergeType": "pr",
    "schedule": ["at any time"]
  },
  "lockFileMaintenance": {
    "enabled": true,
    "schedule": ["before 6am on the first day of the month"],
    "automerge": false
  },
  "prConcurrentLimit": 5,
  "prHourlyLimit": 2,
  "platformAutomerge": true
}
```

Key behaviors:
- **Patch updates** auto-merge on Mondays if CI passes
- **Minor updates** are grouped by domain (API framework, task queue) to reduce PR noise
- **Major updates** are held until the first Monday of each month and require manual review
- **ML runtime** (onnxruntime) updates require extra testing — always held and labeled
- **Vulnerability fixes** bypass all schedules and auto-merge immediately

### Dependabot (Alternative)

If Renovate is not available, use GitHub's built-in Dependabot:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "pip"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
      time: "06:00"
      timezone: "UTC"
    open-pull-requests-limit: 5
    reviewers:
      - "minio/backend-team"
    labels:
      - "dependencies"
    groups:
      api-framework:
        patterns:
          - "fastapi"
          - "uvicorn"
        update-types:
          - "minor"
          - "patch"
      task-queue:
        patterns:
          - "celery"
          - "kombu"
          - "redis"
        update-types:
          - "minor"
          - "patch"

  - package-ecosystem: "docker"
    directory: "/"
    schedule:
      interval: "weekly"
    labels:
      - "docker"
      - "dependencies"

  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
    labels:
      - "ci"
```

## Update Classification and Handling

### Patch Updates (0.0.X)

**Risk:** Low. Bug fixes, no API changes.

**Handling:** Auto-merge after CI passes. No manual review needed unless the package is in the ML runtime group.

```bash
# CI validation for patch updates
pytest tests/ -x --timeout=120
pip-audit -r requirements.txt
bandit -r src/ -ll
```

### Minor Updates (0.X.0)

**Risk:** Medium. New features, backward-compatible.

**Handling:** Grouped PRs reviewed by one team member. Integration tests run on staging for 24 hours before production merge.

```bash
# Additional validation for minor updates
pytest tests/ -x --timeout=120
pytest tests/integration/ -x --timeout=300
python scripts/smoke_test.py --input tests/fixtures/sample.mp4 --compare-output
```

The `--compare-output` flag compares the processed video output byte-for-byte against a known-good reference. Any difference in output means the update changed processing behavior and requires investigation.

### Major Updates (X.0.0)

**Risk:** High. Breaking changes, API removals.

**Handling:** Manual review required. Migration guide must be read. Dedicated branch with full integration testing.

Process for a major update (e.g., `fastapi 0.x -> 1.x`):

1. **Read the changelog and migration guide:**
   ```bash
   # Check what changed
   pip index versions fastapi
   # Visit: https://fastapi.tiangolo.com/release-notes/
   ```

2. **Create a dedicated branch:**
   ```bash
   git checkout -b deps/fastapi-1.x-upgrade
   ```

3. **Update and fix breaking changes:**
   ```bash
   # Update the package
   poetry add fastapi@^1.0
   # Fix import/API changes
   grep -rn "from fastapi" src/ | grep -v __pycache__
   ```

4. **Run the full validation suite:**
   ```bash
   pytest tests/ -x --timeout=120 -v
   pytest tests/integration/ -x --timeout=300 -v
   pytest tests/e2e/ -x --timeout=600 -v
   python scripts/smoke_test.py --input tests/fixtures/ --compare-output
   mypy src/ --strict
   bandit -r src/
   ```

5. **Deploy to staging for 48-hour soak:**
   ```bash
   # Staging deployment
   kubectl set image deployment/worker worker=minio/worker:staging-fastapi1x \
     -n minio-staging
   kubectl set image deployment/api api=minio/api:staging-fastapi1x \
     -n minio-staging
   ```

6. **Monitor staging metrics:**
   - Error rate (should not increase)
   - P95 latency (should not regress more than 10%)
   - Video processing success rate (must remain 99.9%+)
   - Memory usage (watch for leaks)

7. **Promote to production:**
   ```bash
   kubectl set image deployment/worker worker=minio/worker:production \
     -n minio-production
   kubectl set image/deployment/api api=minio/api:production \
     -n minio-production
   ```

## Rollback Procedure

### Free Tier

```bash
# Restore previous requirements.txt
git checkout HEAD~1 -- requirements.txt
pip install -r requirements.txt
# Restart the service
systemctl restart minio-worker
```

### Scaled Production

```bash
# Rollback Kubernetes deployment
kubectl rollout undo deployment/worker -n minio-production
kubectl rollout undo deployment/api -n minio-production

# Verify rollback
kubectl rollout status deployment/worker -n minio-production
kubectl rollout status deployment/api -n minio-production

# Confirm running image
kubectl get pods -n minio-production -o jsonpath='{.items[*].spec.containers[0].image}'
```

If the rollback is due to a specific dependency, pin the previous version:

```bash
# Pin the problematic package
poetry add problematic-package@0.14.0
git commit -m "deps: pin problematic-package to 0.14.0 due to regression in 0.15.0"
```

## Frozen Dependencies

Certain dependencies are intentionally frozen and require explicit team decision to update:

| Package | Frozen Version | Reason |
|---------|---------------|--------|
| `onnxruntime-gpu` | 1.18.x | Model compatibility — ML models are exported for this runtime version |
| `celery` | 5.4.x | Task serialization format — upgrading requires coordinated worker rollout |
| `sqlalchemy` | 2.0.x | Migration complexity — major version changes require DB migration review |

Frozen packages still receive security patches. The freeze only applies to non-security minor and major updates.

To update a frozen package:

1. Open an RFC issue explaining why the update is needed
2. List all breaking changes and required code modifications
3. Get sign-off from two maintainers
4. Create a dedicated branch with extended testing (1-week staging soak)
5. Coordinate the rollout with the operations team

## Monitoring Update Health

After any dependency update, monitor these signals for 72 hours:

### Prometheus Metrics

```yaml
# Alert rules for post-update monitoring
groups:
  - name: dependency-updates
    rules:
      - alert: VideoProcessingErrorRateHigh
        expr: rate(minio_video_processing_errors_total[5m]) / rate(minio_video_processing_total[5m]) > 0.01
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Video processing error rate above 1% after dependency update"

      - alert: WorkerMemoryUsageHigh
        expr: container_memory_working_set_bytes{container="worker"} / container_spec_memory_limit_bytes{container="worker"} > 0.85
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Worker memory usage above 85% — possible memory leak from dependency update"

      - alert: APIP95LatencyRegression
        expr: histogram_quantile(0.95, rate(minio_api_request_duration_seconds_bucket[5m])) > 0.5
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "API P95 latency above 500ms — possible regression from dependency update"
```

### Dashboard

Grafana dashboard at `https://grafana.minio.dev/d/dep-updates` tracks:
- Processing success rate (time series, 7-day window)
- Worker memory (time series, compare pre/post update)
- API latency percentiles (P50, P95, P99)
- Error rate by category (video decode, encode, ML inference, storage)

## Emergency Update Process

For actively exploited vulnerabilities (CVSS 9+ with known exploits in the wild):

1. **Freeze the dependency** — pin the vulnerable version in a branch
2. **Apply the patch** — update to the fixed version
3. **Skip staging soak** — deploy directly to production with monitoring
4. **Notify users** — post to the status page and GitHub security advisory
5. **Post-mortem** — document the incident within 48 hours

```bash
# Emergency update workflow
git checkout -b hotfix/cve-2025-XXXXX
poetry add vulnerable-package@<fixed-version>
pytest tests/ -x --timeout=120
git commit -m "hotfix: patch CVE-2025-XXXXX in vulnerable-package"
git push origin hotfix/cve-2025-XXXXX
# Merge after CI passes, deploy immediately
```

## Dependency Freshness Report

Generated monthly. Tracks how current each dependency is:

```bash
# Generate freshness report
pip list --outdated --format=json > outdated.json
python scripts/dep_freshness_report.py outdated.json --output report.md
```

The report flags:
- Packages more than 2 major versions behind
- Packages with no release in 12+ months
- Packages where the current version has known CVEs
- Frozen packages where the freeze reason may no longer apply

This report is reviewed in the monthly dependency review meeting and drives the prioritization of update work.
