# Smoke Testing

## Overview

Smoke testing validates that MiniOp's critical paths function correctly after deployment. These tests run against staging (and production) to catch regressions before they reach users. Covers free-tier (manual + lightweight automation) and scaled production (full CI/CD integration with monitoring).

---

## Smoke Test Strategy

### Test Categories

| Category | Priority | Frequency | Timeout |
|----------|----------|-----------|---------|
| Health checks | Critical | Every deploy | 30s |
| Authentication | Critical | Every deploy | 60s |
| Video upload | Critical | Every deploy | 120s |
| Video processing | High | Every deploy | 300s |
| Clip export | High | Every deploy | 180s |
| AI features | Medium | Daily | 600s |
| Payment flow | Critical | Every deploy | 120s |

### Environment Matrix

```typescript
// tests/smoke/config.ts
export const smokeConfig = {
  staging: {
    baseUrl: 'https://staging.minioop.example.com',
    testUser: {
      email: 'smoke-test@minioop.example.com',
      password: process.env.SMOKE_TEST_PASSWORD!,
    },
    timeout: 300000,
    retries: 2,
  },
  production: {
    baseUrl: 'https://minioop.example.com',
    testUser: {
      email: 'smoke-prod@minioop.example.com',
      password: process.env.SMOKE_PROD_PASSWORD!,
    },
    timeout: 180000,
    retries: 1,
  },
  preview: {
    baseUrl: process.env.PREVIEW_URL!,
    testUser: {
      email: 'smoke-test@minioop.example.com',
      password: process.env.SMOKE_TEST_PASSWORD!,
    },
    timeout: 300000,
    retries: 3,
  },
};

export type Environment = keyof typeof smokeConfig;
```

---

## Free Tier Smoke Tests

### Manual Smoke Test Checklist

Run after every Vercel preview deployment:

```markdown
## Pre-Deployment Checklist

### Authentication
- [ ] Login with email/password works
- [ ] OAuth (Google) works
- [ ] Logout works
- [ ] Password reset email sends

### Video Upload
- [ ] Drag-and-drop upload works
- [ ] File picker upload works
- [ ] Progress bar displays correctly
- [ ] Upload completes for MP4 files
- [ ] Upload completes for WebM files
- [ ] File size limit error displays for oversized files

### Video Processing
- [ ] Processing status updates in real-time
- [ ] Transcription completes
- [ ] Highlight detection returns results
- [ ] Thumbnail generation works

### Clip Creation
- [ ] Manual clip creation works
- [ ] AI-suggested clips display
- [ ] Clip preview plays correctly
- [ ] Timeline scrubbing works

### Export
- [ ] MP4 export downloads
- [ ] WebM export downloads
- [ ] Export quality options work

### UI/UX
- [ ] No console errors
- [ ] Responsive on mobile
- [ ] Dark mode renders correctly
- [ ] Loading states display
```

### Automated Smoke Tests (Playwright)

```typescript
// tests/smoke/basic.spec.ts
import { test, expect } from '@playwright/test';

const BASE_URL = process.env.STAGING_URL || 'http://localhost:3000';

test.describe('MiniOp Smoke Tests', () => {
  test('health endpoint returns 200', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/health`);
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.status).toBe('healthy');
    expect(body.environment).toBeDefined();
  });

  test('login page loads', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await expect(page.locator('h1')).toContainText('Sign in');
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('authenticated user sees dashboard', async ({ page }) => {
    // Login
    await page.goto(`${BASE_URL}/login`);
    await page.fill('input[type="email"]', process.env.SMOKE_TEST_EMAIL!);
    await page.fill('input[type="password"]', process.env.SMOKE_TEST_PASSWORD!);
    await page.click('button[type="submit"]');

    // Wait for redirect to dashboard
    await page.waitForURL(`${BASE_URL}/dashboard`);
    await expect(page.locator('h1')).toContainText('Dashboard');
    await expect(page.locator('[data-testid="upload-button"]')).toBeVisible();
  });

  test('upload endpoint accepts video', async ({ request }) => {
    // Get auth token
    const authResponse = await request.post(`${BASE_URL}/api/auth/login`, {
      data: {
        email: process.env.SMOKE_TEST_EMAIL,
        password: process.env.SMOKE_TEST_PASSWORD,
      },
    });
    const { token } = await authResponse.json();

    // Upload test video
    const file = await request.storageState();
    const response = await request.post(`${BASE_URL}/api/videos/upload`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      multipart: {
        file: 'tests/fixtures/test-10s.mp4',
      },
    });

    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.videoId).toBeDefined();
  });
});
```

Run smoke tests:

```bash
# Install Playwright
npm init playwright@latest

