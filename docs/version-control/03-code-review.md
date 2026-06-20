# Code Review

## Overview

Code review in MiniOp ensures correctness, security, and consistency before code reaches production. This document defines the review process, automation, standards, and practical checklists for both free-tier developers (self-review or paired review) and scaled production teams with mandatory peer review.

## Pull Request Template

Create `.github/pull_request_template.md`:

```markdown
## What

<!-- 1-2 sentence summary of the change -->

## Why

<!-- Link to issue or motivation -->

Closes #

## How

<!-- Technical approach, key decisions -->

## Testing

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated (if API change)
- [ ] Manual testing performed (describe below)

## Checklist

- [ ] TypeScript compiles (`npm run typecheck`)
- [ ] Lint passes (`npm run lint`)
- [ ] Tests pass (`npm test`)
- [ ] Database migration tested (if applicable)
- [ ] No secrets or credentials in diff
- [ ] Documentation updated (if API change)
```

## GitHub Branch Protection Rules

### Free Tier (Solo Developer)

Even solo developers benefit from PR-based workflow for audit trails and automated checks.

```bash
# Protect main with status checks
gh api repos/miniop/miniop/branches/main/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["ci/lint","ci/test","ci/build"]}' \
  --field enforce_admins=false \
  --field required_pull_request_reviews='{"required_approving_review_count":0}' \
  --field restrictions=null
```

This enforces CI passes before merge but doesn't require reviewer approval (since there's only one developer). The PR still serves as a changelog entry and checkpoint.

### Scaled Production

```bash
# Require 1 approval, dismiss stale reviews on push
gh api repos/miniop/miniop/branches/develop/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["ci/lint","ci/test","ci/build","ci/security-scan"]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"required_approving_review_count":1,"dismiss_stale_reviews":true,"require_code_owner_reviews":true}' \
  --field restrictions=null

# Protect main even more strictly
gh api repos/miniop/miniop/branches/main/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["ci/lint","ci/test","ci/build","ci/security-scan"]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"required_approving_review_count":2,"dismiss_stale_reviews":true,"require_code_owner_reviews":true}' \
  --field restrictions=null
```

### CODEOWNERS

```
# .github/CODEOWNERS

# Global owners
*                       @miniop/core-team

# API and backend
/src/api/               @miniop/backend
/src/workers/           @miniop/backend
/prisma/                @miniop/backend

# Frontend
/src/components/        @miniop/frontend
/src/app/               @miniop/frontend

# Infrastructure
/docker*                @miniop/devops
/.github/               @miniop/devops
/terraform/             @miniop/devops

# AI/ML integration
/src/lib/ai/            @miniop/ml-team
/src/lib/transcription/ @miniop/ml-team
```

## Review Process

### PR Size Guidelines

Keep PRs small and focused. Large PRs get superficial reviews.

| Lines Changed | Classification | Expected Review Time |
|--------------|----------------|---------------------|
| < 100 | Small | 15 minutes |
| 100-300 | Medium | 30 minutes |
| 300-500 | Large | 1 hour |
| > 500 | Too large | Split into multiple PRs |

### Review Flow

```
Developer opens PR
    ↓
Automated checks run (lint, test, build, security)
    ↓
If checks fail → developer fixes, pushes
    ↓
Reviewer assigned (auto via CODEOWNERS)
    ↓
Reviewer leaves comments
    ↓
Developer addresses feedback
    ↓
Reviewer approves
    ↓
Squash merge to target branch
```

### Response Time Expectations

| Tier | First Response | Full Review |
|------|---------------|-------------|
| Free | N/A (self-review) | Self-review before merge |
| Scaled | < 4 hours (business hours) | < 24 hours |

## Automated Review Checks

### CI Security Scanning

```yaml
# .github/workflows/security.yml
name: Security Scan
on:
  pull_request:
    branches: [main, develop]

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm audit --audit-level=high

  secrets-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: trufflesecurity/trufflehog@main
        with:
          extra_args: --only-verified

  codeql:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript
      - uses: github/codeql-action/analyze@v3
```

### PR Size Bot

Prevent oversized PRs with a GitHub Action:

```yaml
# .github/workflows/pr-size.yml
name: PR Size Check
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  size-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Check PR size
        run: |
          ADDITIONS=$(gh pr view ${{ github.event.pull_request.number }} --json additions --jq '.additions')
          if [ "$ADDITIONS" -gt 500 ]; then
            echo "::warning::Large PR ($ADDITIONS additions). Consider splitting into smaller PRs."
          fi
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### TypeScript Strict Mode Enforcement

Ensure no `any` types leak into the codebase:

```yaml
# In CI workflow
- name: Check for 'any' types
  run: |
    count=$(grep -rn ': any' src/ --include='*.ts' --include='*.tsx' | wc -l)
    if [ "$count" -gt 0 ]; then
      echo "Found $count uses of 'any' type:"
      grep -rn ': any' src/ --include='*.ts' --include='*.tsx'
      exit 1
    fi
