'use client'

import { useState } from 'react'

type ProcessButtonProps = {
  videoId: string
  status: string
  onProcessingStart: () => void
}

export default function ProcessButton({ videoId, status, onProcessingStart }: ProcessButtonProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canProcess = status === 'uploaded' || status === 'done' || status === 'failed'
  const isProcessing = status === 'queued' || status === 'processing'

  async function handleProcess() {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch(`/api/videos/${videoId}/process`, {
        method: 'POST',
      })

      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error ?? `Processing failed (${response.status})`)
      }

      onProcessingStart()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start processing')
    } finally {
      setLoading(false)
    }
  }

  if (isProcessing) {
    return (
      <span className="inline-flex h-9 items-center justify-center rounded-full bg-gray-100 px-4 text-sm text-gray-500">
        <svg className="mr-2 h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Processing…
      </span>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        data-testid={`process-video-${videoId}`}
        disabled={!canProcess || loading}
        onClick={handleProcess}
        className="inline-flex h-9 items-center justify-center rounded-full bg-black px-4 text-sm text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
      >
        {loading ? 'Starting…' : status === 'done' ? 'Re-process' : 'Process'}
      </button>
      {error && (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
