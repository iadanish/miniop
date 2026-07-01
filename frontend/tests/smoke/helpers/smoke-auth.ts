import { config as loadEnv } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import path from 'path'
import { readSmokeCredentials } from '../global-setup'

loadEnv({ path: path.resolve(__dirname, '../../../../.env') })

export async function getSmokeAccessToken(): Promise<string> {
  const credentials = readSmokeCredentials()
  if (!credentials) {
    throw new Error('Smoke credentials missing — global setup did not run')
  }

  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_STAGING_URL
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_STAGING_ANON_KEY

  if (!url || !anonKey) {
    throw new Error('Missing Supabase env for smoke auth')
  }

  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data, error } = await client.auth.signInWithPassword({
    email: credentials.email,
    password: credentials.password,
  })

  if (error || !data.session?.access_token) {
    throw new Error(`Smoke sign-in failed: ${error?.message ?? 'no session'}`)
  }

  return data.session.access_token
}

export function smokeAuthHeaders(token: string) {
  return { Authorization: `Bearer ${token}` }
}