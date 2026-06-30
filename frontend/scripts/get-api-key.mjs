const token = process.env.SUPABASE_ACCESS_TOKEN
const keyId = process.argv[2]
const projectRef = 'vnzoksaiowqwaukmtbsi'

const response = await fetch(
  `https://api.supabase.com/v1/projects/${projectRef}/api-keys/${keyId}`,
  { headers: { Authorization: `Bearer ${token}` } },
)

console.log(await response.text())