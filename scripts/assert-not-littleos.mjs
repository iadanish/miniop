import { config as loadEnv } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
loadEnv({ path: path.join(repoRoot, '.env') })

const BLOCKED_REFS = ['vnzoksaiowqwaukmtbsi', 'lifmjtvfoppoxymvcemq', 'gjeymxxhrggsxytzbiur']
const BLOCKED_HOSTS = BLOCKED_REFS.map((r) => `db.${r}.supabase.co`)

function checkValue(label, value) {
  if (!value) return
  const v = String(value)
  for (const ref of BLOCKED_REFS) {
    if (v.includes(ref)) {
      console.error(`BLOCKED: ${label} references LittleOS project ${ref}`)
      process.exit(1)
    }
  }
  for (const host of BLOCKED_HOSTS) {
    if (v.includes(host)) {
      console.error(`BLOCKED: ${label} references LittleOS host ${host}`)
      process.exit(1)
    }
  }
}

checkValue('SUPABASE_PROJECT_REF', process.env.SUPABASE_PROJECT_REF)
checkValue('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL)
checkValue('SUPABASE_STAGING_URL', process.env.SUPABASE_STAGING_URL)
checkValue('SUPABASE_PROD_URL', process.env.SUPABASE_PROD_URL)

console.log('OK: env does not reference LittleOS Supabase projects')