# Run against staging
STAGING_URL=https://staging.minioop.example.com npx playwright test tests/smoke/

# Run with specific browser
npx playwright test tests/smoke/ --project=chromium

# Run with UI
npx playwright test tests/smoke/ --ui
```

---

## Scaled Production Smoke Tests

### Test Infrastructure

```typescript
// tests/smoke/infrastructure.ts
import { chromium, Browser, Page } from '@playwright/test';

export class SmokeTestRunner {
  private browser: Browser | null = null;
  private results: TestResult[] = [];

  constructor(private baseUrl: string, private auth: AuthConfig) {}

  async setup() {
    this.browser = await chromium.launch({ headless: true });
  }

  async teardown() {
    await this.browser?.close();
  }

  async runAll(): Promise<TestSuite> {
    await this.setup();

    const tests = [
      this.testHealthCheck.bind(this),
      this.testAuthentication.bind(this),
      this.testVideoUpload.bind(this),
      this.testVideoProcessing.bind(this),
      this.testClipExport.bind(this),
      this.testPaymentFlow.bind(this),
    ];

    for (const test of tests) {
      try {
        const result = await test();
        this.results.push(result);
      } catch (error) {
        this.results.push({
          name: test.name,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
          duration: 0,
        });
      }
    }

    await this.teardown();

    return {
      timestamp: new Date().toISOString(),
      environment: this.baseUrl,
      results: this.results,
      passed: this.results.every(r => r.status === 'passed'),
    };
  }

  private async testHealthCheck(): Promise<TestResult> {
    const start = Date.now();
    const response = await fetch(`${this.baseUrl}/api/health`);
    const body = await response.json();

    if (!response.ok) throw new Error(`Health check failed: ${response.status}`);
    if (body.status !== 'healthy') throw new Error(`Unhealthy: ${body.status}`);

    return {
      name: 'health-check',
      status: 'passed',
      duration: Date.now() - start,
    };
  }

