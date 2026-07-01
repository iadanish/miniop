import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import { requireMiniOpProjectRef } from './supabase-project-guard.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadEnv({ path: path.resolve(__dirname, '../../.env') })

const token = process.env.SUPABASE_ACCESS_TOKEN
const projectRef = requireMiniOpProjectRef()

const migrationPath = path.resolve(
  __dirname,
  '../../supabase/migrations/20260630000000_phase1_foundation.sql',
)
const sql = fs.readFileSync(migrationPath, 'utf8')

if (token) {
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

  if (response.ok) {
    console.log('Migration applied via Supabase Management API')
    process.exit(0)
  }

  console.error('Management API failed:', response.status, await response.text())
}

const password = process.env.SUPABASE_DB_PASSWORD
if (!password) {
  console.error('Set SUPABASE_ACCESS_TOKEN or SUPABASE_DB_PASSWORD')
  process.exit(1)
}

const pg = await import('pg')
const client = new pg.default.Client({
  host: process.env.SUPABASE_POOLER_HOST ?? 'aws-0-eu-west-1.pooler.supabase.com',
  port: Number(process.env.SUPABASE_DB_PORT ?? 5432),
  user: `postgres.${projectRef}`,
  password,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

try {
  await client.connect()
  await client.query(sql)
  console.log('Migration applied via direct database connection')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
} finally {
  await client.end()
}