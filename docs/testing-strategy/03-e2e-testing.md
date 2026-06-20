# End-to-End Testing Strategy

## Overview

End-to-end (E2E) tests simulate real user workflows through the MiniOp application — from uploading a video to exporting a finished clip. These tests run against a deployed environment (local or staging) using a real browser. They are the final gate before code reaches production and catch integration failures that unit and integration tests miss: broken navigation, CSS regressions, JavaScript runtime errors, and incorrect state management across pages.

## Tooling

MiniOp uses **Playwright** for E2E testing. Playwright provides cross-browser testing (Chromium, Firefox, WebKit), automatic waiting, and built-in test isolation. Each test runs in a fresh browser context, preventing state leakage.

```bash
pnpm add -D @playwright/test
npx playwright install --with-deps
```

### Playwright Configuration

```ts
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['junit', { outputFile: 'test-results/junit.xml' }]]
    : [['html', { open: 'on-failure' }]],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

### Test Helpers and Fixtures

Playwright fixtures provide authenticated state and reusable page objects:

```ts
// e2e/fixtures.ts
import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export const test = base.extend<{
  authenticatedPage: Page;
  proUserPage: Page;
}>({
  authenticatedPage: async ({ page, context }, use) => {
    await context.addCookies([
      {
        name: 'auth_token',
        value: process.env.TEST_AUTH_TOKEN || 'test-token-local',
        domain: 'localhost',
        path: '/',
      },
    ]);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible();
    await use(page);
  },
  proUserPage: async ({ page, context }, use) => {
    await context.addCookies([
      {
        name: 'auth_token',
        value: process.env.TEST_PRO_AUTH_TOKEN || 'test-pro-token-local',
        domain: 'localhost',
        path: '/',
      },
    ]);
    await page.goto('/dashboard');
    await use(page);
  },
});

export { expect };
```

## Critical User Workflows

### Video Upload and Analysis

The primary user journey: upload a video, wait for analysis, review clips.

```ts
// e2e/upload-and-analyze.spec.ts
import { test, expect } from '../fixtures';

test.describe('Video Upload and Analysis', () => {
  test('uploads video and displays processing status', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /upload video/i }).click();

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles('e2e/fixtures/test-video.mp4');

    await expect(page.getByText(/uploading/i)).toBeVisible();
    await expect(page.getByText(/upload complete/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/analyzing/i)).toBeVisible();
  });

  test('displays detected clips after analysis completes', async ({ authenticatedPage: page }) => {
    // Use a pre-analyzed video for deterministic results
    await page.goto('/videos/pre_analyzed_001');

    await expect(page.getByRole('heading', { name: /detected clips/i })).toBeVisible({
      timeout: 60_000,
    });

    const clipCards = page.locator('[data-testid="clip-card"]');
    await expect(clipCards).toHaveCount(5);

    // Verify clips are sorted by score
    const scores = await clipCards.evaluateAll((els) =>
      els.map((el) => parseFloat(el.dataset.score || '0'))
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });

  test('shows error state for unsupported file format', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /upload video/i }).click();

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles('e2e/fixtures/document.pdf');

    await expect(page.getByText(/unsupported file format/i)).toBeVisible();
  });

  test('respects free tier clip limit', async ({ authenticatedPage: page }) => {
    // Free tier gets max 3 clips
    await page.goto('/videos/free_tier_video');

    const clipCards = page.locator('[data-testid="clip-card"]');
    await expect(clipCards).toHaveCount(3);

    await expect(page.getByText(/upgrade to get more clips/i)).toBeVisible();
  });
});
```

### Clip Editor

The clip editor is the most complex interactive component. E2E tests verify timeline scrubbing, caption editing, and export options.

```ts
// e2e/clip-editor.spec.ts
import { test, expect } from '../fixtures';

