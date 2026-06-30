const token = process.env.SUPABASE_ACCESS_TOKEN
const projectRef = (process.env.SUPABASE_PROJECT_REF ?? 'vnzoksaiowqwaukmtbsi').trim()

if (!token) {
  console.error('SUPABASE_ACCESS_TOKEN required')
  process.exit(1)
}

const response = await fetch(
  `https://api.supabase.com/v1/projects/${projectRef}/api-keys`,
  { headers: { Authorization: `Bearer ${token}` } },
)

const body = await response.json()
console.log(JSON.stringify(body, null, 2))