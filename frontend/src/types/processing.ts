export type JobStatus = 'pending' | 'running' | 'completed' | 'failed'
export type JobType = 'transcribe' | 'analyze' | 'render' | 'full'

export interface ProcessingJob {
  id: string
  video_id: string
  user_id: string
  job_type: JobType
  status: JobStatus
  payload: Record<string, unknown>
  result: Record<string, unknown>
  error: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

export interface VideoStatusResponse {
  video_id: string
  status: string
  has_analysis: boolean
  has_transcription: boolean
  jobs: ProcessingJob[]
}

export interface ClipRecord {
  id: string
  video_id: string
  user_id: string
  title: string | null
  start_time: number
  end_time: number
  virality_score: number | null
  storage_key: string | null
  status: string
  hook_score: number | null
  retention_score: number | null
  quotability_score: number | null
  platform_scores: Record<string, number>
  caption_text: string | null
  suggestions: string[]
  thumbnail_storage_key: string | null
  created_at: string
  updated_at: string
}

export interface TranscriptionSegment {
  id: number
  start: number
  end: number
  text: string
  no_speech_prob: number
}

export interface Transcription {
  id: string
  video_id: string
  language: string
  duration_seconds: number
  segments: TranscriptionSegment[]
  full_text: string
}
