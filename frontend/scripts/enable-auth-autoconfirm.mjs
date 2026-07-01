import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import { requireMiniOpProjectRef } from './supabase-project-guard.mjs'

loadEnv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env') })

const token = process.env.SUPABASE_ACCESS_TOKEN
const projectRef = requireMiniOpProjectRef()

const response = await fetch(
  `https://api.supabase.com/v1/projects/${projectRef}/config/auth`,
  {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      mailer_autoconfirm: true,
      disable_signup: false,
    }),
  },
)

console.log('status', response.status)
console.log(await response.text())