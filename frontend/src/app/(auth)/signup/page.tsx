'use client'

import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

export default function SignupPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const supabase = createClient()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          plan: 'free',
          upload_quota_seconds: 300,
        },
      },
    })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    setSuccess(true)
    setLoading(false)
  }

  if (success) {
    return (
      <div className="text-center">
        <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <svg className="w-7 h-7 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-2xl font-semibold text-black mb-2">Check your email</h1>
        <p className="text-gray-500 mb-8">
          We sent a confirmation link to <strong className="text-black">{email}</strong>
        </p>
        <Link
          href="/login"
          className="text-black font-medium hover:underline"
        >
          Back to sign in
        </Link>
      </div>
    )
  }

  return (
    <div>
      <h1 className="text-3xl font-semibold text-black mb-2">
        Create account
      </h1>
      <p className="text-gray-500 mb-10">
        Start clipping videos with AI
      </p>

      <form onSubmit={handleSubmit} className="space-y-5">
        {error && (
          <div className="bg-red-50 text-red-600 text-sm p-4 rounded-xl">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-2">
            Email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full px-4 py-3 bg-gray-50 border-0 rounded-xl text-black placeholder:text-gray-400 focus:ring-2 focus:ring-black focus:bg-white outline-none transition-all"
            placeholder="you@example.com"
          />
        </div>

        <div>
          <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-2">
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            className="w-full px-4 py-3 bg-gray-50 border-0 rounded-xl text-black placeholder:text-gray-400 focus:ring-2 focus:ring-black focus:bg-white outline-none transition-all"
            placeholder="At least 6 characters"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-black text-white py-3 rounded-full font-medium hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? 'Creating account...' : 'Create account'}
        </button>
      </form>

      <p className="mt-8 text-center text-sm text-gray-500">
        Already have an account?{' '}
        <Link href="/login" className="text-black font-medium hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  )
}
