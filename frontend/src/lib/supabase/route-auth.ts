import { createServerClient } from '@supabase/ssr'
import { createClient } from '@/lib/supabase/server'

function createBearerClient(accessToken: string) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return []
        },
        setAll() {
          // Route handlers using bearer auth do not persist cookies.
        },
      },
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    },
  )
}

export async function getRouteSupabase(request: Request) {
  const cookieClient = await createClient()
  const {
    data: { user },
    error,
  } = await cookieClient.auth.getUser()

  if (!error && user) {
    return { user, supabase: cookieClient }
  }

  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) {
    return { user: null, supabase: cookieClient }
  }

  const accessToken = authorization.slice('Bearer '.length)
  const bearerClient = createBearerClient(accessToken)
  const {
    data: { user: bearerUser },
    error: bearerError,
  } = await bearerClient.auth.getUser(accessToken)

  if (bearerError || !bearerUser) {
    return { user: null, supabase: cookieClient }
  }

  return { user: bearerUser, supabase: bearerClient }
}