  private async testAuthentication(): Promise<TestResult> {
    const start = Date.now();

    // Test login
    const loginResponse = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.auth),
    });

    if (!loginResponse.ok) throw new Error('Login failed');

    const { token } = await loginResponse.json();

    // Test authenticated request
    const meResponse = await fetch(`${this.baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!meResponse.ok) throw new Error('Auth check failed');

    return {
      name: 'authentication',
      status: 'passed',
      duration: Date.now() - start,
      metadata: { tokenLength: token.length },
    };
  }

  private async testVideoUpload(): Promise<TestResult> {
    const start = Date.now();

    // Get auth token
    const loginResponse = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.auth),
    });
    const { token } = await loginResponse.json();

    // Upload test video
    const formData = new FormData();
    const videoBlob = new Blob(['test-video-data'], { type: 'video/mp4' });
    formData.append('file', videoBlob, 'test.mp4');

    const uploadResponse = await fetch(`${this.baseUrl}/api/videos/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    if (!uploadResponse.ok) throw new Error('Upload failed');

    const { videoId } = await uploadResponse.json();

    return {
      name: 'video-upload',
      status: 'passed',
      duration: Date.now() - start,
      metadata: { videoId },
    };
  }

  private async testVideoProcessing(): Promise<TestResult> {
    const start = Date.now();

    // Get auth token
    const loginResponse = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.auth),
    });
    const { token } = await loginResponse.json();

    // Upload test video
    const formData = new FormData();
    const videoBlob = new Blob(['test-video-data'], { type: 'video/mp4' });
    formData.append('file', videoBlob, 'test.mp4');

    const uploadResponse = await fetch(`${this.baseUrl}/api/videos/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const { videoId } = await uploadResponse.json();

    // Trigger processing
    const processResponse = await fetch(`${this.baseUrl}/api/videos/process`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ videoId }),
    });

    if (!processResponse.ok) throw new Error('Processing trigger failed');

    // Poll for completion (max 5 minutes)
    let status = 'processing';
    let attempts = 0;
    const maxAttempts = 60;

    while (status === 'processing' && attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 5000));
      attempts++;

      const statusResponse = await fetch(
        `${this.baseUrl}/api/videos/${videoId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const video = await statusResponse.json();
      status = video.status;
    }

    if (status !== 'completed') throw new Error(`Processing failed: ${status}`);

    return {
      name: 'video-processing',
      status: 'passed',
      duration: Date.now() - start,
      metadata: { videoId, attempts },
    };
  }

  private async testClipExport(): Promise<TestResult> {
    const start = Date.now();

    // Get auth token
    const loginResponse = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.auth),
    });
    const { token } = await loginResponse.json();

    // Get existing clip (or create one)
    const clipsResponse = await fetch(`${this.baseUrl}/api/clips?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { clips } = await clipsResponse.json();

    if (!clips || clips.length === 0) {
      return {
        name: 'clip-export',
        status: 'skipped',
        reason: 'No clips available for testing',
        duration: Date.now() - start,
      };
    }

    // Export clip
    const exportResponse = await fetch(`${this.baseUrl}/api/clips/export`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clipId: clips[0].id,
        format: 'mp4',
        quality: 'medium',
      }),
    });

    if (!exportResponse.ok) throw new Error('Export failed');

    const { downloadUrl } = await exportResponse.json();

    // Verify download URL works
    const downloadResponse = await fetch(downloadUrl, { method: 'HEAD' });
    if (!downloadResponse.ok) throw new Error('Download URL invalid');

    return {
      name: 'clip-export',
      status: 'passed',
      duration: Date.now() - start,
      metadata: { clipId: clips[0].id, downloadUrl },
    };
  }

  private async testPaymentFlow(): Promise<TestResult> {
    const start = Date.now();

    // Get auth token
    const loginResponse = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.auth),
    });
    const { token } = await loginResponse.json();

    // Get pricing page
    const pricingResponse = await fetch(`${this.baseUrl}/api/pricing`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!pricingResponse.ok) throw new Error('Pricing endpoint failed');

    const { plans } = await pricingResponse.json();

    if (!plans || plans.length === 0) throw new Error('No pricing plans');

    // Test checkout session creation (doesn't charge)
    const checkoutResponse = await fetch(`${this.baseUrl}/api/checkout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ planId: plans[0].id }),
    });

    if (!checkoutResponse.ok) throw new Error('Checkout session creation failed');

    const { sessionId } = await checkoutResponse.json();

    return {
      name: 'payment-flow',
      status: 'passed',
      duration: Date.now() - start,
      metadata: { sessionId, plansAvailable: plans.length },
    };
  }
}

interface AuthConfig {
  email: string;
  password: string;
}

interface TestResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  duration: number;
  error?: string;
  reason?: string;
  metadata?: Record<string, any>;
}

interface TestSuite {
  timestamp: string;
  environment: string;
  results: TestResult[];
  passed: boolean;
}
```

### Running Smoke Tests

```bash
# Run against staging
SMOKE_TEST_EMAIL=test@minioop.example.com \
SMOKE_TEST_PASSWORD=testpassword123 \
npx ts-node tests/smoke/runner.ts --env=staging

