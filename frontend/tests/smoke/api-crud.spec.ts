import { test, expect } from '@playwright/test'
import { appendApiSmokeLog, initApiSmokeLog } from './helpers/api-smoke-log'
import { getSmokeAccessToken, smokeAuthHeaders } from './helpers/smoke-auth'
import { tinyMp4Buffer } from './helpers/tiny-mp4'

test.describe('API CRUD via request', () => {
  test('list upload get delete against real routes', async ({ request }) => {
    initApiSmokeLog()
    const token = await getSmokeAccessToken()
    const headers = smokeAuthHeaders(token)

    const listResponse = await request.get('/api/videos', { headers })
    const listBody = await listResponse.text()
    appendApiSmokeLog(`LIST_STATUS: ${listResponse.status()}`)
    appendApiSmokeLog(`LIST_BODY: ${listBody}`)
    expect(listResponse.ok()).toBeTruthy()

    const uploadResponse = await request.post('/api/videos/upload', {
      headers,
      multipart: {
        title: 'API smoke clip',
        file: {
          name: 'smoke.mp4',
          mimeType: 'video/mp4',
          buffer: tinyMp4Buffer,
        },
      },
    })
    const uploadBody = await uploadResponse.text()
    appendApiSmokeLog(`UPLOAD_STATUS: ${uploadResponse.status()}`)
    appendApiSmokeLog(`UPLOAD_BODY: ${uploadBody}`)
    expect(uploadResponse.status()).toBe(201)

    const uploadJson = JSON.parse(uploadBody) as { video?: { id: string } }
    const videoId = uploadJson.video?.id
    expect(videoId).toBeTruthy()

    const getResponse = await request.get(`/api/videos/${videoId}`, { headers })
    const getBody = await getResponse.text()
    appendApiSmokeLog(`GET_STATUS: ${getResponse.status()}`)
    appendApiSmokeLog(`GET_BODY: ${getBody}`)
    expect(getResponse.ok()).toBeTruthy()

    const deleteResponse = await request.delete(`/api/videos/${videoId}`, {
      headers,
    })
    const deleteBody = await deleteResponse.text()
    appendApiSmokeLog(`DELETE_STATUS: ${deleteResponse.status()}`)
    appendApiSmokeLog(`DELETE_BODY: ${deleteBody}`)
    expect(deleteResponse.ok()).toBeTruthy()
  })
})