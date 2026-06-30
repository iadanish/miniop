'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function UploadForm() {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    if (!file) {
      setError('Choose a video file to upload.')
      return
    }

    setLoading(true)

    const formData = new FormData()
    formData.append('file', file)
    if (title.trim()) {
      formData.append('title', title.trim())
    }

    const response = await fetch('/api/videos/upload', {
      method: 'POST',
      body: formData,
    })

    const payload = (await response.json()) as { error?: string }

    if (!response.ok) {
      setError(payload.error ?? 'Upload failed.')
      setLoading(false)
      return
    }

    router.push('/dashboard')
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-xl">
      {error && (
        <div className="bg-red-50 text-red-600 text-sm p-4 rounded-xl">{error}</div>
      )}

      <div>
        <label htmlFor="title" className="block text-sm font-medium text-gray-700 mb-2">
          Title
        </label>
        <input
          id="title"
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Optional title"
          className="w-full px-4 py-3 bg-gray-50 border-0 rounded-xl text-black placeholder:text-gray-400 focus:ring-2 focus:ring-black focus:bg-white outline-none transition-all"
        />
      </div>

      <div>
        <label htmlFor="video-file" className="block text-sm font-medium text-gray-700 mb-2">
          Video file
        </label>
        <input
          id="video-file"
          data-testid="video-file-input"
          type="file"
          accept="video/mp4,video/quicktime,video/webm,video/x-msvideo"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          required
          className="block w-full text-sm text-gray-600 file:mr-4 file:rounded-full file:border-0 file:bg-black file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-gray-800"
        />
        <p className="mt-2 text-sm text-gray-500">
          MP4, MOV, WebM, or AVI up to 500 MB.
        </p>
      </div>

      <button
        type="submit"
        data-testid="upload-submit"
        disabled={loading}
        className="inline-flex h-11 items-center justify-center rounded-full bg-black px-6 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {loading ? 'Uploading...' : 'Upload video'}
      </button>
    </form>
  )
}