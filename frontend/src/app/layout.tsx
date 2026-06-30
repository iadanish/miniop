import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const viewport: Viewport = {
  themeColor: '#ffffff',
}

export const metadata: Metadata = {
  title: 'MiniOp — Open-source video clipping',
  description:
    'Turn long-form video into short-form clips. Self-hostable, API-first, and built for creators and teams.',
  openGraph: {
    title: 'MiniOp — Open-source video clipping',
    description:
      'Turn long-form video into short-form clips. Self-hostable, API-first, and built for creators and teams.',
    type: 'website',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} touch-manipulation antialiased`}>
        {children}
      </body>
    </html>
  )
}
