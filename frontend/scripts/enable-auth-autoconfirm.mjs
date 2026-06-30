const token = process.env.SUPABASE_ACCESS_TOKEN
const projectRef = (process.env.SUPABASE_PROJECT_REF ?? 'vnzoksaiowqwaukmtbsi').trim()

const response = await fetch(
  `https://api.supabase.com/v1/projects/${projectRef}/config/auth`,
  {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      mailer_autoconfirm: true,
      disable_signup: false,
    }),
  },
)

console.log('status', response.status)
console.log(await response.text())