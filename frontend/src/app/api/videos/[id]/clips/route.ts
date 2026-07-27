import { NextResponse } from 'next/server'
import { getRouteSupabase } from '@/lib/supabase/route-auth'

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params
  const { user, supabase } = await getRouteSupabase(request)

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: video, error: videoError } = await supabase
    .from('videos')
    .select('id, status')
    .eq('id', id)
    .single()

  if (videoError || !video) {
    return NextResponse.json({ error: 'Video not found.' }, { status: 404 })
  }

  const { data: clips, error: clipsError } = await supabase
    .from('clips')
    .select('*')
    .eq('video_id', id)
    .order('virality_score', { ascending: false })

  if (clipsError) {
    return NextResponse.json({ error: clipsError.message }, { status: 500 })
  }

  return NextResponse.json({ clips: clips || [] })
}
