import { NextResponse } from 'next/server'
import { uploadObjectToR2 } from '@/lib/r2'
import {
  buildStorageKey,
  validateVideoUpload,
} from '@/lib/upload/validation'
import { getRouteSupabase } from '@/lib/supabase/route-auth'

export async function POST(request: Request) {
  const { user, supabase } = await getRouteSupabase(request)

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const formData = await request.formData()
  const file = formData.get('file')
  const titleValue = formData.get('title')

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'A video file is required.' }, { status: 400 })
  }

  const validation = validateVideoUpload({
    name: file.name,
    size: file.size,
    type: file.type,
  })

  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 })
  }

  const title =
    typeof titleValue === 'string' && titleValue.trim()
      ? titleValue.trim()
      : file.name

  const storageKey = buildStorageKey(user.id, file.name)
  const buffer = Buffer.from(await file.arrayBuffer())

  try {
    await uploadObjectToR2({
      key: storageKey,
      body: buffer,
      contentType: validation.mimeType,
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to upload to storage.'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  const { data, error } = await supabase
    .from('videos')
    .insert({
      user_id: user.id,
      title,
      filename: file.name,
      storage_key: storageKey,
      mime_type: validation.mimeType,
      file_size_bytes: file.size,
      status: 'uploaded',
    })
    .select('*')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ video: data }, { status: 201 })
}