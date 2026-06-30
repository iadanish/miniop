const token = process.env.SUPABASE_ACCESS_TOKEN
const projectRef = (process.env.SUPABASE_PROJECT_REF ?? 'vnzoksaiowqwaukmtbsi').trim()

const response = await fetch(
  `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: `select table_name from information_schema.tables
              where table_schema = 'public'
              and table_name in ('profiles', 'videos', 'clips')
              order by table_name`,
    }),
  },
)

console.log('status', response.status)
console.log(await response.text())