import { test, expect } from '@playwright/test'

test('login page shows email and password fields', async ({ page }) => {
  await page.goto('/login')

  await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible()
  await expect(page.getByLabel(/email/i)).toBeVisible()
  await expect(page.getByLabel(/password/i)).toBeVisible()
  await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
})