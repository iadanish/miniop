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
    .select('id, status, analysis, transcription_id')
    .eq('id', id)
    .single()

  if (videoError || !video) {
    return NextResponse.json({ error: 'Video not found.' }, { status: 404 })
  }

  const { data: jobs } = await supabase
    .from('processing_jobs')
    .select('id, job_type, status, started_at, completed_at, error')
    .eq('video_id', id)
    .order('created_at', { ascending: false })
    .limit(5)

  return NextResponse.json({
    video_id: video.id,
    status: video.status,
    has_analysis: Object.keys(video.analysis || {}).length > 0,
    has_transcription: !!video.transcription_id,
    jobs: jobs || [],
  })
}
