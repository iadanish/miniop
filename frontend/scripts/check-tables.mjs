import { config as loadEnv } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadEnv({ path: path.resolve(__dirname, '../../.env') })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_STAGING_URL
const key =
  process.env.SUPABASE_STAGING_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  console.error('Missing Supabase URL or service key')
  process.exit(1)
}

const supabase = createClient(url, key)
const results = {}

for (const table of ['profiles', 'videos', 'clips']) {
  const { error } = await supabase.from(table).select('id').limit(1)
  results[table] = error ? error.message : 'ok'
}

console.log(JSON.stringify(results, null, 2))

if (Object.values(results).some((value) => value !== 'ok')) {
  process.exit(1)
}