import { test, expect } from '@playwright/test'

test('dashboard redirects unauthenticated users to login', async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/login/)
})

test('authenticated user reaches dashboard welcome content', async ({ page }) => {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL
  const password = process.env.PLAYWRIGHT_TEST_PASSWORD

  test.skip(!email || !password, 'PLAYWRIGHT_TEST_EMAIL and PLAYWRIGHT_TEST_PASSWORD are required')

  await page.goto('/login', { waitUntil: 'networkidle' })
  await page.getByLabel(/email/i).fill(email!)
  await page.getByLabel(/password/i).fill(password!)
  await page.getByRole('button', { name: /sign in/i }).click()

  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 })
  await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible()
  await expect(page.getByText(/welcome back/i)).toBeVisible()
})