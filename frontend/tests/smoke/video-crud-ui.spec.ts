import { test, expect } from '@playwright/test'
import { readSmokeCredentials } from './global-setup'
import { getSmokeAccessToken, smokeAuthHeaders } from './helpers/smoke-auth'
import { tinyMp4Buffer } from './helpers/tiny-mp4'

async function signIn(page: import('@playwright/test').Page) {
  const credentials = readSmokeCredentials()
  test.skip(!credentials, 'Smoke credentials file missing')

  await page.goto('/login')
  await page.getByLabel(/email/i).fill(credentials!.email)
  await page.getByLabel(/password/i).fill(credentials!.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 45_000 })
}

test.describe('dashboard video CRUD UI', () => {
  test('lists seeded video and deletes via UI', async ({ page, request }) => {
    const token = await getSmokeAccessToken()
    const title = `UI smoke ${Date.now()}`

    const seed = await request.post('/api/videos/upload', {
      headers: smokeAuthHeaders(token),
      multipart: {
        title,
        file: {
          name: 'ui-smoke.mp4',
          mimeType: 'video/mp4',
          buffer: tinyMp4Buffer,
        },
      },
    })
    expect(seed.status()).toBe(201)
    const seedJson = (await seed.json()) as { video: { id: string } }
    const videoId = seedJson.video.id

    await signIn(page)
    await page.goto('/dashboard')
    await expect(page.getByTestId('video-list')).toBeVisible()
    await expect(page.getByText(title)).toBeVisible()

    page.once('dialog', (dialog) => dialog.accept())
    await page.getByTestId(`delete-video-${videoId}`).click()
    await expect(page.getByText(title)).not.toBeVisible({ timeout: 15_000 })

    const listCheck = await request.get('/api/videos', {
      headers: smokeAuthHeaders(token),
    })
    const listJson = (await listCheck.json()) as { videos: { id: string }[] }
    expect(listJson.videos.some((v) => v.id === videoId)).toBe(false)
  })
})