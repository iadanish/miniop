'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ClipRecord } from '@/types/processing'

type ClipsListProps = {
  videoId: string
  videoStatus: string
}

function ScoreBar({ label, score }: { label: string; score: number }) {
  const percentage = Math.round(score * 100)
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-20 text-gray-500">{label}</span>
      <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-black rounded-full transition-all"
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="w-8 text-right text-gray-700">{percentage}%</span>
    </div>
  )
}

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export default function ClipsList({ videoId, videoStatus }: ClipsListProps) {
  const [clips, setClips] = useState<ClipRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadClips = useCallback(async () => {
    if (videoStatus !== 'done') return

    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/videos/${videoId}/clips`)
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error ?? `Failed to load clips (${response.status})`)
      }
      const data = await response.json()
      setClips(data.clips ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load clips')
    } finally {
      setLoading(false)
    }
  }, [videoId, videoStatus])

  useEffect(() => {
    void loadClips()
  }, [loadClips])

  if (videoStatus !== 'done') return null

  return (
    <section aria-labelledby="clips-heading" className="mt-8">
      <h4 id="clips-heading" className="text-lg font-semibold text-black mb-4">
        Generated clips
      </h4>

      {loading && <p className="text-sm text-gray-500">Loading clips…</p>}

      {error && (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      {!loading && !error && clips.length === 0 && (
        <p className="text-sm text-gray-500">No clips generated yet.</p>
      )}

      {!loading && clips.length > 0 && (
        <ul className="space-y-4" data-testid="clips-list">
          {clips.map((clip) => (
            <li
              key={clip.id}
              className="rounded-2xl border border-gray-100 p-5"
            >
              <div className="flex items-start justify-between gap-4 mb-3">
                <div>
                  <p className="font-medium text-black">
                    {clip.title ?? `${formatTime(clip.start_time)} – ${formatTime(clip.end_time)}`}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {formatTime(clip.start_time)} – {formatTime(clip.end_time)} ·{' '}
                    {(clip.end_time - clip.start_time).toFixed(1)}s
                  </p>
                </div>
                <div className="text-right">
                  <span className="inline-flex items-center rounded-full bg-black px-3 py-1 text-xs font-medium text-white">
                    {clip.virality_score != null
                      ? `${Math.round(clip.virality_score * 100)}%`
                      : '—'}
                  </span>
                </div>
              </div>

              {clip.hook_score != null && (
                <div className="space-y-1.5 mb-3">
                  <ScoreBar label="Hook" score={clip.hook_score} />
                  <ScoreBar label="Retention" score={clip.retention_score ?? 0} />
                  <ScoreBar label="Quotes" score={clip.quotability_score ?? 0} />
                </div>
              )}

              {clip.platform_scores && Object.keys(clip.platform_scores).length > 0 && (
                <div className="flex gap-2 mt-3">
                  {Object.entries(clip.platform_scores).map(([platform, score]) => (
                    <span
                      key={platform}
                      className="inline-flex items-center rounded-full border border-gray-200 px-2.5 py-0.5 text-xs text-gray-600 capitalize"
                    >
                      {platform}: {Math.round(score * 100)}%
                    </span>
                  ))}
                </div>
              )}

              {clip.suggestions && clip.suggestions.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {clip.suggestions.map((suggestion, i) => (
                    <li key={i} className="text-xs text-gray-500 flex items-start gap-1.5">
                      <span className="text-gray-300 mt-0.5">•</span>
                      {suggestion}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
