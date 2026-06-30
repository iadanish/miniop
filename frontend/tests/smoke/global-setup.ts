import path from 'path'
import { config as loadEnv } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

loadEnv({ path: path.resolve(__dirname, '../../../.env') })

export default async function globalSetup() {
  if (process.env.PLAYWRIGHT_TEST_EMAIL && process.env.PLAYWRIGHT_TEST_PASSWORD) {
    return
  }

  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_STAGING_URL
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_STAGING_ANON_KEY

  if (!url || !anonKey) {
    return
  }

  const email = `playwright.smoke.${Date.now()}@example.com`
  const password = `SmokeTest!${Date.now().toString(36)}`

  const authClient = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

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

  const { error: signInError } = await authClient.auth.signInWithPassword({
    email,
    password,
  })

  if (signInError) {
    throw new Error(`Smoke user could not sign in: ${signInError.message}`)
  }

  process.env.PLAYWRIGHT_TEST_EMAIL = email
  process.env.PLAYWRIGHT_TEST_PASSWORD = password
}