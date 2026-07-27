import { NextResponse } from 'next/server'
import { getRouteSupabase } from '@/lib/supabase/route-auth'

export async function GET(request: Request) {
  const { user, supabase } = await getRouteSupabase(request)

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('mimo_api_key')
    .eq('id', user.id)
    .single()

  const hasKey = !!profile?.mimo_api_key
  const masked = hasKey
    ? profile.mimo_api_key!.slice(0, 4) + '****' + profile.mimo_api_key!.slice(-4)
    : null

  return NextResponse.json({ has_key: hasKey, masked_key: masked })
}

export async function PUT(request: Request) {
  const { user, supabase } = await getRouteSupabase(request)

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { api_key } = body

  if (!api_key || typeof api_key !== 'string' || api_key.trim().length < 10) {
    return NextResponse.json({ error: 'API key is required.' }, { status: 400 })
  }

  const { error } = await supabase
    .from('profiles')
    .update({ mimo_api_key: api_key })
    .eq('id', user.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
