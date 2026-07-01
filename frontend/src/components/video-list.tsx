'use client'

import { useCallback, useEffect, useState } from 'react'

type Video = {
  id: string
  title: string
  filename: string
  status: string
  file_size_bytes: number
  created_at: string
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function VideoList() {
  const [videos, setVideos] = useState<Video[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const loadVideos = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/videos')
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error ?? `Failed to load videos (${response.status})`)
      }
      const data = await response.json()
      setVideos(data.videos ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load videos')
      setVideos([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadVideos()
  }, [loadVideos])

  async function handleDelete(id: string, title: string) {
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return

    setDeletingId(id)
    try {
      const response = await fetch(`/api/videos/${id}`, { method: 'DELETE' })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error ?? `Delete failed (${response.status})`)
      }
      setVideos((current) => current.filter((video) => video.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <section aria-labelledby="your-videos-heading" className="mt-12">
      <h3 id="your-videos-heading" className="text-xl font-semibold text-black mb-4">
        Your videos
      </h3>

      {loading && <p className="text-sm text-gray-500">Loading videos…</p>}

      {error && (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      {!loading && !error && videos.length === 0 && (
        <p className="text-sm text-gray-500">No videos yet. Upload one to get started.</p>
      )}

      {!loading && videos.length > 0 && (
        <ul className="divide-y divide-gray-100 rounded-2xl border border-gray-100" data-testid="video-list">
          {videos.map((video) => (
            <li
              key={video.id}
              className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-6 py-4"
            >
              <div>
                <p className="font-medium text-black">{video.title}</p>
                <p className="text-sm text-gray-500">
                  {video.filename} · {formatBytes(video.file_size_bytes)} · {video.status}
                </p>
              </div>
              <button
                type="button"
                data-testid={`delete-video-${video.id}`}
                disabled={deletingId === video.id}
                onClick={() => handleDelete(video.id, video.title)}
                className="inline-flex h-9 items-center justify-center rounded-full border border-gray-200 px-4 text-sm text-gray-700 transition-colors hover:border-gray-300 hover:text-black disabled:opacity-50"
              >
                {deletingId === video.id ? 'Deleting…' : 'Delete'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}