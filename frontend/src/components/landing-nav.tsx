'use client'

import Link from 'next/link'
import { useEffect, useId, useState } from 'react'

const navItems = [
  ['Products', '#products'],
  ['Workflow', '#workflow'],
  ['Use Cases', '#use-cases'],
  ['Pricing', '#pricing'],
  ['FAQ', '#faq'],
] as const

const linkClassName =
  'rounded-md text-sm font-medium text-gray-600 transition-colors hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2'

export default function LandingNav() {
  const [open, setOpen] = useState(false)
  const menuId = useId()

  useEffect(() => {
    if (!open) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    <nav
      aria-label="Primary"
      className="sticky top-0 z-50 border-b border-gray-100 bg-white/90 backdrop-blur-xl"
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
          aria-label="MiniOp home"
        >
          <span
            aria-hidden="true"
            className="grid h-8 w-8 place-items-center rounded-lg border border-gray-200 bg-gray-50"
          >
            <span className="h-3 w-3 rounded-sm bg-black" />
          </span>
          <span className="text-lg font-semibold text-black">MiniOp</span>
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {navItems.map(([label, href]) => (
            <a key={href} href={href} className={linkClassName}>
              {label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <a
            href="#pricing"
            className={`${linkClassName} hidden px-3 py-2 sm:inline-flex`}
          >
            Self-host
          </a>
          <Link href="/login" className={`${linkClassName} px-3 py-2`}>
            Sign In
          </Link>
          <Link
            href="/signup"
            className="rounded-full bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
          >
            Get Started
          </Link>

          <button
            type="button"
            className="ml-1 inline-flex h-10 w-10 items-center justify-center rounded-md text-black md:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
            aria-expanded={open}
            aria-controls={menuId}
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((value) => !value)}
          >
            <span aria-hidden="true" className="relative block h-3.5 w-4">
              <span
                className={`absolute left-0 top-0 block h-0.5 w-4 bg-black transition-transform ${open ? 'translate-y-1.5 rotate-45' : ''}`}
              />
              <span
                className={`absolute left-0 top-1.5 block h-0.5 w-4 bg-black transition-opacity ${open ? 'opacity-0' : ''}`}
              />
              <span
                className={`absolute left-0 top-3 block h-0.5 w-4 bg-black transition-transform ${open ? '-translate-y-1.5 -rotate-45' : ''}`}
              />
            </span>
          </button>
        </div>
      </div>

      {open ? (
        <div
          id={menuId}
          className="border-t border-gray-100 bg-white px-6 py-4 md:hidden"
        >
          <div className="flex flex-col gap-1">
            {navItems.map(([label, href]) => (
              <a
                key={href}
                href={href}
                className="rounded-md px-2 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black"
                onClick={() => setOpen(false)}
              >
                {label}
              </a>
            ))}
          </div>
        </div>
      ) : null}
    </nav>
  )
}