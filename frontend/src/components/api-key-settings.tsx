'use client'

import { useCallback, useEffect, useState } from 'react'

export default function ApiKeySettings() {
  const [hasKey, setHasKey] = useState(false)
  const [maskedKey, setMaskedKey] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const loadKeyStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/settings/api-keys')
      if (!response.ok) return

      const data = await response.json()
      setHasKey(data.has_key)
      setMaskedKey(data.masked_key)
    } catch {
      // Silent fail on load
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadKeyStatus()
  }, [loadKeyStatus])

  async function handleSave() {
    if (!apiKey.trim()) return

    setSaving(true)
    setError(null)
    setSuccess(false)

    try {
      const response = await fetch('/api/settings/api-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey.trim() }),
      })

      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error ?? `Failed to save key (${response.status})`)
      }

      setSuccess(true)
      setHasKey(true)
      setApiKey('')
      void loadKeyStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save key')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-gray-100 p-6">
        <p className="text-sm text-gray-500">Loading API key settings…</p>
      </div>
    )
  }

  return (
    <section aria-labelledby="api-key-heading" className="rounded-2xl border border-gray-100 p-6">
      <h4 id="api-key-heading" className="text-sm font-medium text-black mb-2">
        MiMo API Key
      </h4>
      <p className="text-xs text-gray-500 mb-4">
        Required for video processing. Get your key from{' '}
        <a
          href="https://platform.xiaomimimo.com"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-black"
        >
          platform.xiaomimimo.com
        </a>
      </p>

      {hasKey && maskedKey && (
        <p className="text-sm text-gray-600 mb-3">
          Current key: <code className="font-mono text-xs bg-gray-50 px-1.5 py-0.5 rounded">{maskedKey}</code>
        </p>
      )}

      <div className="flex gap-2">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasKey ? 'Enter new key to replace…' : 'Paste your MiMo API key…'}
          className="flex-1 rounded-full border border-gray-200 px-4 py-2 text-sm outline-none focus:border-gray-400 focus:ring-0"
          data-testid="api-key-input"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !apiKey.trim()}
          className="inline-flex h-9 items-center justify-center rounded-full bg-black px-4 text-sm text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
          data-testid="save-api-key"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}

      {success && (
        <p className="mt-2 text-xs text-green-600">
          API key saved successfully.
        </p>
      )}
    </section>
  )
}