test.describe('Clip Editor', () => {
  test.beforeEach(async ({ proUserPage: page }) => {
    await page.goto('/clips/clip_test_001/edit');
    await expect(page.locator('[data-testid="video-player"]')).toBeVisible();
  });

  test('trims clip start and end times via drag handles', async ({ proUserPage: page }) => {
    const startHandle = page.locator('[data-testid="trim-start"]');
    const endHandle = page.locator('[data-testid="trim-end"]');

    // Drag start handle to the right (increase start time)
    await startHandle.dragTo(page.locator('[data-testid="timeline"]'), {
      targetPosition: { x: 150, y: 10 },
    });

    await expect(page.locator('[data-testid="start-time"]')).toHaveText('00:00:15');

    // Drag end handle to the left (decrease end time)
    await endHandle.dragTo(page.locator('[data-testid="timeline"]'), {
      targetPosition: { x: 400, y: 10 },
    });

    await expect(page.locator('[data-testid="end-time"]')).toHaveText('00:00:40');

    // Verify duration updates
    await expect(page.locator('[data-testid="clip-duration"]')).toHaveText('0:25');
  });

  test('edits caption text inline', async ({ proUserPage: page }) => {
    const caption = page.locator('[data-testid="caption-segment"]').first();
    await caption.dblclick();

    const input = caption.locator('input');
    await input.fill('Updated caption text');
    await input.press('Enter');

    await expect(caption.locator('[data-testid="caption-text"]')).toHaveText('Updated caption text');
  });

  test('changes aspect ratio and previews result', async ({ proUserPage: page }) => {
    await page.getByRole('button', { name: /aspect ratio/i }).click();
    await page.getByRole('option', { name: /9:16 vertical/i }).click();

    const player = page.locator('[data-testid="video-player"]');
    await expect(player).toHaveCSS('aspect-ratio', '9/16');

    await page.getByRole('button', { name: /1:1 square/i }).click();
    await expect(player).toHaveCSS('aspect-ratio', '1/1');
  });

  test('applies caption style presets', async ({ proUserPage: page }) => {
    await page.getByRole('button', { name: /caption style/i }).click();

    await page.getByText(/bold modern/i).click();

    const caption = page.locator('[data-testid="caption-preview"]');
    await expect(caption).toHaveCSS('font-weight', '700');

    await page.getByText(/minimal/i).click();
    await expect(caption).toHaveCSS('font-weight', '400');
  });
});
```

### Export Flow

```ts
// e2e/export.spec.ts
import { test, expect } from '../fixtures';

test.describe('Export', () => {
  test('exports clip as MP4 with selected options', async ({ proUserPage: page }) => {
    await page.goto('/clips/clip_test_001/edit');

    await page.getByRole('button', { name: /export/i }).click();

    // Select format
    await page.getByRole('radio', { name: /mp4/i }).check();

    // Select quality
    await page.getByRole('combobox', { name: /quality/i }).selectOption('1080p');

    // Enable caption burn-in
    await page.getByRole('checkbox', { name: /burn captions/i }).check();

    // Start export
    await page.getByRole('button', { name: /start export/i }).click();

    // Wait for processing
    await expect(page.getByText(/exporting/i)).toBeVisible();
    await expect(page.getByText(/export complete/i)).toBeVisible({ timeout: 120_000 });

    // Verify download button
    const downloadButton = page.getByRole('link', { name: /download/i });
    await expect(downloadButton).toBeVisible();
    await expect(downloadButton).toHaveAttribute('href', /\.mp4$/);
  });

  test('free tier user sees watermark on export', async ({ authenticatedPage: page }) => {
    await page.goto('/clips/clip_free_001/edit');
    await page.getByRole('button', { name: /export/i }).click();

    await expect(page.getByText(/watermark will be added/i)).toBeVisible();
    await expect(page.getByText(/remove watermark.*pro/i)).toBeVisible();
  });
});
```

### Authentication Flows

```ts
// e2e/auth.spec.ts
import { test, expect } from '../fixtures';

test.describe('Authentication', () => {
  test('logs in with email and password', async ({ page }) => {
    await page.goto('/login');

    await page.getByLabel(/email/i).fill('user@minio.dev');
    await page.getByLabel(/password/i).fill('TestPassword123!');
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page).toHaveURL('/dashboard');
    await expect(page.getByText(/welcome/i)).toBeVisible();
  });

  test('shows error for invalid credentials', async ({ page }) => {
    await page.goto('/login');

    await page.getByLabel(/email/i).fill('user@minio.dev');
    await page.getByLabel(/password/i).fill('wrongpassword');
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page.getByText(/invalid credentials/i)).toBeVisible();
    await expect(page).toHaveURL('/login');
  });

  test('redirects unauthenticated user to login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('persists session across page reload', async ({ authenticatedPage: page }) => {
    await page.reload();
    await expect(page).toHaveURL('/dashboard');
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible();
  });
});
```

## Page Object Pattern

For complex pages, extract selectors and actions into page objects:

```ts
// e2e/page-objects/DashboardPage.ts
import type { Page, Locator } from '@playwright/test';

