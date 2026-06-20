# PR Review Loop

MiniOp uses an automated PR review loop where AI agents evaluate code changes, enforce quality gates, and provide actionable feedback before human review. This document covers the full loop from webhook trigger to merge decision.

## Overview

When a PR is opened or updated against `main`, a GitHub webhook fires and triggers the review pipeline. Three specialized agents run in parallel: **code-quality**, **test-coverage**, and **security-audit**. Their results aggregate into a single PR check with pass/fail status.

```
GitHub PR webhook
       │
       ▼
┌──────────────┐     ┌───────────────┐
│  Webhook     │────▶│  Review        │
│  Receiver    │     │  Orchestrator  │
└──────────────┘     └──────┬────────┘
                            │
               ┌────────────┼────────────┐
               ▼            ▼            ▼
        ┌──────────┐ ┌───────────┐ ┌──────────┐
        │  Code    │ │  Test     │ │ Security │
        │ Quality  │ │ Coverage  │ │  Audit   │
        └────┬─────┘ └─────┬─────┘ └────┬─────┘
             │             │            │
             └─────────────┼────────────┘
                           ▼
                    ┌──────────────┐
                    │   Aggregator  │
                    │  (post status │
                    │  + comment)   │
                    └──────────────┘
```

## Free Tier: GitHub Actions + Inline Agents

On free tier, the review loop runs entirely in GitHub Actions using a single workflow. No external server is needed — the orchestrator is a job step that calls agent scripts directly.

```yaml
# .github/workflows/pr-review.yml
name: PR Review Loop

on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write
  checks: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci

      - name: Run review agents
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: node scripts/review-orchestrator.mjs

      - name: Post review comment
        if: always()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const body = fs.readFileSync('review-output.md', 'utf8');
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: ${{ github.event.pull_request.number }},
              body
            });
```

The orchestrator script runs agents sequentially (free tier) or spawns them as child processes:

```javascript
// scripts/review-orchestrator.mjs
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile } from 'fs/promises';

const exec = promisify(execFile);

async function runAgent(name) {
  try {
    const { stdout } = await exec('node', [`agents/${name}.mjs`], {
      env: process.env,
      timeout: 120_000,
    });
    return { name, status: 'pass', output: JSON.parse(stdout) };
  } catch (err) {
    return { name, status: 'fail', output: JSON.parse(err.stdout ?? '{}') };
  }
}

const agents = ['code-quality', 'test-coverage', 'security-audit'];
const results = await Promise.all(agents.map(runAgent));

const allPass = results.every(r => r.status === 'pass');
const body = formatReviewBody(results, allPass);
await writeFile('review-output.md', body);

if (!allPass) process.exit(1);

function formatReviewBody(results, allPass) {
  let md = `## AI Review ${allPass ? '✅' : '❌'}\n\n`;
  for (const r of results) {
    const icon = r.status === 'pass' ? '✅' : '❌';
    md += `### ${icon} ${r.name}\n\n`;
    md += r.output.summary ?? 'No issues found.\n';
    if (r.output.issues?.length) {
      md += '\n| File | Line | Severity | Issue |\n|------|------|----------|-------|\n';
      for (const i of r.output.issues) {
        md += `| \`${i.file}\` | ${i.line} | ${i.severity} | ${i.message} |\n`;
      }
    }
    md += '\n';
  }
  return md;
}
```

### Code Quality Agent

The code-quality agent extracts the diff, sends it to an LLM with a structured prompt, and parses the response for actionable issues:

```javascript
// agents/code-quality.mjs
import { readFile } from 'fs/promises';

