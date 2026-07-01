import fs from 'node:fs'
import path from 'node:path'
import { config as loadEnv } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import ws from 'ws'

const authDir = path.join(__dirname, '.auth')
const credentialsPath = path.join(authDir, 'credentials.json')

loadEnv({ path: path.resolve(__dirname, '../../../.env') })

type SmokeCredentials = {
  email: string
  password: string
}

function writeCredentials(credentials: SmokeCredentials) {
  fs.mkdirSync(authDir, { recursive: true })
  fs.writeFileSync(credentialsPath, JSON.stringify(credentials), 'utf8')
}

export function readSmokeCredentials(): SmokeCredentials | null {
  if (!fs.existsSync(credentialsPath)) {
    return null
  }

  return JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) as SmokeCredentials
}

export default async function globalSetup() {
  if (fs.existsSync(credentialsPath)) {
    return
  }

  fs.mkdirSync(authDir, { recursive: true })

  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_STAGING_URL
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_STAGING_ANON_KEY

  if (!url || !anonKey) {
    throw new Error('Missing Supabase URL or anon key for Playwright global setup')
  }

  const smokeTestEmail = process.env.SMOKE_TEST_EMAIL
  const smokeTestPassword = process.env.SMOKE_TEST_PASSWORD

  let email: string
  let password: string

  const authClient = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as never },
  })

  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_STAGING_SERVICE_KEY

  if (smokeTestEmail && smokeTestPassword) {
    // Prefer pre-created test user from GitHub secrets when provided
    // (avoids signup disabled and invalid key issues)
    email = smokeTestEmail
    password = smokeTestPassword

    if (serviceKey) {
      // Use admin to ensure/create the exact test user (bypasses signup)
      // Ignore any create error (e.g. invalid key or already exists) - we just want to sign in with the provided creds
      try {
        const adminClient = createClient(url, serviceKey, {
          auth: { autoRefreshToken: false, persistSession: false },
          realtime: { transport: ws as never },
        })
        const { error: createError } = await adminClient.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: {
            plan: 'free',
            upload_quota_seconds: 300,
          },
        })
        if (createError) {
          console.warn('Admin create warning (will attempt signin anyway):', createError.message)
        }
      } catch (e: any) {
        console.warn('Admin create exception (will attempt signin anyway):', e.message)
      }
    }
  } else {
    email = `playwright.smoke.${Date.now()}@example.com`
    password = `SmokeTest!${Date.now().toString(36)}`

    if (serviceKey) {
      const adminClient = createClient(url, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
        realtime: { transport: ws as never },
      })
      const { error: createError } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          plan: 'free',
          upload_quota_seconds: 300,
        },
      })
      if (createError) {
        throw new Error(`Failed to create Playwright smoke user: ${createError.message}`)
      }
    } else {
      const { error: signUpError } = await authClient.auth.signUp({
        email,
        password,
        options: {
          data: {
            plan: 'free',
            upload_quota_seconds: 300,
          },
        },
      })
      if (signUpError) {
        throw new Error(`Failed to create Playwright smoke user: ${signUpError.message}`)
      }
    }
  }

  const { error: signInError } = await authClient.auth.signInWithPassword({
    email,
    password,
  })

  if (signInError) {
    throw new Error(`Smoke user could not sign in: ${signInError.message}`)
  }

  writeCredentials({ email, password })
}