# Run against production
SMOKE_PROD_EMAIL=prod@minioop.example.com \
SMOKE_PROD_PASSWORD=prodpassword123 \
npx ts-node tests/smoke/runner.ts --env=production

# Run against preview URL
PREVIEW_URL=https://minioop-git-feat-abc-team.vercel.app \
SMOKE_TEST_EMAIL=test@minioop.example.com \
SMOKE_TEST_PASSWORD=testpassword123 \
npx ts-node tests/smoke/runner.ts --env=preview
```

---

## CI/CD Integration

### GitHub Actions Smoke Tests

```yaml
# .github/workflows/smoke-tests.yml
name: Smoke Tests

on:
  deployment_status:
    environment: [staging, production]

jobs:
  smoke-test:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci

      - name: Determine environment URL
        id: env-url
        run: |
          if [ "${{ github.event.deployment_status.environment }}" == "production" ]; then
            echo "url=https://minioop.example.com" >> $GITHUB_OUTPUT
          else
            echo "url=${{ github.event.deployment_status.target_url }}" >> $GITHUB_OUTPUT
          fi

      - name: Run smoke tests
        run: npx playwright test tests/smoke/
        env:
          STAGING_URL: ${{ steps.env-url.outputs.url }}
          SMOKE_TEST_EMAIL: ${{ secrets.SMOKE_TEST_EMAIL }}
          SMOKE_TEST_PASSWORD: ${{ secrets.SMOKE_TEST_PASSWORD }}
          SMOKE_PROD_EMAIL: ${{ secrets.SMOKE_PROD_EMAIL }}
          SMOKE_PROD_PASSWORD: ${{ secrets.SMOKE_PROD_PASSWORD }}

      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: smoke-test-results
          path: test-results/

      - name: Notify on failure
        if: failure()
        uses: slackapi/slack-github-action@v1
        with:
          payload: |
            {
              "text": ":x: Smoke tests failed on ${{ github.event.deployment_status.environment }}",
              "blocks": [
                {
                  "type": "section",
                  "text": {
                    "type": "mrkdwn",
                    "text": "*Smoke Test Failure* :x:\n*Environment:* ${{ github.event.deployment_status.environment }}\n*URL:* ${{ steps.env-url.outputs.url }}\n*Run:* ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
                  }
                }
              ]
            }
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

### Vercel Integration

```json
// vercel.json
{
  "buildCommand": "npm run build",
  "framework": "nextjs",
  "scripts": {
    "postDeploy": "npm run test:smoke"
  }
}
```

```json
// package.json
{
  "scripts": {
    "test:smoke": "playwright test tests/smoke/",
    "test:smoke:staging": "STAGING_URL=https://staging.minioop.example.com playwright test tests/smoke/",
    "test:smoke:production": "STAGING_URL=https://minioop.example.com playwright test tests/smoke/"
  }
}
```

---

## Performance Smoke Tests

Validate response times meet SLA:

