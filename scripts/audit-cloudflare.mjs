import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratchDir =
  process.env.REVERT_SCRATCH ??
  'C:/Users/izhar/AppData/Local/Temp/grok-goal-9a14fb8e598f/implementer'

loadEnv({ path: path.join(repoRoot, '.env') })

const token = process.env.CLOUDFLARE_API_TOKEN
const accountId = process.env.R2_ACCOUNT_ID

async function cfGet(pathname) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return response.json()
}

async function main() {
  fs.mkdirSync(scratchDir, { recursive: true })
  const audit = {
    at: new Date().toISOString(),
    accountId,
    miniop_r2_bucket: process.env.R2_BUCKET_NAME,
    r2_buckets: await cfGet(`/accounts/${accountId}/r2/buckets`),
    workers_scripts: await cfGet(`/accounts/${accountId}/workers/scripts`),
    pages_projects: await cfGet(`/accounts/${accountId}/pages/projects`),
  }

  const outPath = path.join(scratchDir, 'cloudflare-audit.json')
  fs.writeFileSync(outPath, JSON.stringify(audit, null, 2))
  console.log('Wrote', outPath)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})