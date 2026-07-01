import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratchDir =
  process.env.REVERT_SCRATCH ??
  'C:/Users/izhar/AppData/Local/Temp/grok-goal-9a14fb8e598f/implementer'

loadEnv({ path: path.join(repoRoot, '.env') })

const token = process.env.SUPABASE_ACCESS_TOKEN
const projectRef = 'lifmjtvfoppoxymvcemq'

async function query(sql) {
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
  const text = await response.text()
  return { ok: response.ok, status: response.status, body: text }
}

async function main() {
  fs.mkdirSync(scratchDir, { recursive: true })
  const checks = {
    tables: `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('profiles','videos','clips') ORDER BY table_name`,
    smoke_users: `SELECT id, email FROM auth.users WHERE email LIKE 'playwright.smoke.%@example.com' LIMIT 5`,
  }
  const out = { projectRef, at: new Date().toISOString(), results: {} }
  for (const [key, sql] of Object.entries(checks)) {
    out.results[key] = await query(sql)
  }
  const outPath = path.join(scratchDir, 'littleos-prod-audit.json')
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2))
  console.log('Wrote', outPath)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})