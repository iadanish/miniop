import { NextResponse } from 'next/server'
import { getRouteSupabase } from '@/lib/supabase/route-auth'

type RouteContext = {
  params: Promise<{ id: string }>
}

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000'

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params
  const { user, supabase } = await getRouteSupabase(request)

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: video, error: fetchError } = await supabase
    .from('videos')
    .select('*')
    .eq('id', id)
    .single()

  if (fetchError || !video) {
    return NextResponse.json({ error: 'Video not found.' }, { status: 404 })
  }

  if (video.status === 'processing' || video.status === 'queued') {
    return NextResponse.json({ error: 'Video is already being processed.' }, { status: 409 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('mimo_api_key')
    .eq('id', user.id)
    .single()

  if (!profile?.mimo_api_key) {
    return NextResponse.json(
      { error: 'MiMo API key not configured. Please add it in Settings.' },
      { status: 400 }
    )
  }

  // Create job in Supabase
  const { data: job, error: jobError } = await supabase
    .from('processing_jobs')
    .insert({
      video_id: id,
      user_id: user.id,
      job_type: 'full',
      status: 'pending',
      payload: {
        video_storage_key: video.storage_key,
        title: video.title,
      },
    })
    .select('*')
    .single()

  if (jobError) {
    return NextResponse.json({ error: jobError.message }, { status: 500 })
  }

  // Call backend to start processing
  try {
    const backendResponse = await fetch(`${BACKEND_URL}/api/v1/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_id: id,
        user_id: user.id,
        storage_key: video.storage_key,
        api_key: profile.mimo_api_key,
      }),
    })

    if (!backendResponse.ok) {
      const errorData = await backendResponse.json().catch(() => ({}))
      throw new Error(errorData.detail || 'Backend processing failed')
    }
  } catch (error) {
    // Update job status to failed if backend call fails
    await supabase
      .from('processing_jobs')
      .update({ status: 'failed', error: String(error) })
      .eq('id', job.id)

    await supabase
      .from('videos')
      .update({ status: 'uploaded' })
      .eq('id', id)

    return NextResponse.json(
      { error: 'Failed to start processing. Is the backend running?' },
      { status: 500 }
    )
  }

  // Update video status
  await supabase
    .from('videos')
    .update({ status: 'queued' })
    .eq('id', id)

  return NextResponse.json({ job }, { status: 201 })
}