```

## Code Review Checklist

### For Every PR

**Correctness**
- [ ] Does the code do what the PR description says?
- [ ] Are edge cases handled (null values, empty arrays, concurrent requests)?
- [ ] Are error messages user-friendly and actionable?
- [ ] Does the code handle the failure path, not just the happy path?

**TypeScript**
- [ ] No `any` types (unless justified with a comment)
- [ ] No `@ts-ignore` or `@ts-expect-error` without explanation
- [ ] Interfaces used for external data, not assumed types
- [ ] Null checks present where data could be undefined

**Testing**
- [ ] New code has corresponding tests
- [ ] Tests cover both success and failure paths
- [ ] No hardcoded values in tests (use factories/fixtures)
- [ ] Integration tests verify database queries against real DB (not mocked)

**Security**
- [ ] No SQL injection (use parameterized queries or Prisma)
- [ ] Input validation on all API endpoints (use Zod schemas)
- [ ] No secrets in code or comments
- [ ] File uploads validated (type, size, content)
- [ ] Rate limiting on public endpoints

### MiniOp-Specific Checks

**Video Processing**
- [ ] FFmpeg commands validated for injection (no user input in shell commands)
- [ ] Temporary files cleaned up after processing
- [ ] Memory limits set for video processing workers
- [ ] Timeout guards on long-running operations

```typescript
// Good: parameterized FFmpeg execution
import { execFile } from 'child_process';
execFile('ffmpeg', ['-i', inputPath, '-c:v', 'libx264', outputPath], {
  timeout: 300_000, // 5 minute timeout
  maxBuffer: 10 * 1024 * 1024,
}, (error, stdout, stderr) => { ... });

// Bad: shell interpolation (injection risk)
exec(`ffmpeg -i ${userInput} -c:v libx264 ${outputPath}`);
```

**Transcription**
- [ ] Whisper API calls have timeout and retry logic
- [ ] Large audio files chunked before sending to API
- [ ] Transcription results validated before database insertion
- [ ] Language detection results stored for downstream use

**Database**
- [ ] Migrations are backward-compatible (expand-contract pattern)
- [ ] Indexes added for new query patterns
- [ ] N+1 queries avoided (use `include` or batch loading)
- [ ] Transactions used for multi-step mutations

```typescript
// Good: transaction wrapping multi-step operation
await prisma.$transaction(async (tx) => {
  const clip = await tx.clip.create({ data: clipData });
  await tx.transcription.create({
    data: { clipId: clip.id, status: 'pending' },
  });
  await tx.job.create({
    data: { clipId: clip.id, type: 'transcribe', status: 'queued' },
  });
  return clip;
});

// Bad: separate operations that could partially fail
const clip = await prisma.clip.create({ data: clipData });
await prisma.transcription.create({ data: { clipId: clip.id } });
// If this fails, transcription exists without a job
await prisma.job.create({ data: { clipId: clip.id, type: 'transcribe' } });
```

## Review Comment Conventions

Prefix comments with a tag so the author knows the intent:

```
[nit]     Style issue, fix if you want
[suggestion]  Alternative approach, consider it
[question]    Need clarification
[issue]   Bug or logic error, must fix
[blocking]    Cannot merge until resolved
[praise]  Something done well (use generously)
```

Example:
```
[nit] Import order: group external imports before internal ones.

[issue] This query will return all clips for all users. Add a `where: { userId }` filter.

[praise] Nice use of the transaction here — much cleaner than the previous approach.

[blocking] Missing input validation. A malicious filename like `../../etc/passwd` would escape the uploads directory.
```

## Self-Review for Free Tier

Solo developers should self-review before merging. Use this checklist as a minimum:

```bash
# Before opening a PR (even to yourself):
npm run typecheck    # TypeScript errors
npm run lint         # ESLint errors
npm test             # All tests pass
npm run build        # Production build succeeds

# Review your own diff
git diff main...HEAD --stat   # see what changed
git diff main...HEAD          # read every line

# Then merge
gh pr create --title "feat(clips): add speaker diarization" --body "..."
gh pr merge --squash --delete-branch
```

## Handling Disagreements

When reviewer and author disagree on approach:

1. **Discuss in the PR** — written record of the decision
2. **Time-box it** — if no consensus in 2 rounds of comments, escalate
3. **Escalate to tech lead** or team vote for scaled teams
4. **Document the decision** — add an ADR (Architecture Decision Record) if the choice affects multiple modules

```markdown
# adr/003-speaker-diarization-approach.md

## Status: Accepted

## Context
We need speaker diarization for multi-speaker clips. Options:
A) Pyannote.audio via Python microservice
B) WhisperX built-in diarization
C) AssemblyAI API

## Decision
Option B: WhisperX. Single dependency, no additional infrastructure,
acceptable accuracy for our use case.

## Consequences
- Ties us to WhisperX upgrade cycle
- May need to revisit if accuracy requirements increase
- Reduces operational complexity vs. option A
```

## PR Automation with GitHub CLI

Common review commands for daily workflow:

```bash
# List open PRs awaiting your review
gh pr list --reviewer @me

# Review a PR
gh pr review 42 --approve
gh pr review 42 --request-changes --body "Missing input validation on the upload endpoint"
gh pr review 42 --comment --body "Looks good overall, one question about error handling"

# Check PR status
gh pr checks 42

# Merge after approval
gh pr merge 42 --squash --delete-branch
```

## Review Metrics

Track these metrics monthly to improve review quality:

| Metric | Target | How to Measure |
|--------|--------|---------------|
| PR cycle time | < 24 hours | `gh pr list --json createdAt,mergedAt` |
| Review coverage | 100% of PRs | GitHub Insights |
| Defect escape rate | < 5% | Bugs found in production vs. during review |
| PR size (median) | < 200 lines | `gh pr list --json additions` |
| Review iterations | ≤ 2 rounds | Count comment threads per PR |

For free tier, the meaningful metric is defect escape rate — bugs that reach production. Track them in a simple markdown log:

```markdown
# defect-log.md

## 2024-03-15
- Bug: null clip duration after trimming
- Found in: production
- Caught in review: no
- Root cause: missing null check on FFmpeg output
- Prevention: add test for empty-duration clips
```
