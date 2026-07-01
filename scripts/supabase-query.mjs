import { config as loadEnv } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
loadEnv({ path: path.join(repoRoot, '.env') })

const token = process.env.SUPABASE_ACCESS_TOKEN
const projectRef = process.argv[2]
const query = process.argv[3]

if (!token || !projectRef || !query) {
  console.error('Usage: node scripts/supabase-query.mjs <project-ref> "<sql>"')
  process.exit(1)
}

const response = await fetch(
  `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  },
)

const text = await response.text()
if (!response.ok) {
  console.error(text)
  process.exit(1)
}

console.log(text)