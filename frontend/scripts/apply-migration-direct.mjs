import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import pg from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadEnv({ path: path.resolve(__dirname, '../../.env') })

import { requireMiniOpProjectRef } from './supabase-project-guard.mjs'

const password = process.env.SUPABASE_DB_PASSWORD
const projectRef = requireMiniOpProjectRef()

const configs = [
  {
    label: 'direct-5432',
    host: `db.${projectRef}.supabase.co`,
    port: 5432,
    user: 'postgres',
  },
  {
    label: 'pooler-session-5432',
    host: 'aws-0-eu-west-1.pooler.supabase.com',
    port: 5432,
    user: `postgres.${projectRef}`,
  },
  {
    label: 'pooler-tx-6543',
    host: 'aws-0-eu-west-1.pooler.supabase.com',
    port: 6543,
    user: `postgres.${projectRef}`,
  },
]

const sql = fs.readFileSync(
  path.resolve(__dirname, '../../supabase/migrations/20260630000000_phase1_foundation.sql'),
  'utf8',
)

for (const cfg of configs) {
  const client = new pg.Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  })

  try {
    await client.connect()
    await client.query(sql)
    console.log(`Migration applied via ${cfg.label}`)
    await client.end()
    process.exit(0)
  } catch (error) {
    console.error(`${cfg.label}: ${error instanceof Error ? error.message : error}`)
    try {
      await client.end()
    } catch {
      // ignore
    }
  }
}

process.exit(1)