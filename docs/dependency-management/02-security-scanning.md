# MiniOp Security Scanning

## Overview

MiniOp processes user-uploaded video files and runs ML inference in isolated workers. A compromised dependency can lead to arbitrary code execution during video transcoding, data exfiltration from the processing pipeline, or denial of service through resource exhaustion. This document defines the security scanning strategy for both the free-tier self-hosted deployment and the scaled production environment on Kubernetes.

## Threat Model

Dependencies are the primary attack surface. The key risks:

| Risk | Impact | Example |
|------|--------|---------|
| Known CVE in transitive dependency | RCE, data leak | `Pillow` buffer overflow during thumbnail generation |
| Typosquatting | Malware injection | `fastapi-utols` instead of `fastapi-utils` |
| Dependency confusion | Internal package takeover | Unscoped private package name collision on PyPI |
| Malicious maintainer takeover | Supply chain compromise | Compromised PyPI account pushing backdoored release |
| License violation | Legal exposure | Accidentally pulling in AGPL code |

## Scanning Tools

### Free Tier Stack

The free tier uses open-source tooling that runs locally and in GitHub Actions.

#### pip-audit

Scans installed packages against the [OSV database](https://osv.dev/). This is the primary vulnerability scanner for the free tier.

```bash
# Scan current environment
pip-audit

# Scan a requirements file
pip-audit -r requirements.txt

# Scan with hashes for supply-chain verification
pip-audit --require-hashes -r requirements.txt

# Output JSON for CI parsing
pip-audit --format=json --output=audit-results.json -r requirements.txt
```

Integrate into CI:

```yaml
# .github/workflows/security.yml
name: Security Scan
on:
  push:
    paths:
      - 'requirements.txt'
      - 'requirements.in'
      - 'src/**'
  pull_request:
  schedule:
    - cron: '0 6 * * 1'  # Weekly Monday 6AM UTC

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - run: pip install pip-audit
      - name: Run pip-audit
        run: |
          pip-audit -r requirements.txt \
            --format=json \
            --output=audit-results.json \
            --desc 2>&1 | tee audit-output.txt
      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: audit-results
          path: audit-results.json
```

#### safety

Cross-references against the Safety DB. Useful as a secondary check since it catches advisories that may not yet be in OSV.

```bash
pip install safety
safety check -r requirements.txt --json
```

#### bandit

Static analysis for Python code that detects security anti-patterns in the application code itself (not dependencies, but catches dangerous usage patterns).

```bash
pip install bandit
bandit -r src/ -f json -o bandit-report.json --severity-level medium
```

Key rules relevant to MiniOp:
- `B603` — subprocess calls with shell=True (forbidden in video processing workers)
- `B301` — pickle usage (blocked; ML models use ONNX, not pickle)
- `B404` — import subprocess (flagged for review, not blocked)
- `B110` — try/except pass (catches swallowed errors in async workers)

### Scaled Production Stack

Production adds commercial and enterprise-grade scanning on top of the free-tier tools.

#### Snyk

Integrated as both a CI gate and a monitoring service. Snyk provides:
- Vulnerability scanning with fix suggestions
- License compliance checking
- Container image scanning
- PR checks with fixable upgrade paths

```yaml
# .github/workflows/snyk.yml
name: Snyk Security
on:
  push:
    branches: [main]
  pull_request:

jobs:
  snyk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: snyk/actions/python-3.11@master
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
        with:
          command: test
          args: --severity-threshold=high --fail-on=upgradable
      - uses: snyk/actions/python-3.11@master
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
        with:
          command: monitor
```

Snyk policy file (`.snyk`) for managing exceptions:

```yaml
# .snyk
version: v1.25.0
ignore:
  'SNYK-PYTHON-PILLOW-1234567':
    - '*':
        reason: 'Not exploitable: thumbnail generation uses safe resize only'
        expires: '2025-03-01T00:00:00.000Z'
patch: {}
```

#### Trivy

Container image scanning. Runs on every Docker image built in CI and on a nightly schedule against production images in the registry.

```bash
# Scan local image
trivy image minio/worker:latest --severity HIGH,CRITICAL

# Scan with SARIF output for GitHub Security tab
trivy image minio/worker:latest \
  --format sarif \
  --output trivy-results.sarif \
  --severity HIGH,CRITICAL

# Scan filesystem (dependencies + code)
trivy fs . --scanners vuln,secret,misconfig
```

CI integration:

```yaml
# .github/workflows/container-scan.yml
- name: Build image
  run: docker build -t minio/worker:${{ github.sha }} -f Dockerfile.production .

- name: Trivy scan
  uses: aquasecurity/trivy-action@master
  with:
    image-ref: 'minio/worker:${{ github.sha }}'
    format: 'sarif'
    output: 'trivy-results.sarif'
    severity: 'HIGH,CRITICAL'
    exit-code: '1'

- name: Upload to GitHub Security
  uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: 'trivy-results.sarif'
```

## Dependency Confusion Protection

### Package Namespace

All internal MiniOp packages use a reserved namespace prefix:

```
minio-core
minio-worker
minio-clipping
```

Pin internal packages by hash in `requirements.txt`:

```
minio-core==0.4.2 --hash=sha256:abc123...
```

### PyPI Configuration

For production, configure pip to only pull from a private registry with PyPI as a fallback:

```toml
# pip.conf (in Docker image)
[global]
index-url = https://pypi.org/simple/
extra-index-url = https://private-pypi.minio.dev/simple/
trusted-host = private-pypi.minio.dev
```

Never publish internal package names to public PyPI. Reserve them even if unused.

## Hash Verification

Pin all dependencies by hash in production to prevent tampering:

```bash
# Generate hashes for requirements
pip-compile requirements.in --generate-hashes --output-file=requirements.txt

# Verify hashes at install time
pip install --require-hashes -r requirements.txt
```

Example pinned file:

```
fastapi==0.111.0 \
    --hash=sha256:abc123... \
    --hash=sha256:def456...
uvicorn==0.30.1 \
    --hash=sha256:789abc... \
    --hash=sha256:012def...
```

Two hashes per package (different build variants) prevent CI breakage from wheel rebuilds.

## Container Image Hardening

### Base Image Scanning

Pin base images by digest, not just tag:

```dockerfile
FROM python:3.11-slim@sha256:abc123... AS base
```

Subscribe to the Python Docker image security mailing list. Update the digest within 48 hours of a new release.

### Runtime Scanning

Production runs Trivy in a Kubernetes CronJob scanning running images weekly:

```yaml
# k8s/trivy-cronjob.yml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: trivy-scan
spec:
  schedule: "0 3 * * 1"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: trivy
              image: aquasec/trivy:latest
              command:
                - trivy
                - image
                - minio/worker:production
                - --severity
                - HIGH,CRITICAL
                - --format
                - json
              env:
                - name: TRIVY_USERNAME
                  valueFrom:
                    secretKeyRef:
                      name: registry-creds
                      key: username
                - name: TRIVY_PASSWORD
                  valueFrom:
                    secretKeyRef:
                      name: registry-creds
                      key: password
          restartPolicy: OnFailure
```

## Secret Detection

Dependencies can leak secrets through `.env` files, test fixtures, or debug logs.

```bash
# Scan repository for secrets
trufflehog filesystem --directory=. --json > secrets-report.json

# Check specific dependency source
trufflehog github --org=minio --repo=minio-core
```

## Scanning Schedule

| Scan | Free Tier | Scaled Production |
|------|-----------|-------------------|
| pip-audit | On every PR + weekly cron | On every PR + daily cron |
| Safety | Weekly cron | Weekly cron |
| Bandit | On every PR | On every PR |
| Snyk | N/A | On every PR + continuous monitoring |
| Trivy (image) | Manual before release | On every CI build + weekly runtime scan |
| Secret detection | On every PR | On every PR + pre-push hook |

## Severity Response SLA

| Severity | Free Tier Response | Production Response |
|----------|-------------------|---------------------|
| Critical (CVSS 9+) | Fix within 7 days | Fix within 24 hours |
| High (CVSS 7-8.9) | Fix within 14 days | Fix within 72 hours |
| Medium (CVSS 4-6.9) | Fix within 30 days | Fix within 14 days |
| Low (CVSS < 4) | Fix in next release | Fix in next release |

When a fix is not available upstream:
1. Apply a temporary patch (Snyk patch or local workaround)
2. Document the exception in `.snyk` or `SECURITY-EXCEPTIONS.md`
3. Set an expiry date; re-evaluate monthly

## Reporting Vulnerabilities

External reporters use `security@minio.dev`. The team triages within 48 hours. Critical findings trigger an emergency release. The disclosure policy follows coordinated disclosure with a 90-day window.
