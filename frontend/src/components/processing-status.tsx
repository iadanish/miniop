'use client'

import { useCallback, useEffect, useState } from 'react'
import type { VideoStatusResponse } from '@/types/processing'

type ProcessingStatusProps = {
  videoId: string
  initialStatus: string
  onStatusChange: (status: string) => void
}

const STEPS = [
  { key: 'queued', label: 'Queued' },
  { key: 'audio', label: 'Extracting audio' },
  { key: 'transcribe', label: 'Transcribing' },
  { key: 'analyze', label: 'Analyzing content' },
  { key: 'clips', label: 'Generating clips' },
  { key: 'score', label: 'Scoring clips' },
  { key: 'done', label: 'Complete' },
]

export default function ProcessingStatus({
  videoId,
  initialStatus,
  onStatusChange,
}: ProcessingStatusProps) {
  const [statusData, setStatusData] = useState<VideoStatusResponse | null>(null)
  const [currentStep, setCurrentStep] = useState(0)

  const pollStatus = useCallback(async () => {
    try {
      const response = await fetch(`/api/videos/${videoId}/status`)
      if (!response.ok) return

      const data: VideoStatusResponse = await response.json()
      setStatusData(data)
      onStatusChange(data.status)

      if (data.status === 'done' || data.status === 'failed') {
        return false
      }

      const latestJob = data.jobs[0]
      if (latestJob) {
        const stepIndex = STEPS.findIndex((s) => s.key === latestJob.job_type)
        if (stepIndex >= 0) setCurrentStep(stepIndex)
      }

      return true
    } catch {
      return false
    }
  }, [videoId, onStatusChange])

  useEffect(() => {
    if (initialStatus !== 'queued' && initialStatus !== 'processing') return

    const poll = async () => {
      const shouldContinue = await pollStatus()
      if (!shouldContinue) {
        clearInterval(handle)
      }
    }

    void poll()
    const handle = setInterval(poll, 3000)

    return () => clearInterval(handle)
  }, [initialStatus, pollStatus])

  if (initialStatus !== 'queued' && initialStatus !== 'processing') {
    return null
  }

  return (
    <div className="rounded-2xl border border-gray-100 p-6" data-testid="processing-status">
      <h4 className="text-sm font-medium text-black mb-4">Processing video</h4>
      <ol className="space-y-2">
        {STEPS.map((step, index) => {
          const isComplete = index < currentStep
          const isCurrent = index === currentStep

          return (
            <li key={step.key} className="flex items-center gap-3 text-sm">
              {isComplete ? (
                <svg className="h-4 w-4 text-green-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : isCurrent ? (
                <svg className="h-4 w-4 text-black animate-spin shrink-0" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <span className="h-4 w-4 rounded-full border border-gray-200 shrink-0" />
              )}
              <span className={isComplete ? 'text-gray-400' : isCurrent ? 'text-black font-medium' : 'text-gray-400'}>
                {step.label}
              </span>
            </li>
          )
        })}
      </ol>
      {statusData?.jobs[0]?.error && (
        <p className="mt-4 text-sm text-red-600" role="alert">
          {statusData.jobs[0].error}
        </p>
      )}
    </div>
  )
}
