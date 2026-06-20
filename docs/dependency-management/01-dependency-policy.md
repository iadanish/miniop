# MiniOp Dependency Management Policy

## Overview

MiniOp is a video processing platform that relies on a complex dependency tree spanning video encoding libraries, machine learning inference runtimes, cloud storage SDKs, and web framework components. This policy defines how dependencies are evaluated, approved, tracked, and retired across both the free-tier single-node deployment and scaled production environments running on Kubernetes.

## Dependency Categories

### Tier 1 — Core Runtime Dependencies

These packages are load-bearing. If they fail, MiniOp cannot process video.

| Category | Free Tier | Scaled Production |
|----------|-----------|-------------------|
| Video Processing | `ffmpeg-python`, `moviepy` | `ffmpeg-python`, `moviepy`, `boto3` (S3 multipart) |
| ML Inference | `onnxruntime` | `onnxruntime-gpu`, `torch` (CUDA builds) |
| API Framework | `fastapi`, `uvicorn` | `fastapi`, `uvicorn`, `gunicorn` |
| Database | `sqlite3` (stdlib) | `asyncpg`, `sqlalchemy[asyncio]` |
| Queue | `celery`, `redis` | `celery`, `redis`, `kombu` |

### Tier 2 — Integration Dependencies

Cloud SDKs, third-party APIs, and telemetry libraries. Failure degrades features but does not halt core video clipping.

- `boto3` / `google-cloud-storage` — asset upload
- `stripe` — billing (production only)
- `sentry-sdk` — error tracking
- `prometheus-client` — metrics export

### Tier 3 — Development Dependencies

Testing, linting, formatting, and build tools. Never shipped in production images.

- `pytest`, `pytest-asyncio`, `pytest-cov`
- `ruff`, `mypy`, `black`
- `pre-commit`
- `build`, `twine`

## Version Pinning Strategy

### Free Tier (Single Developer / Self-Hosted)

Use exact pins in `requirements.txt` for reproducibility:

```
fastapi==0.111.0
uvicorn==0.30.1
ffmpeg-python==0.2.0
onnxruntime==1.18.0
celery==5.4.0
redis==5.0.7
sqlalchemy==2.0.31
```

Update pins manually after testing. Run `pip-compile` from `pip-tools` to resolve transitive dependencies:

```bash
pip-compile requirements.in --output-file=requirements.txt --strip-extras
```

### Scaled Production

Use `poetry` with locked versions in `poetry.lock`. The lock file is committed to the repository and is the single source of truth for production builds.

```toml
# pyproject.toml
[tool.poetry.dependencies]
python = "^3.11"
fastapi = "^0.111"
uvicorn = {version = "^0.30", extras = ["standard"]}
ffmpeg-python = "^0.2"
onnxruntime-gpu = "^1.18"
celery = {version = "^5.4", extras = ["redis"]}
sqlalchemy = {version = "^2.0", extras = ["asyncio"]}
asyncpg = "^0.29"
boto3 = "^1.34"
sentry-sdk = {version = "^2.5", extras = ["fastapi"]}
prometheus-client = "^0.20"
```

Build production images from the lock file directly:

```dockerfile
# Dockerfile.production
FROM python:3.11-slim AS base
RUN pip install poetry==1.8.3
COPY pyproject.toml poetry.lock ./
RUN poetry config virtualenvs.create false && \
    poetry install --only main --no-interaction --no-ansi
COPY src/ ./src/
```

## Dependency Approval Process

### Adding a New Dependency

1. **Check necessity.** Can the functionality be implemented in fewer than 50 lines without a library? If yes, write it inline.

2. **Evaluate the package.** Check these criteria before adding:

```bash
# Check latest release date (must be within 12 months)
pip index versions <package> 2>/dev/null || pip install <package> --dry-run

# Check known vulnerabilities
pip-audit --require-hashes -r requirements.txt

# Check download stats and maintainer activity
# Visit: https://pypi.org/project/<package>/
# Minimum thresholds: 10K weekly downloads, release within 6 months
```

3. **Open a PR** adding the dependency to `requirements.in` (free tier) or `pyproject.toml` (production). The PR description must include:
   - Why the dependency is needed
   - License (must be MIT, BSD, Apache-2.0, or ISC)
   - Number of transitive dependencies it introduces (`pip show <package>` / `poetry show --tree <package>`)
   - Any known CVEs and their remediation status

4. **CI validates** the addition. The pipeline runs:
   ```bash
   pip-audit
   safety check
   licensecheck --fail-on "GPL-3.0,AGPL-3.0,SSPL-1.0"
   ```

### Removing a Dependency

Dependencies are removed when:
- The package is abandoned (no release in 18+ months)
- A CVE remains unpatched for 30+ days with no workaround
- The feature using it is deprecated
- A lighter alternative replaces it

Removal process:
```bash
# Identify what imports the package
grep -rn "import <package>" src/ tests/

# Remove from requirements
poetry remove <package>  # production
pip-compile requirements.in  # free tier

# Run full test suite
pytest tests/ -x --timeout=120
```

## License Compliance

MiniOp is licensed under MIT. All runtime dependencies must use compatible licenses.

**Allowed:** MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, ISC, PSF, Unlicense
**Forbidden:** GPL-3.0, AGPL-3.0, SSPL-1.0, EUPL, any license requiring source disclosure

Automated check in CI:

```yaml
# .github/workflows/licenses.yml
- name: Check licenses
  run: |
    pip install pip-licenses
    pip-licenses --fail-on "GPL-3.0,AGPL-3.0,SSPL-1.0" \
                 --allow-only "MIT;BSD-2-Clause;BSD-3-Clause;Apache-2.0;ISC;PSF;Unlicense" \
                 --format=markdown >> $GITHUB_STEP_SUMMARY
```

## Dependency Inventory

Maintain a `DEPENDENCIES.md` at the repository root. Auto-generate it:

```bash
pip-licenses --format=markdown --with-urls --with-description > DEPENDENCIES.md
```

This file is rebuilt on every release tag and committed. It serves as the bill of materials for compliance audits.

## Free Tier vs Production Matrix

| Concern | Free Tier | Scaled Production |
|---------|-----------|-------------------|
| Package manager | pip + pip-tools | poetry |
| Lock file | requirements.txt (exact pins) | poetry.lock (committed) |
| Vulnerability scan | pip-audit (manual) | pip-audit + Snyk (CI) |
| License check | manual | automated in CI |
| Update cadence | monthly | bi-weekly sprint review |
| GPU packages | `onnxruntime` (CPU) | `onnxruntime-gpu` (CUDA 12.x) |
| Whisper model | `whisper-base` or `whisper-small` | `whisper-large-v3` |
| Database driver | sqlite3 (stdlib) | asyncpg |
| Image base | `python:3.11` | `python:3.11-slim` + non-root |

## Enforcement

This policy is enforced through:

1. **Branch protection rules** — PRs modifying dependency files require review from a maintainer.
2. **CI gates** — `pip-audit`, `licensecheck`, and lock-file integrity checks must pass.
3. **Dependabot / Renovate** — configured for automated PRs (see Update Strategy document).
4. **Quarterly audit** — manual review of the full dependency tree for abandoned or risky packages.

Violations block the release pipeline. Exceptions require written approval in the PR with a documented sunset date.
