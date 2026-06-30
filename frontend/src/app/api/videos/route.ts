import { NextResponse } from 'next/server'
import { getRouteSupabase } from '@/lib/supabase/route-auth'

export async function GET(request: Request) {
  const { user, supabase } = await getRouteSupabase(request)

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabase
    .from('videos')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ videos: data })
}