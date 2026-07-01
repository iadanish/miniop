import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import LogoutButton from './logout-button'

const navItems = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/upload', label: 'Upload' },
] as const

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <Link href="/dashboard" className="text-xl font-semibold text-black">
              MiniOp
            </Link>
            <nav aria-label="Dashboard" className="hidden sm:flex items-center gap-6">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-sm text-gray-500 hover:text-black transition-colors"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-6">
            <span className="text-sm text-gray-500">{user.email}</span>
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-6 py-10">{children}</main>
    </div>
  )
}