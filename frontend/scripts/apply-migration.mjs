import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadEnv({ path: path.resolve(__dirname, '../../.env') })

const password = process.env.SUPABASE_DB_PASSWORD
const projectRef = (
  process.env.SUPABASE_PROJECT_REF ?? 'gjeymxxhrggsxytzbiur'
).trim()

if (!password) {
  console.error('SUPABASE_DB_PASSWORD is required')
  process.exit(1)
}

const migrationPath = path.resolve(
  __dirname,
  '../../supabase/migrations/20260630000000_phase1_foundation.sql',
)
const sql = fs.readFileSync(migrationPath, 'utf8')

const poolerHost =
  process.env.SUPABASE_POOLER_HOST ?? 'aws-0-eu-west-1.pooler.supabase.com'

const client = new pg.Client({
  host: poolerHost,
  port: Number(process.env.SUPABASE_DB_PORT ?? 5432),
  user: `postgres.${projectRef}`,
  password,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

try {
  await client.connect()
  await client.query(sql)
  console.log('Migration applied successfully')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
} finally {
  await client.end()
}