/**
 * Revert MiniOp Phase 1 artifacts from LittleOS Supabase staging.
 * Restores canonical LittleOS handle_new_user from D:\IAD\littleOS migrations.
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

if (!token) {
  console.error('SUPABASE_ACCESS_TOKEN required')
  process.exit(1)
}

fs.mkdirSync(scratchDir, { recursive: true })

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
  if (!response.ok) {
    throw new Error(`${response.status}: ${text}`)
  }
  return JSON.parse(text)
}

const LITTLEOS_HANDLE_NEW_USER = `
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id uuid;
  v_name      text;
BEGIN
  v_name := split_part(NEW.email, '@', 1);

  INSERT INTO public.tenants (name, plan)
  VALUES ('My Workspace', 'starter')
  RETURNING id INTO v_tenant_id;

  INSERT INTO public.users (id, email, full_name, role, tenant_id)
  VALUES (NEW.id, NEW.email, v_name, 'owner', v_tenant_id);

  UPDATE public.tenants
  SET owner_user_id = NEW.id
  WHERE id = v_tenant_id;

  UPDATE auth.users
  SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('tenant_id', v_tenant_id::text, 'role', 'owner')
  WHERE id = NEW.id;

  RETURN NEW;
END;
$$;
`

const REVERT_SQL = `
BEGIN;

-- MiniOp smoke-test users (profiles-only signup path)
DELETE FROM auth.users
WHERE email LIKE 'playwright.smoke.%@example.com';

-- MiniOp-only tables (LittleOS has no profiles/videos/clips in migrations)
DROP TABLE IF EXISTS public.clips CASCADE;
DROP TABLE IF EXISTS public.videos CASCADE;
DROP TABLE IF EXISTS public.profiles CASCADE;

-- Restore LittleOS signup trigger function
${LITTLEOS_HANDLE_NEW_USER}

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

COMMIT;
`

async function inventory(label) {
  const checks = {
    tables: `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('profiles','videos','clips') ORDER BY table_name`,
    handle_new_user: `SELECT pg_get_functiondef('public.handle_new_user()'::regprocedure) AS def`,
    smoke_users: `SELECT id, email, created_at FROM auth.users WHERE email LIKE 'playwright.smoke.%@example.com' ORDER BY created_at DESC LIMIT 20`,
    littleos_tables: `SELECT COUNT(*)::int AS cnt FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('agents','tenants','users')`,
  }
  const out = { label, projectRef, at: new Date().toISOString() }
  for (const [key, sql] of Object.entries(checks)) {
    out[key] = await query(sql)
  }
  return out
}

async function listApiKeys() {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/api-keys`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const text = await response.text()
  if (!response.ok) throw new Error(text)
  return JSON.parse(text)
}

async function deleteApiKey(id) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/api-keys/${id}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  )
  return { status: response.status, body: await response.text() }
}

async function main() {
  const beforePath = path.join(scratchDir, 'littleos-staging-before.json')
  const before = await inventory('before')
  before.api_keys = await listApiKeys()
  fs.writeFileSync(beforePath, JSON.stringify(before, null, 2))
  console.log('Wrote', beforePath)

  await query(REVERT_SQL)
  console.log('Revert SQL executed')

  const keys = await listApiKeys()
  for (const key of keys) {
    if (key.name === 'miniop_phase1') {
      const del = await deleteApiKey(key.id)
      console.log('Deleted miniop_phase1 key', del.status)
    }
  }

  const after = await inventory('after')
  after.api_keys = await listApiKeys()
  const afterPath = path.join(scratchDir, 'littleos-staging-after.json')
  fs.writeFileSync(afterPath, JSON.stringify(after, null, 2))
  console.log('Wrote', afterPath)
}

main().catch((err) => {
  console.error(err.message ?? err)
  process.exit(1)
})