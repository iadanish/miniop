const token = process.env.SUPABASE_ACCESS_TOKEN
if (!token) {
  console.error('SUPABASE_ACCESS_TOKEN required')
  process.exit(1)
}

const response = await fetch('https://api.supabase.com/v1/projects', {
  headers: { Authorization: `Bearer ${token}` },
})

const body = await response.text()
console.log('status', response.status)
console.log(body)