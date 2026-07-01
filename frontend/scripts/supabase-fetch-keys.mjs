const token = process.env.SUPABASE_ACCESS_TOKEN
import { requireMiniOpProjectRef } from './supabase-project-guard.mjs'

const projectRef = requireMiniOpProjectRef()

if (!token) {
  console.error('SUPABASE_ACCESS_TOKEN required')
  process.exit(1)
}

const response = await fetch(
  `https://api.supabase.com/v1/projects/${projectRef}/api-keys`,
  { headers: { Authorization: `Bearer ${token}` } },
)

const body = await response.json()
console.log(JSON.stringify(body, null, 2))