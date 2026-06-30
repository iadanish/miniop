import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const scratchDir = path.resolve(
  'C:/Users/izhar/AppData/Local/Temp/grok-goal-ed122ecafab6/implementer',
)
const logPath = path.join(scratchDir, 'api-smoke.log')

loadEnv({ path: path.resolve(__dirname, '../../.env') })

const lines = []
function log(line) {
  lines.push(line)
  console.log(line)
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_STAGING_URL
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_STAGING_ANON_KEY
const baseUrl = process.env.API_SMOKE_BASE_URL ?? 'http://127.0.0.1:3000'

if (!url || !anonKey) {
  log('Missing Supabase credentials for API smoke test')
  process.exit(1)
}

const email = `api.smoke.${Date.now()}@example.com`
const password = `ApiSmoke!${Date.now().toString(36)}`

const auth = createClient(url, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const { error: signUpError } = await auth.auth.signUp({
  email,
  password,
  options: { data: { plan: 'free', upload_quota_seconds: 300 } },
})

if (signUpError) {
  log(`SIGN_UP_ERROR: ${signUpError.message}`)
  fs.writeFileSync(logPath, lines.join('\n'))
  process.exit(1)
}

const { data: signInData, error: signInError } =
  await auth.auth.signInWithPassword({ email, password })

if (signInError || !signInData.session) {
  log(`SIGN_IN_ERROR: ${signInError?.message ?? 'no session'}`)
  fs.writeFileSync(logPath, lines.join('\n'))
  process.exit(1)
}

const accessToken = signInData.session.access_token
const headers = {
  Authorization: `Bearer ${accessToken}`,
  Cookie: `sb-access-token=${accessToken}`,
}

const listResponse = await fetch(`${baseUrl}/api/videos`, { headers })
const listBody = await listResponse.text()
log(`LIST_STATUS: ${listResponse.status}`)
log(`LIST_BODY: ${listBody}`)

const tinyMp4 = Buffer.from(
  'AAAAHGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAA',
  'base64',
)

const formData = new FormData()
formData.append('title', 'API smoke clip')
formData.append(
  'file',
  new Blob([tinyMp4], { type: 'video/mp4' }),
  'smoke.mp4',
)

const uploadResponse = await fetch(`${baseUrl}/api/videos/upload`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}` },
  body: formData,
})
const uploadBody = await uploadResponse.text()
log(`UPLOAD_STATUS: ${uploadResponse.status}`)
log(`UPLOAD_BODY: ${uploadBody}`)

if (uploadResponse.ok) {
  const uploadJson = JSON.parse(uploadBody)
  const videoId = uploadJson.video?.id
  if (videoId) {
    const getResponse = await fetch(`${baseUrl}/api/videos/${videoId}`, { headers })
    const getBody = await getResponse.text()
    log(`GET_STATUS: ${getResponse.status}`)
    log(`GET_BODY: ${getBody}`)

    const deleteResponse = await fetch(`${baseUrl}/api/videos/${videoId}`, {
      method: 'DELETE',
      headers,
    })
    const deleteBody = await deleteResponse.text()
    log(`DELETE_STATUS: ${deleteResponse.status}`)
    log(`DELETE_BODY: ${deleteBody}`)
  }
}

fs.writeFileSync(logPath, lines.join('\n'))

if (!listResponse.ok || !uploadResponse.ok) {
  process.exit(1)
}