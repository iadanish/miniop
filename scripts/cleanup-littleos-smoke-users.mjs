/**
 * Remove MiniOp Playwright smoke users and orphan tenant rows from LittleOS Staging.
 */
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
const projectRef = 'vnzoksaiowqwaukmtbsi'

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
  if (!response.ok) throw new Error(`${response.status}: ${text}`)
  return text
}

const CLEANUP_SQL = `
BEGIN;

-- Orphan tenants/workspaces created by smoke signups after LittleOS handle_new_user restored
DELETE FROM public.users
WHERE email LIKE 'playwright.smoke.%@example.com';

DELETE FROM public.tenants t
WHERE t.name = 'My Workspace'
  AND t.plan = 'starter'
  AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.tenant_id = t.id);

DELETE FROM auth.users
WHERE email LIKE 'playwright.smoke.%@example.com';

COMMIT;
`

async function main() {
  fs.mkdirSync(scratchDir, { recursive: true })
  const before = await query(
    `SELECT u.id, u.email FROM auth.users u WHERE u.email LIKE 'playwright.smoke.%@example.com'`,
  )
  await query(CLEANUP_SQL)
  const after = await query(
    `SELECT u.id, u.email FROM auth.users u WHERE u.email LIKE 'playwright.smoke.%@example.com'`,
  )
  const log = { at: new Date().toISOString(), projectRef, before, after }
  const outPath = path.join(scratchDir, 'littleos-smoke-cleanup.json')
  fs.writeFileSync(outPath, JSON.stringify(log, null, 2))
  console.log('Wrote', outPath)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})