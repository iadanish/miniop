import Link from 'next/link'

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="px-6 py-6">
        <Link href="/" className="text-xl font-semibold text-black">
          MiniOp
        </Link>
      </header>
      <main className="flex-1 flex items-center justify-center px-6 pb-20">
        <div className="w-full max-w-sm">
          {children}
        </div>
      </main>
    </div>
  )
}
