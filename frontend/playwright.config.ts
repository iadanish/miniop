import { defineConfig, devices } from '@playwright/test'

const baseURL =
  process.env.PLAYWRIGHT_BASE_URL ??
  process.env.BASE_URL ??
  'http://127.0.0.1:3005'

const useExternalServer = !!process.env.PW_EXTERNAL_SERVER

export default defineConfig({
  globalSetup: './tests/smoke/global-setup.ts',
  testDir: './tests',
  testMatch: ['smoke/**/*.spec.ts'],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 60_000,
  reporter: [['line'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  ...(useExternalServer
    ? {}
    : {
        webServer: {
          command: process.env.CI
            ? 'npx next start -H 127.0.0.1 -p 3005'
            : 'npx next dev -H 127.0.0.1 -p 3005',
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 300_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      }),
})