export class DashboardPage {
  readonly page: Page;
  readonly uploadButton: Locator;
  readonly videoList: Locator;
  readonly creditBalance: Locator;

  constructor(page: Page) {
    this.page = page;
    this.uploadButton = page.getByRole('button', { name: /upload video/i });
    this.videoList = page.locator('[data-testid="video-list"]');
    this.creditBalance = page.locator('[data-testid="credit-balance"]');
  }

  async goto() {
    await this.page.goto('/dashboard');
  }

  async uploadVideo(filePath: string) {
    await this.uploadButton.click();
    await this.page.locator('input[type="file"]').setInputFiles(filePath);
  }

  async getVideoCount(): Promise<number> {
    return this.videoList.locator('[data-testid="video-item"]').count();
  }

  async getCredits(): Promise<string> {
    return (await this.creditBalance.textContent()) || '';
  }

  async openVideo(videoName: string) {
    await this.videoList.getByText(videoName).click();
  }
}
```

## Visual Regression Testing

Playwright's built-in screenshot comparison catches CSS regressions:

```ts
// e2e/visual.spec.ts
import { test, expect } from '../fixtures';

test.describe('Visual Regression', () => {
  test('dashboard matches baseline screenshot', async ({ authenticatedPage: page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot('dashboard.png', {
      maxDiffPixels: 100,
    });
  });

  test('clip editor matches baseline', async ({ proUserPage: page }) => {
    await page.goto('/clips/clip_test_001/edit');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[data-testid="clip-editor"]')).toHaveScreenshot(
      'clip-editor.png',
      { maxDiffPixels: 200 }
    );
  });

  test('mobile layout renders correctly', async ({ authenticatedPage: page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/dashboard');
    await expect(page).toHaveScreenshot('dashboard-mobile.png');
  });
});
```

Update baselines with:
```bash
npx playwright test --update-snapshots
```

## Free Tier vs. Production

| Aspect | Free Tier (Local) | Production (CI) |
|--------|-------------------|-----------------|
| Browsers | Chromium only | Chromium + Firefox + Mobile |
| Retries | 0 (fast feedback) | 2 (handle flakiness) |
| Artifacts | On-failure only | Always (trace, video, screenshots) |
| Visual tests | Skipped | Enforced with baseline comparison |
| Test data | Pre-seeded fixtures | Seeded via API before suite |
| Environment | localhost:3000 | Staging deployment |

### CI Pipeline

```yaml
# .github/workflows/e2e-tests.yml
name: E2E Tests
on: [pull_request]

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: npx playwright install --with-deps
      - run: pnpm build
      - run: pnpm playwright test
        env:
          BASE_URL: http://localhost:3000
          TEST_AUTH_TOKEN: ${{ secrets.TEST_AUTH_TOKEN }}
          TEST_PRO_AUTH_TOKEN: ${{ secrets.TEST_PRO_AUTH_TOKEN }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report
          path: playwright-report/
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-results
          path: test-results/
```

## Running E2E Tests

```bash
# All tests
pnpm playwright test

# Specific browser
pnpm playwright test --project=chromium

# Single test file
pnpm playwright test e2e/upload-and-analyze.spec.ts

# With UI mode (interactive debugging)
pnpm playwright test --ui

# Show last report
pnpm playwright show-report

# Debug a specific test
pnpm playwright test --debug e2e/clip-editor.spec.ts
```

## Test Data Strategy

E2E tests use pre-seeded data via API calls before the suite runs:

```ts
// e2e/global-setup.ts
import { chromium, FullConfig } from '@playwright/test';

async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL || 'http://localhost:3000';

  // Seed test data via internal API
  const response = await fetch(`${baseURL}/api/test/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      users: [
        { email: 'test@minio.dev', tier: 'free', password: 'TestPassword123!' },
        { email: 'pro@minio.dev', tier: 'pro', password: 'TestPassword123!' },
      ],
      videos: ['pre_analyzed_001', 'free_tier_video'],
      clips: ['clip_test_001', 'clip_free_001'],
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to seed test data: ${response.status}`);
  }
}

export default globalSetup;
```

E2E tests are the slowest test tier (target: under 10 minutes for the full suite). They run only on pull requests, not on every push. Keep the test count focused on critical paths — every additional E2E test adds real execution time.
