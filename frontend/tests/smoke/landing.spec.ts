import { test, expect } from '@playwright/test'

test('landing page shows hero headline', async ({ page }) => {
  await page.goto('/')

  await expect(
    page.getByRole('heading', {
      name: /turn long-form video into clips that ship/i,
    }),
  ).toBeVisible()
})

test('landing page shows primary navigation', async ({ page }) => {
  await page.goto('/')

  const nav = page.getByRole('navigation', { name: /primary/i })
  await expect(nav.getByRole('link', { name: /^get started$/i })).toBeVisible()
  await expect(nav.getByRole('link', { name: /sign in/i })).toBeVisible()
})