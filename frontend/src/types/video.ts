export type VideoStatus =
  | 'uploaded'
  | 'queued'
  | 'processing'
  | 'done'
  | 'failed'

export interface VideoRecord {
  id: string
  user_id: string
  title: string
  filename: string
  storage_key: string
  mime_type: string
  file_size_bytes: number
  duration_seconds: number | null
  status: VideoStatus
  created_at: string
  updated_at: string
}