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
const projectRef = 'pycaruihndpxznvxuqdk'
const logPath = path.join(scratchDir, 'miniop-migration.log')

const sql = fs.readFileSync(
  path.join(repoRoot, 'supabase/migrations/20260630000000_phase1_foundation.sql'),
  'utf8',
)

async function query(q) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: q }),
    },
  )
  const text = await response.text()
  return { status: response.status, body: text }
}

async function main() {
  fs.mkdirSync(scratchDir, { recursive: true })
  const lines = [`[${new Date().toISOString()}] Applying Phase 1 to ${projectRef}`]

  const before = await query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('profiles','videos','clips') ORDER BY table_name`,
  )
  lines.push('BEFORE tables:', before.body)

  const apply = await query(sql)
  lines.push(`APPLY status ${apply.status}`, apply.body)
  if (apply.status >= 400) {
    fs.writeFileSync(logPath, lines.join('\n'))
    process.exit(1)
  }

  const after = await query(
    `SELECT table_name, rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename IN ('profiles','videos','clips') ORDER BY tablename`,
  )
  lines.push('AFTER tables+RLS:', after.body)

  const littleosCheck = await query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('agents','tenants') ORDER BY table_name`,
  )
  lines.push('LittleOS tables (should be empty):', littleosCheck.body)

  fs.writeFileSync(logPath, lines.join('\n'))
  console.log('Wrote', logPath)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})