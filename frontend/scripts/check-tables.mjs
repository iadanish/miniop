import { config as loadEnv } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadEnv({ path: path.resolve(__dirname, '../../.env') })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_STAGING_URL
const key =
  process.env.SUPABASE_STAGING_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(url, key)

for (const table of ['profiles', 'videos', 'clips']) {
  const { error } = await supabase.from(table).select('id').limit(1)
  console.log(table, error ? error.message : 'ok')
}