# Release Management

## Overview

MiniOp follows semantic versioning (semver) with automated releases driven by Conventional Commits. This document covers the release lifecycle from version bumping through deployment, with separate workflows for free-tier developers and scaled production teams.

## Versioning Scheme

```
MAJOR.MINOR.PATCH

MAJOR: breaking API changes, incompatible database migrations
MINOR: new features (speaker diarization, new export format), backward-compatible
PATCH: bug fixes, security patches, performance improvements
```

Pre-release identifiers for canary/beta channels:
```
1.3.0-alpha.1    ← early internal testing
1.3.0-beta.1     ← public beta, feature-complete
1.3.0-rc.1       ← release candidate, only critical fixes
1.3.0            ← stable release
```

## Automated Version Bumping

### Standard Version (Free Tier)

Use `standard-version` to automate version bumps, changelog generation, and tagging based on commit history.

```bash
npm install --save-dev standard-version
```

```json
// package.json
{
  "scripts": {
    "release": "standard-version",
    "release:minor": "standard-version --release-as minor",
    "release:major": "standard-version --release-as major",
    "release:prerelease": "standard-version --prerelease beta"
  }
}
```

```js
// .versionrc
module.exports = {
  types: [
    { type: 'feat', section: 'Features' },
    { type: 'fix', section: 'Bug Fixes' },
    { type: 'perf', section: 'Performance' },
    { type: 'revert', section: 'Reverts' },
    { type: 'docs', hidden: true },
    { type: 'chore', hidden: true },
    { type: 'test', hidden: true },
    { type: 'refactor', hidden: true },
  ],
  commitUrlFormat: 'https://github.com/miniop/miniop/commit/{{hash}}',
  compareUrlFormat: 'https://github.com/miniop/miniop/compare/{{previousTag}}...{{currentTag}}',
  issueUrlFormat: 'https://github.com/miniop/miniop/issues/{{id}}',
};
```

Run the release:
```bash
git checkout main && git pull
npm run release          # auto-detects bump from commits
npm run release -- --dry-run  # preview without changes
git push --follow-tags origin main
```

This produces:
1. Version bump in `package.json`
2. Updated `CHANGELOG.md`
3. Annotated git tag `v1.2.0`

### Release Please (Scaled Production)

Google's `release-please` automates version management through PRs instead of direct commits. This gives teams a review checkpoint before releasing.

```yaml
# .github/workflows/release-please.yml
name: Release Please
on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        id: release
        with:
          release-type: node
          changelog-types: '[{"type":"feat","section":"Features","hidden":false},{"type":"fix","section":"Bug Fixes","hidden":false},{"type":"perf","section":"Performance","hidden":false}]'

      - uses: actions/checkout@v4
        if: ${{ steps.release.outputs.release_created }}

      - uses: actions/setup-node@v4
        if: ${{ steps.release.outputs.release_created }}
        with:
          node-version: 20
          registry-url: 'https://registry.npmjs.org'

      - run: npm ci
        if: ${{ steps.release.outputs.release_created }}

      - run: npm run build
        if: ${{ steps.release.outputs.release_created }}

      - run: npm publish
        if: ${{ steps.release.outputs.release_created }}
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Release-please creates a PR titled `chore: release v1.2.0` with the changelog diff. When merged, it creates the tag and triggers the publish workflow.

## Release Branches

### Scaled Production Release Flow

```
develop ──→ release/1.2.0 ──→ main
                ↓
            hotfix if needed
                ↓
            cherry-pick to develop
```

```bash
# Create release branch
git checkout develop
git checkout -b release/1.2.0

# Bump version
npm version 1.2.0 --no-git-tag-version
git commit -am "chore: bump version to 1.2.0"

# Stabilization: only fix commits allowed on this branch
# Cherry-pick fixes from develop if needed
git cherry-pick <fix-commit-hash>

# Merge to main
git checkout main
git merge --no-ff release/1.2.0
git tag -a v1.2.0 -m "Release 1.2.0"
git push origin main --tags

# Back-merge to develop
git checkout develop
git merge --no-ff release/1.2.0
git push origin develop

# Clean up
git branch -d release/1.2.0
git push origin --delete release/1.2.0
```

### Hotfix Flow

```bash
git checkout main
git checkout -b hotfix/1.2.1

# Fix the issue
git commit -m "fix(upload): patch S3 multipart upload race condition"

# Bump patch version
npm version patch --no-git-tag-version
git commit -am "chore: bump version to 1.2.1"

# Merge to main
git checkout main
git merge --no-ff hotfix/1.2.1
git tag -a v1.2.1 -m "Hotfix 1.2.1: S3 upload race condition"
git push origin main --tags