async function getDiff() {
  const { execSync } = await import('child_process');
  return execSync(`git diff ${process.env.BASE_SHA}...${process.env.HEAD_SHA}`, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

const diff = await getDiff();

const response = await fetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'gpt-4o-mini',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are a code reviewer for a Node.js video processing application (MiniOp).
Return JSON: { "summary": string, "issues": Array<{ "file": string, "line": number, "severity": "error"|"warning"|"info", "message": string }> }
Focus on: bugs, performance problems, incorrect error handling, type safety violations.
Do NOT flag style issues or suggest refactors unless they fix a bug.
If no issues found, return empty issues array.`,
      },
      { role: 'user', content: `Review this diff:\n\n${diff.slice(0, 15000)}` },
    ],
  }),
});

const data = await response.json();
const result = JSON.parse(data.choices[0].message.content);
console.log(JSON.stringify(result));
```

### Test Coverage Agent

This agent runs the test suite with coverage and flags lines that changed in the PR but aren't covered:

```javascript
// agents/test-coverage.mjs
import { execSync } from 'child_process';

const diffFiles = execSync(
  `git diff --name-only ${process.env.BASE_SHA}...${process.env.HEAD_SHA}`,
  { encoding: 'utf8' }
).trim().split('\n').filter(f => f.endsWith('.ts') && !f.includes('.test.'));

if (diffFiles.length === 0) {
  console.log(JSON.stringify({ summary: 'No source files changed.', issues: [] }));
  process.exit(0);
}

execSync('npx jest --coverage --coverageReporters=json-summary', {
  encoding: 'utf8',
  stdio: 'pipe',
});

const coverage = JSON.parse(await readFile('coverage/coverage-summary.json', 'utf8'));
const issues = [];

for (const file of diffFiles) {
  const absPath = process.cwd() + '/' + file;
  const fileCov = coverage[absPath];
  if (!fileCov) {
    issues.push({ file, line: 0, severity: 'warning', message: 'No coverage data — tests missing entirely.' });
    continue;
  }
  if (fileCov.lines.pct < 80) {
    issues.push({
      file,
      line: 0,
      severity: 'error',
      message: `Line coverage ${fileCov.lines.pct}% (threshold: 80%)`,
    });
  }
}

console.log(JSON.stringify({
  summary: issues.length === 0 ? 'All changed files meet coverage threshold.' : `${issues.length} file(s) below threshold.`,
  issues,
}));
```

## Scaled Production: External Orchestrator

In production, the review loop runs on a dedicated service (not inside GitHub Actions) to support parallel execution, queuing, and richer agent configuration.

### Webhook Receiver

```typescript
// src/review/webhook-receiver.ts
import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: '5mb' }));

function verifySignature(req: express.Request): boolean {
  const sig = req.headers['x-hub-signature-256'] as string;
  const hmac = crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET!);
  hmac.update(JSON.stringify(req.body));
  return crypto.timingSafeEqual(
    Buffer.from(sig),
    Buffer.from(`sha256=${hmac.digest('hex')}`)
  );
}

app.post('/webhook/pr', async (req, res) => {
  if (!verifySignature(req)) return res.status(401).send('Invalid signature');

  const { action, pull_request } = req.body;
  if (!['opened', 'synchronize'].includes(action)) return res.status(200).send('Ignored');

  await reviewQueue.add('review-pr', {
    prNumber: pull_request.number,
    repo: req.body.repository.full_name,
    headSha: pull_request.head.sha,
    baseSha: pull_request.base.sha,
    installationId: req.body.installation.id,
  });

  res.status(202).send('Queued');
});

app.listen(3000);
```

### BullMQ Queue with Agent Workers

```typescript
// src/review/queue.ts
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

const connection = new Redis(process.env.REDIS_URL!);

export const reviewQueue = new Queue('pr-review', { connection });

const worker = new Worker('pr-review', async (job) => {
  const { prNumber, repo, headSha, baseSha, installationId } = job.data;
  const octokit = await getInstallationClient(installationId);

  await octokit.checks.create({
    owner: repo.split('/')[0],
    repo: repo.split('/')[1],
    name: 'AI Review',
    head_sha: headSha,
    status: 'in_progress',
  });

  const [codeQuality, testCov, security] = await Promise.allSettled([
    runAgent('code-quality', { headSha, baseSha, repo }),
    runAgent('test-coverage', { headSha, baseSha, repo }),
    runAgent('security-audit', { headSha, baseSha, repo }),
  ]);

  const results = [codeQuality, testCov, security].map((r, i) => ({
    agent: ['code-quality', 'test-coverage', 'security-audit'][i],
    ...(r.status === 'fulfilled' ? r.value : { status: 'error', summary: r.reason.message }),
  }));

  const allPass = results.every(r => r.status === 'pass');

  await octokit.checks.create({
    owner: repo.split('/')[0],
    repo: repo.split('/')[1],
    name: 'AI Review',
    head_sha: headSha,
    status: 'completed',
    conclusion: allPass ? 'success' : 'failure',
    output: {
      title: allPass ? 'All checks passed' : 'Issues found',
      summary: formatSummary(results),
    },
  });

  await octokit.issues.createComment({
    owner: repo.split('/')[0],
    repo: repo.split('/')[1],
    issue_number: prNumber,
    body: formatComment(results, allPass),
  });
}, { connection, concurrency: 10 });
```

## Branch Protection Integration

Require the AI review check to pass before merging:

```json
// GitHub Branch Protection Rule (via API or UI)
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["AI Review"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1
  }
}
```

Or configure via the GitHub CLI:

```bash
gh api repos/{owner}/{repo}/branches/main/protection \
  --method PUT \
  --field '{
    "required_status_checks": {
      "strict": true,
      "contexts": ["AI Review"]
    },
    "required_pull_request_reviews": {
      "required_approving_review_count": 1
    },
    "enforce_admins": false,
    "restrictions": null
  }'
```

## Review Caching and Deduplication

To avoid re-reviewing unchanged commits, the orchestrator caches results keyed by `headSha + baseSha`:

```typescript
async function getCachedReview(headSha: string, baseSha: string): Promise<ReviewResult | null> {
  const key = `review:${baseSha}:${headSha}`;
  const cached = await redis.get(key);
  return cached ? JSON.parse(cached) : null;
}

async function cacheReview(headSha: string, baseSha: string, result: ReviewResult): Promise<void> {
  const key = `review:${baseSha}:${headSha}`;
  await redis.set(key, JSON.stringify(result), 'EX', 86400 * 7); // 7-day TTL
}
```

## Retry and Escalation

Agent failures are retried with exponential backoff. After 3 failures, the check is marked as `neutral` (not `failure`) so it doesn't block the PR — the human reviewer sees that AI review was skipped.

```typescript
const backoff = [1000, 5000, 15000]; // ms

async function runWithRetry(agentName: string, payload: unknown): Promise<AgentResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await runAgent(agentName, payload);
    } catch (err) {
      if (attempt < 2) await sleep(backoff[attempt]);
    }
  }
  return { status: 'skipped', summary: `${agentName} unavailable after 3 retries.` };
}
```

## Cost Controls

On free tier, the LLM call uses `claude-haiku-4-20250414` with a 15KB diff limit to keep costs under $0.01 per review. In production, configure per-repo budgets:

```typescript
const budget = {
  maxTokensPerReview: 50_000,
  maxReviewsPerDay: 500,
  model: 'claude-haiku-4-20250414', // upgrade to claude-sonnet for high-priority repos
};
```

## Bug Catch Rate Tracking

Anthropic's benchmarks demonstrate Claude catching 33%+ of bugs in automated code review. MiniOp tracks the PR review loop's bug catch rate against this target by correlating bugs found during AI review with bugs that escape to production or are caught by human reviewers.

### Bug Lifecycle Tracking

Every bug discovered in the system is attributed to the stage where it was found: `ai_review` (caught by the automated PR agents), `human_review` (found by a human reviewer after AI passed), or `production` (escaped all review). The catch rate is `ai_review / total_bugs`.

```typescript
// src/metrics/bug-catch-tracker.ts
interface BugRecord {
  bugId: string;
  prNumber: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  caughtBy: 'ai_review' | 'human_review' | 'production';
  agentType?: 'code-quality' | 'security-audit' | 'test-coverage';
  file: string;
  line: number;
  description: string;
  detectedAt: Date;
}

export class BugCatchTracker {
  private bugs: BugRecord[] = [];

  record(bug: BugRecord): void {
    this.bugs.push(bug);
  }

  computeCatchRate(windowDays: number = 30): {
    catchRate: number;
    totalBugs: number;
    byStage: Record<string, number>;
    bySeverity: Record<string, { caught: number; missed: number }>;
    meetsTarget: boolean;
  } {
    const cutoff = new Date(Date.now() - windowDays * 86400_000);
    const recent = this.bugs.filter(b => b.detectedAt >= cutoff);

    const byStage = { ai_review: 0, human_review: 0, production: 0 };
    for (const b of recent) byStage[b.caughtBy]++;

    const catchRate = recent.length > 0 ? byStage.ai_review / recent.length : 0;

    const bySeverity: Record<string, { caught: number; missed: number }> = {};
    for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
      const sevBugs = recent.filter(b => b.severity === severity);
      bySeverity[severity] = {
        caught: sevBugs.filter(b => b.caughtBy === 'ai_review').length,
        missed: sevBugs.filter(b => b.caughtBy !== 'ai_review').length,
      };
    }

    return {
      catchRate,
      totalBugs: recent.length,
      byStage,
      bySeverity,
      meetsTarget: catchRate >= 0.33,
    };
  }

  getAgentContributions(windowDays: number = 30): Map<string, number> {
    const cutoff = new Date(Date.now() - windowDays * 86400_000);
    const recent = this.bugs.filter(b => b.detectedAt >= cutoff && b.caughtBy === 'ai_review');
    const counts = new Map<string, number>();
    for (const b of recent) {
      const agent = b.agentType ?? 'unknown';
      counts.set(agent, (counts.get(agent) ?? 0) + 1);
    }
    return counts;
  }
}
```

### Fixing API Inconsistency

The review agents must use Anthropic's Claude API consistently — not OpenAI. The code-quality agent in `agents/code-quality.mjs` uses OpenAI's `gpt-4o-mini`; it should be replaced with Claude Sonnet for consistency with the rest of the MiniOp pipeline:

```javascript
// agents/code-quality.mjs (corrected)
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const diff = await getDiff();

const response = await client.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 2048,
  temperature: 0,
  messages: [
    {
      role: 'user',
      content: `You are a code reviewer for a Node.js video processing application (MiniOp).
Return JSON: { "summary": string, "issues": Array<{ "file": string, "line": number, "severity": "error"|"warning"|"info", "message": string }> }
Focus on: bugs, performance problems, incorrect error handling, type safety violations.
Do NOT flag style issues or suggest refactors unless they fix a bug.
If no issues found, return empty issues array.

Review this diff:\n\n${diff.slice(0, 15000)}`,
    },
  ],
});

const result = JSON.parse(response.content[0].text);
console.log(JSON.stringify(result));
```

### Bug Catch Rate Dashboard Query

```sql
-- Bug catch rate by week, with Anthropic 33% target
SELECT
    date_trunc('week', detected_at) AS week,
    COUNT(*) AS total_bugs,
    SUM(CASE WHEN caught_by = 'ai_review' THEN 1 ELSE 0 END) AS ai_caught,
    ROUND(
        SUM(CASE WHEN caught_by = 'ai_review' THEN 1 ELSE 0 END)::numeric / COUNT(*) * 100,
        1
    ) AS catch_rate_pct,
    CASE
        WHEN SUM(CASE WHEN caught_by = 'ai_review' THEN 1 ELSE 0 END)::float / COUNT(*) >= 0.33
        THEN 'ABOVE TARGET'
        ELSE 'BELOW TARGET'
    END AS status
FROM bug_catch_metrics
WHERE detected_at >= NOW() - INTERVAL '90 days'
GROUP BY date_trunc('week', detected_at)
ORDER BY week DESC;
```
