import { describe, expect, it } from 'vitest'
import {
  ALLOWED_VIDEO_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  buildStorageKey,
  validateVideoUpload,
} from '@/lib/upload/validation'

describe('validateVideoUpload', () => {
  it('accepts supported video files within size limits', () => {
    const result = validateVideoUpload({
      name: 'launch.mp4',
      size: 1024,
      type: ALLOWED_VIDEO_MIME_TYPES[0],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mimeType).toBe('video/mp4')
    }
  })

  it('rejects unsupported mime types', () => {
    const result = validateVideoUpload({
      name: 'notes.txt',
      size: 100,
      type: 'text/plain',
    })

    expect(result).toEqual({
      ok: false,
      error: 'Only MP4, MOV, WebM, and AVI video files are supported.',
    })
  })

  it('rejects files above the upload limit', () => {
    const result = validateVideoUpload({
      name: 'huge.mp4',
      size: MAX_UPLOAD_BYTES + 1,
      type: 'video/mp4',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('500')
    }
  })
})

describe('buildStorageKey', () => {
  it('creates a user-scoped storage key', () => {
    const key = buildStorageKey('user-123', 'My Launch Video.mp4')

    expect(key.startsWith('uploads/user-123/')).toBe(true)
    expect(key.endsWith('My_Launch_Video.mp4')).toBe(true)
  })
})