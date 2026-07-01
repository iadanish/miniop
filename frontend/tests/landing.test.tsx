import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'

const { redirectMock, getUserMock } = vi.hoisted(() => ({
  redirectMock: vi.fn(),
  getUserMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  redirect: redirectMock,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: getUserMock,
    },
  }),
}))

import Home from '../src/app/page'

describe('Landing page', () => {
  beforeEach(() => {
    redirectMock.mockReset()
    getUserMock.mockReset()
    getUserMock.mockResolvedValue({ data: { user: null } })
  })

  it('renders the hero headline', async () => {
    const page = await Home()
    render(page)

    expect(
      screen.getByRole('heading', {
        name: /turn long-form video into clips that ship/i,
      }),
    ).toBeDefined()
  })

  it('renders primary navigation links', async () => {
    const page = await Home()
    render(page)

    const nav = screen.getByRole('navigation', { name: /primary/i })
    expect(nav).toBeDefined()
    expect(
      within(nav).getByRole('link', { name: /^get started$/i }),
    ).toBeDefined()
    expect(within(nav).getByRole('link', { name: /sign in/i })).toBeDefined()
  })

  it('renders pricing and faq sections', async () => {
    const page = await Home()
    render(page)

    expect(
      screen.getByRole('heading', {
        name: /start free\. pay when convenience or scale matters/i,
      }),
    ).toBeDefined()
    expect(
      screen.getByRole('heading', { name: /frequently asked questions/i }),
    ).toBeDefined()
    expect(screen.getByText(/self-hosting stays free forever/i)).toBeDefined()
  })

  it('redirects signed-in users to the dashboard', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { email: 'creator@example.com' } },
    })

    await Home()

    expect(redirectMock).toHaveBeenCalledWith('/dashboard')
  })
})