# Back-merge to develop
git checkout develop
git merge --no-ff hotfix/1.2.1
git push origin develop
```

## CI/CD Pipeline

### Build and Test Pipeline

```yaml
# .github/workflows/ci.yml
name: CI
on:
  pull_request:
    branches: [main, develop]
  push:
    branches: [main, develop]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck

  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: miniop
          POSTGRES_PASSWORD: test
          POSTGRES_DB: miniop_test
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
      redis:
        image: redis:7
        ports: ['6379:6379']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm test -- --coverage
        env:
          DATABASE_URL: postgres://miniop:test@localhost:5432/miniop_test
          REDIS_URL: redis://localhost:6379

  build:
    runs-on: ubuntu-latest
    needs: [lint, test]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: build
          path: .next/
```

### Release and Deploy Pipeline

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    tags: ['v*']

jobs:
  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Login to Docker Hub
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}

      - name: Extract version
        id: version
        run: echo "VERSION=${GITHUB_REF#refs/tags/v}" >> $GITHUB_OUTPUT

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: |
            miniop/miniop:${{ steps.version.outputs.VERSION }}
            miniop/miniop:latest

  deploy-staging:
    needs: docker
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - name: Deploy to staging
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.STAGING_HOST }}
          username: ${{ secrets.STAGING_USER }}
          key: ${{ secrets.STAGING_SSH_KEY }}
          script: |
            cd /opt/miniop
            docker compose pull
            docker compose up -d --remove-orphans
            docker compose exec -T api npx prisma migrate deploy

  deploy-production:
    needs: deploy-staging
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Deploy to production
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.PRODUCTION_HOST }}
          username: ${{ secrets.PRODUCTION_USER }}
          key: ${{ secrets.PRODUCTION_SSH_KEY }}
          script: |
            cd /opt/miniop
            docker compose pull
            docker compose up -d --remove-orphans
            docker compose exec -T api npx prisma migrate deploy
```

## Database Migrations

Migrations run automatically during deployment using Prisma. For breaking schema changes, use expand-contract pattern:

```prisma
// Phase 1: Expand (add new column, keep old)
model Clip {
  id          String   @id @default(cuid())
  title       String?
  titleV2     String?  // new column, nullable
}

// Phase 2: Migrate data (backfill script)
// scripts/migrate-clip-titles.ts
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const clips = await prisma.clip.findMany({ where: { titleV2: null } });
  for (const clip of clips) {
    await prisma.clip.update({
      where: { id: clip.id },
      data: { titleV2: clip.title ?? 'Untitled Clip' },
    });
  }
}
main();

// Phase 3: Contract (remove old column after all services updated)
model Clip {
  id          String   @id @default(cuid())
  titleV2     String   @default("Untitled Clip")
}
```

## Changelog Generation

The `CHANGELOG.md` is auto-generated from commits. For manual additions (breaking changes, migration notes), edit the release-please PR body or use `.versionrc`'s `header` option:

```js
// .versionrc
module.exports = {
  header: `# Changelog\n\nAll notable changes to MiniOp will be documented in this file.\n\nSee [Releases](https://github.com/miniop/miniop/releases) for binary downloads.\n`,
  // ...
};
```

## Rollback Procedure

```bash
# Tag-based rollback on production server
ssh deploy@production

# List recent tags
git tag --sort=-creatordate | head -5

# Roll back to previous version
cd /opt/miniop
git checkout v1.1.0
docker compose build
docker compose up -d

# If database migration was involved, restore from backup
pg_restore -d miniop /backups/miniop-$(date -d '1 day ago' +%Y%m%d).dump
docker compose exec -T api npx prisma migrate deploy
```

For zero-downtime rollback on scaled infrastructure, maintain two Docker image tags (`current` and `previous`) and switch the load balancer target:

```yaml
# docker-compose.prod.yml
services:
  api-current:
    image: miniop/miniop:1.2.0
  api-previous:
    image: miniop/miniop:1.1.0
    profiles: ["rollback"]
```

## Free Tier Release Checklist

For solo developers who want a lightweight but disciplined release:

```bash
# 1. Ensure main is clean
git checkout main && git pull
npm ci && npm test && npm run build

# 2. Generate release
npm run release -- --dry-run  # review changelog
npm run release               # create commit + tag

# 3. Push
git push --follow-tags origin main

# 4. GitHub creates the release from the tag automatically
#    if "Auto-generate release notes" is enabled in repo settings
```

Enable auto-generated releases:
```bash
gh repo edit miniop/miniop --enable-auto-merge
```

## Release Cadence

| Tier | Patch | Minor | Major |
|------|-------|-------|-------|
| Free | As needed | Monthly | Quarterly |
| Scaled | Weekly | Bi-weekly | Quarterly |

Patches ship immediately when they fix regressions or security issues. Minors batch features. Majors require a migration guide published 2 weeks before release.
