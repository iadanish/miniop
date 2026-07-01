export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024

export const ALLOWED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-msvideo',
] as const

export type AllowedVideoMimeType = (typeof ALLOWED_VIDEO_MIME_TYPES)[number]

export type UploadValidationResult =
  | { ok: true; mimeType: AllowedVideoMimeType }
  | { ok: false; error: string }

export function validateVideoUpload(file: {
  name: string
  size: number
  type: string
}): UploadValidationResult {
  if (!file.name.trim()) {
    return { ok: false, error: 'A file name is required.' }
  }

  if (file.size <= 0) {
    return { ok: false, error: 'The selected file is empty.' }
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `Files must be ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB or smaller.`,
    }
  }

  if (!ALLOWED_VIDEO_MIME_TYPES.includes(file.type as AllowedVideoMimeType)) {
    return {
      ok: false,
      error: 'Only MP4, MOV, WebM, and AVI video files are supported.',
    }
  }

  return { ok: true, mimeType: file.type as AllowedVideoMimeType }
}

export function buildStorageKey(userId: string, filename: string): string {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
  const timestamp = Date.now()
  return `uploads/${userId}/${timestamp}-${safeName}`
}