import { NextResponse } from 'next/server'
import { deleteObjectFromR2 } from '@/lib/r2'
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

  const { data, error } = await supabase
    .from('videos')
    .select('*')
    .eq('id', id)
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 404 })
  }

  return NextResponse.json({ video: data })
}

export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params
  const { user, supabase } = await getRouteSupabase(request)

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: video, error: fetchError } = await supabase
    .from('videos')
    .select('storage_key')
    .eq('id', id)
    .single()

  if (fetchError || !video) {
    return NextResponse.json({ error: 'Video not found.' }, { status: 404 })
  }

  const { error: deleteError } = await supabase.from('videos').delete().eq('id', id)

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 })
  }

  try {
    await deleteObjectFromR2(video.storage_key)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to delete storage object.'
    console.error('R2 delete failed after DB row removed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}