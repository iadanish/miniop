import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadEnv({ path: path.resolve(__dirname, '../../.env') })

const token = process.env.SUPABASE_ACCESS_TOKEN
const projectRef = (
  process.env.SUPABASE_PROJECT_REF ?? 'gjeymxxhrggsxytzbiur'
).trim()

if (!token) {
  console.error('SUPABASE_ACCESS_TOKEN is required')
  process.exit(1)
}

const sql = fs.readFileSync(
  path.resolve(__dirname, '../../supabase/migrations/20260630000000_phase1_foundation.sql'),
  'utf8',
)

const response = await fetch(
  `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  },
)

const body = await response.text()
console.log('status', response.status)

if (!response.ok) {
  console.error(body)
  process.exit(1)
}

console.log('Migration applied via Management API')
console.log(body.slice(0, 500))