```typescript
// tests/smoke/performance.spec.ts
import { test, expect } from '@playwright/test';

const BASE_URL = process.env.STAGING_URL || 'http://localhost:3000';
const SLA = {
  healthCheck: 500,      // 500ms
  pageLoad: 2000,        // 2s
  apiResponse: 1000,     // 1s
  uploadInit: 3000,      // 3s
};

test.describe('Performance Smoke Tests', () => {
  test('health check responds within SLA', async ({ request }) => {
    const start = Date.now();
    await request.get(`${BASE_URL}/api/health`);
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(SLA.healthCheck);
  });

  test('homepage loads within SLA', async ({ page }) => {
    const start = Date.now();
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(SLA.pageLoad);
  });

  test('dashboard loads within SLA', async ({ page }) => {
    // Login first
    await page.goto(`${BASE_URL}/login`);
    await page.fill('input[type="email"]', process.env.SMOKE_TEST_EMAIL!);
    await page.fill('input[type="password"]', process.env.SMOKE_TEST_PASSWORD!);
    await page.click('button[type="submit"]');

    const start = Date.now();
    await page.waitForURL(`${BASE_URL}/dashboard`);
    await page.waitForLoadState('networkidle');
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(SLA.pageLoad);
  });

  test('API responses within SLA', async ({ request }) => {
    // Login
    const authResponse = await request.post(`${BASE_URL}/api/auth/login`, {
      data: {
        email: process.env.SMOKE_TEST_EMAIL,
        password: process.env.SMOKE_TEST_PASSWORD,
      },
    });
    const { token } = await authResponse.json();

    const endpoints = [
      '/api/videos',
      '/api/clips',
      '/api/user/profile',
    ];

    for (const endpoint of endpoints) {
      const start = Date.now();
      await request.get(`${BASE_URL}${endpoint}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(SLA.apiResponse);
    }
  });
});
```

---

## Monitoring and Alerting

### Datadog Integration

```typescript
// tests/smoke/datadog-reporter.ts
import { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { StatsD } from 'hot-shots';

const dogstatsd = new StatsD({
  host: process.env.DD_AGENT_HOST || 'localhost',
  port: 8125,
  prefix: 'minioop.smoke.',
});

export default class DatadogReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult) {
    const tags = [
      `environment:${process.env.STAGING_URL?.includes('staging') ? 'staging' : 'production'}`,
      `test:${test.title}`,
      `status:${result.status}`,
    ];

    dogstatsd.increment('test.completed', tags);
    dogstatsd.histogram('test.duration', result.duration, tags);

    if (result.status === 'failed') {
      dogstatsd.increment('test.failed', tags);
    }
  }

  onEnd() {
    dogstatsd.close();
  }
}
```

```json
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['html'],
    ['tests/smoke/datadog-reporter.ts'],
  ],
  use: {
    baseURL: process.env.STAGING_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 5'] } },
  ],
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
});
```

### PagerDuty Alerting

```yaml
# .github/workflows/smoke-alert.yml
name: Smoke Test Alert

on:
  workflow_run:
    workflows: ["Smoke Tests"]
    types: [completed]
    branches: [main, staging]

jobs:
  alert:
    if: ${{ github.event.workflow_run.conclusion == 'failure' }}
    runs-on: ubuntu-latest
    steps:
      - name: Trigger PagerDuty
        run: |
          curl -X POST https://events.pagerduty.com/v2/enqueue \
            -H "Content-Type: application/json" \
            -d '{
              "routing_key": "${{ secrets.PAGERDUTY_ROUTING_KEY }}",
              "event_action": "trigger",
              "payload": {
                "summary": "Smoke tests failed on ${{ github.event.workflow_run.head_branch }}",
                "severity": "error",
                "source": "smoke-tests",
                "custom_details": {
                  "branch": "${{ github.event.workflow_run.head_branch }}",
                  "run_url": "${{ github.event.workflow_run.html_url }}"
                }
              },
              "links": [
                {
                  "href": "${{ github.event.workflow_run.html_url }}",
                  "text": "View workflow run"
                }
              ]
            }'
```

---

## Test Data Management

### Fixtures

```typescript
// tests/smoke/fixtures.ts
import path from 'path';

export const fixtures = {
  videos: {
    short: path.join(__dirname, '../fixtures/test-10s.mp4'),
    medium: path.join(__dirname, '../fixtures/test-60s.mp4'),
    long: path.join(__dirname, '../fixtures/test-5min.mp4'),
    webm: path.join(__dirname, '../fixtures/test-10s.webm'),
    large: path.join(__dirname, '../fixtures/test-100mb.mp4'),
  },
  images: {
    thumbnail: path.join(__dirname, '../fixtures/thumbnail.jpg'),
    avatar: path.join(__dirname, '../fixtures/avatar.png'),
  },
};

