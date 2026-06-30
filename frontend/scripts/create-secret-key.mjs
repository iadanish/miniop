const token = process.env.SUPABASE_ACCESS_TOKEN
const projectRef = (process.env.SUPABASE_PROJECT_REF ?? 'vnzoksaiowqwaukmtbsi').trim()

const response = await fetch(
  `https://api.supabase.com/v1/projects/${projectRef}/api-keys`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'miniop_phase1',
      type: 'secret',
      description: 'MiniOp Phase 1 server operations',
      secret_jwt_template: { role: 'service_role' },
    }),
  },
)

console.log('status', response.status)
console.log(await response.text())