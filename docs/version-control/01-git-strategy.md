# Git Strategy

## Overview

MiniOp uses a trunk-based development model with short-lived feature branches. This document defines branch naming, merge conventions, and the Git configuration that enforces them across free-tier solo developers and scaled production teams.

## Branch Architecture

### Core Branches

```
main                  ← production-ready code, always deployable
  ├── develop         ← integration branch for next release (scaled teams only)
  ├── feature/*       ← new functionality
  ├── fix/*           ← bug fixes
  ├── hotfix/*        ← emergency production patches
  └── release/*       ← release stabilization
```

**Free tier** collapses to two branches: `main` and short-lived `feature/*` or `fix/*` branches that merge directly into `main`. No `develop` branch is needed because a single developer or small team can integrate continuously.

**Scaled production** introduces `develop` as the integration target. All feature branches merge into `develop` via pull request. `release/*` branches fork from `develop` when a release candidate is ready.

### Branch Naming Convention

Enforce naming with a server-side GitHub rule or a local hook:

```bash
# .git/hooks/pre-push (free tier)
branch=$(git symbolic-ref --short HEAD)
if [[ ! "$branch" =~ ^(main|feature|fix|hotfix)/.+ ]]; then
  echo "Branch name '$branch' does not match convention."
  echo "Expected: feature/*, fix/*, or hotfix/*"
  exit 1
fi
```

Pattern: `<type>/<ticket-id>-<short-description>`

Examples:
```
feature/PROJ-142-add-whisper-transcription
fix/PROJ-98-null-clip-duration
hotfix/PROJ-201-fix-s3-upload-timeout
```

Without a ticketing system (free tier), omit the ticket ID:
```
feature/add-whisper-transcription
fix/null-clip-duration
```

## Commit Conventions

MiniOp follows Conventional Commits. This enables automated changelog generation and semantic version bumps.

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

Types used in MiniOp:
| Type | Purpose | Example |
|------|---------|---------|
| `feat` | New user-facing feature | `feat(clips): add speaker diarization` |
| `fix` | Bug fix | `fix(upload): handle S3 timeout on large files` |
| `perf` | Performance improvement | `perf(ffmpeg): use hardware-accelerated encoding` |
| `refactor` | Code restructuring | `refactor(api): extract clip service from controller` |
| `docs` | Documentation only | `docs(readme): add Docker deployment section` |
| `test` | Test additions/fixes | `test(transcription): add Whisper integration test` |
| `chore` | Build, CI, dependencies | `chore(deps): upgrade Next.js to 14.2` |

Scopes correspond to MiniOp modules: `clips`, `upload`, `transcription`, `ai`, `player`, `api`, `web`, `worker`, `infra`.

### Commitlint Configuration

```bash
npm install --save-dev @commitlint/cli @commitlint/config-conventional
```

```js
// commitlint.config.js
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      ['clips', 'upload', 'transcription', 'ai', 'player', 'api', 'web', 'worker', 'infra'],
    ],
    'body-max-line-length': [1, 'always', 120],
  },
};
```

```yaml
# .husky/commit-msg (runs via Husky)
npx --no -- commitlint --edit $1
```

## Merge Strategy

### Free Tier: Squash Merging

All feature branches squash-merge into `main`. This keeps the main branch history linear and readable without rebasing discipline.

```bash
# GitHub repo settings: set default merge button to "Squash and merge"
git checkout main
git merge --squash feature/add-whisper-transcription
git commit -m "feat(transcription): add Whisper integration (#42)"
```

Configure the repository default on GitHub:
```bash
gh repo edit miniop/miniop --allow-squash-merge --allow-merge-commit false --allow-rebase-merge false
```

### Scaled Production: Merge Commits with Linear History

For teams, use merge commits (not squash) to preserve branch context. Require branches to be rebased onto `develop` before merging:

```bash
git checkout feature/add-whisper-transcription
git rebase develop
# resolve conflicts if any
git push --force-with-lease
```

GitHub branch protection for `develop`:
```bash
gh api repos/miniop/miniop/branches/develop/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["ci/build","ci/test","ci/lint"]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"required_approving_review_count":1,"dismiss_stale_reviews":true}' \
  --field restrictions=null
```

## Git Hooks

### Pre-commit (Husky + lint-staged)

```json
// package.json
{
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
    "*.md": ["prettier --write"],
    "*.json": ["prettier --write"]
  }
}
```

```bash
# .husky/pre-commit
npx lint-staged
```

### Pre-push

```bash
# .husky/pre-push
npm run typecheck
```

This catches TypeScript errors before they reach CI. On free tier, developers run this locally. In scaled production, CI enforces it regardless.

## .gitignore for MiniOp

```gitignore
# Dependencies
node_modules/
.pnp.*

# Build output
.next/
dist/
build/

# Environment
.env
.env.local
.env.*.local

# Uploads (local dev)
uploads/
clips/

# Database
*.sqlite
*.db

# Docker volumes
docker-data/

# IDE
.vscode/settings.json
.idea/

# OS
.DS_Store
Thumbs.db

# Test coverage
coverage/

# Turborepo
.turbo
```

## Working with Large Files

MiniOp processes video files that should never enter the Git history. The `uploads/` and `clips/` directories are `.gitignore`d. For ML model files (Whisper, speaker diarization models), use Git LFS:

```bash
git lfs install
git lfs track "*.bin" "*.onnx" "*.pt"
```

This generates a `.gitattributes` entry:
```
*.bin filter=lfs diff=lfs merge=lfs -text
*.onnx filter=lfs diff=lfs merge=lfs -text
*.pt filter=lfs diff=lfs merge=lfs -text
```

**Free tier**: skip LFS entirely. Store model paths as environment variables and download models at build time.

**Scaled production**: use LFS or a model registry (Hugging Face Hub, S3 bucket) and reference by hash.

## Tagging

Tags follow semver and are created on `main` only:

```bash
git tag -a v1.2.0 -m "Release 1.2.0: speaker diarization, improved transcription"
git push origin v1.2.0
```

Annotated tags are required so `git describe` works correctly for CI version stamps.

```bash
# .github/workflows/ci.yml (excerpt)
- name: Get version
  id: version
  run: echo "VERSION=$(git describe --tags --always)" >> $GITHUB_OUTPUT
```

## Practical Workflow

### Free Tier (Solo Developer)

```bash
git checkout main && git pull
git checkout -b feature/add-speaker-diarization
# ... make changes ...
git add -A && git commit -m "feat(transcription): add speaker diarization support"
git checkout main && git merge --squash feature/add-speaker-diarization
git commit -m "feat(transcription): add speaker diarization support"
git branch -d feature/add-speaker-diarization
git push origin main
```

### Scaled Production (Team)

```bash
git checkout develop && git pull
git checkout -b feature/PROJ-142-add-speaker-diarization
# ... make changes, push ...
git push -u origin feature/PROJ-142-add-speaker-diarization
# Open PR on GitHub → CI runs → review → merge to develop
# Release: develop → release/1.2.0 → main (see release-management.md)
```
