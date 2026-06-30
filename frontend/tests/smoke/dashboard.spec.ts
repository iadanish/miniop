import { test, expect } from '@playwright/test'
import { readSmokeCredentials } from './global-setup'

test.describe('dashboard', () => {
  test('redirects unauthenticated users to login', async ({ page }) => {
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForURL(/\/login/, { timeout: 30_000 })
  })

  test('authenticated user reaches dashboard welcome content', async ({ page }) => {
    const credentials = readSmokeCredentials()

    test.skip(!credentials, 'Smoke credentials file missing — global setup did not run')

    await page.goto('/login')
    await page.getByLabel(/email/i).fill(credentials!.email)
    await page.getByLabel(/password/i).fill(credentials!.password)
    await page.getByRole('button', { name: /sign in/i }).click()

    await page.waitForURL(/\/dashboard/, { timeout: 45_000 })
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible()
    await expect(page.getByText(/welcome back/i)).toBeVisible()
  })
})