export async function uploadTestVideo(
  baseUrl: string,
  token: string,
  videoPath: string
): Promise<string> {
  const formData = new FormData();
  const fs = await import('fs');
  const videoBlob = new Blob([fs.readFileSync(videoPath)], { type: 'video/mp4' });
  formData.append('file', videoBlob, path.basename(videoPath));

  const response = await fetch(`${baseUrl}/api/videos/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (!response.ok) throw new Error('Upload failed');

  const { videoId } = await response.json();
  return videoId;
}

export async function waitForProcessing(
  baseUrl: string,
  token: string,
  videoId: string,
  maxWaitMs: number = 300000
): Promise<string> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, 5000));

    const response = await fetch(`${baseUrl}/api/videos/${videoId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const video = await response.json();

    if (video.status === 'completed') return 'completed';
    if (video.status === 'failed') throw new Error('Processing failed');
  }

  throw new Error('Processing timeout');
}
```

---

## Reporting

### Test Report Generation

```bash
# Generate HTML report
npx playwright show-report test-results/smoke-report

# Generate JSON report for CI
npx playwright test tests/smoke/ --reporter=json > smoke-results.json

# Generate JUnit XML for CI integration
npx playwright test tests/smoke/ --reporter=junit > smoke-results.xml
```

### Slack Notification

```typescript
// scripts/notify-smoke-results.ts
import { readFileSync } from 'fs';

interface TestResults {
  passed: boolean;
  results: Array<{
    name: string;
    status: string;
    duration: number;
    error?: string;
  }>;
}

async function notifySlack(results: TestResults) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL!;
  const environment = process.env.STAGING_URL?.includes('staging')
    ? 'staging'
    : 'production';

  const passed = results.results.filter(r => r.status === 'passed').length;
  const failed = results.results.filter(r => r.status === 'failed').length;
  const skipped = results.results.filter(r => r.status === 'skipped').length;

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: results.passed
          ? `:white_check_mark: Smoke Tests Passed - ${environment}`
          : `:x: Smoke Tests Failed - ${environment}`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Passed:* ${passed}` },
        { type: 'mrkdwn', text: `*Failed:* ${failed}` },
        { type: 'mrkdwn', text: `*Skipped:* ${skipped}` },
        { type: 'mrkdwn', text: `*Environment:* ${environment}` },
      ],
    },
  ];

  if (failed > 0) {
    const failedTests = results.results
      .filter(r => r.status === 'failed')
      .map(r => `• ${r.name}: ${r.error}`)
      .join('\n');

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Failed Tests:*\n${failedTests}`,
      },
    });
  }

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks }),
  });
}

const results = JSON.parse(readFileSync('smoke-results.json', 'utf-8'));
notifySlack(results).catch(console.error);
```

Run notification:

```bash
npx ts-node scripts/notify-smoke-results.ts
```

---

## Troubleshooting

### Common Issues

**Smoke tests timing out:**
```bash
# Increase timeout
PLAYWRIGHT_TIMEOUT=60000 npx playwright test tests/smoke/

# Check if staging is healthy
curl -v https://staging.minioop.example.com/api/health
```

**Authentication failures:**
```bash
# Verify credentials
curl -X POST https://staging.minioop.example.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@minioop.example.com","password":"test123"}'

# Check if test user exists in Supabase
supabase db execute "SELECT * FROM auth.users WHERE email = 'test@minioop.example.com'"
```

**Video processing stuck:**
```bash
# Check worker logs
aws logs tail /ecs/minioop-staging/worker --follow

# Check Redis queue
redis-cli -h staging-redis.internal LLEN video:processing

# Manually trigger processing
curl -X POST https://staging.minioop.example.com/api/videos/reprocess \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"videoId":"xxx"}'
```

---

## Next Steps

With smoke testing established:
- Review [01-staging-setup.md](./01-staging-setup.md) for infrastructure configuration
- Review [02-staging-workflow.md](./02-staging-workflow.md) for development workflow
- Set up monitoring dashboards in Datadog/Grafana
- Configure PagerDuty escalation policies
