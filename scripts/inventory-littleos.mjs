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
const STAGING = 'vnzoksaiowqwaukmtbsi'
const PROD = 'lifmjtvfoppoxymvcemq'

async function query(ref, sql) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
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

async function apiKeys(ref) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/api-keys`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const text = await response.text()
  return { ok: response.ok, status: response.status, body: text }
}

async function authConfig(ref) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/config/auth`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const text = await response.text()
  return { ok: response.ok, status: response.status, body: text }
}

const SQL = {
  miniop_tables: `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('profiles','videos','clips') ORDER BY table_name`,
  smoke_users: `SELECT id, email, created_at FROM auth.users WHERE email LIKE 'playwright.smoke.%@example.com' ORDER BY created_at DESC LIMIT 20`,
  handle_new_user: `SELECT pg_get_functiondef('public.handle_new_user()'::regprocedure) AS def`,
  littleos_core: `SELECT COUNT(*)::int AS cnt FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('agents','tenants','users')`,
}

async function inventoryProject(ref, label) {
  const out = { ref, label, checks: {} }
  for (const [name, sql] of Object.entries(SQL)) {
    out.checks[name] = await query(ref, sql)
  }
  out.api_keys = await apiKeys(ref)
  out.auth_config = await authConfig(ref)
  return out
}

async function main() {
  if (!token || token.includes('REPLACE_WITH')) {
    console.log(
      'SKIP: set SUPABASE_ACCESS_TOKEN temporarily to re-audit LittleOS (MiniOp .env parked)',
    )
    process.exit(0)
  }

  fs.mkdirSync(scratchDir, { recursive: true })
  const report = {
    at: new Date().toISOString(),
    staging: await inventoryProject(STAGING, 'LittleOS Staging'),
    prod: await inventoryProject(PROD, 'LittleOS Prod'),
  }

  let stagingKeys = []
  try {
    const parsed = JSON.parse(report.staging.api_keys.body || '[]')
    stagingKeys = Array.isArray(parsed) ? parsed : []
  } catch {
    stagingKeys = []
  }
  report.staging.miniop_api_key_present = stagingKeys.some(
    (k) => k.name === 'miniop_phase1',
  )

  const outPath = path.join(scratchDir, 'littleos-reverify.json')
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log('Wrote', outPath)

  const parseRows = (body) => {
    try {
      const parsed = JSON.parse(body || '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  const stagingTables = parseRows(report.staging.checks.miniop_tables.body)
  const prodTables = parseRows(report.prod.checks.miniop_tables.body)
  const stagingSmoke = parseRows(report.staging.checks.smoke_users.body)
  const prodSmoke = parseRows(report.prod.checks.smoke_users.body)

  const needsRevert =
    stagingTables.length > 0 ||
    prodTables.length > 0 ||
    stagingSmoke.length > 0 ||
    prodSmoke.length > 0 ||
    report.staging.miniop_api_key_present

  if (needsRevert) {
    console.log('DRIFT_DETECTED: run node scripts/revert-littleos-miniop.mjs')
    process.exit(2)
  }
  console.log('PASS: no MiniOp drift on LittleOS staging/prod tables')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})