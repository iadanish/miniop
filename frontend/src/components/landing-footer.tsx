import Link from 'next/link'

const productLinks = [
  ['Products', '#products'],
  ['Workflow', '#workflow'],
  ['Use Cases', '#use-cases'],
  ['Pricing', '#pricing'],
  ['FAQ', '#faq'],
] as const

export default function LandingFooter() {
  return (
    <footer className="border-t border-gray-100 bg-gray-50">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-14 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="grid h-8 w-8 place-items-center rounded-lg border border-gray-200 bg-white"
            >
              <span className="h-3 w-3 rounded-sm bg-black" />
            </span>
            <span className="text-base font-semibold text-black">MiniOp</span>
          </div>
          <p className="mt-4 max-w-sm text-sm leading-6 text-gray-500">
            Open-source video repurposing for creators and teams who want clean
            clips without giving up control of their media.
          </p>
        </div>

        <div>
          <p className="text-sm font-semibold text-black">Product</p>
          <div className="mt-4 space-y-3 text-sm text-gray-500">
            {productLinks.map(([label, href]) => (
              <a
                key={href}
                href={href}
                className="block rounded-sm transition-colors hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
              >
                {label}
              </a>
            ))}
          </div>
        </div>

        <div>
          <p className="text-sm font-semibold text-black">Get Started</p>
          <div className="mt-4 space-y-3 text-sm text-gray-500">
            <Link
              href="/signup"
              className="block rounded-sm transition-colors hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
            >
              Create Account
            </Link>
            <Link
              href="/login"
              className="block rounded-sm transition-colors hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
            >
              Sign In
            </Link>
            <a
              href="https://github.com/miniop/miniop"
              className="block rounded-sm transition-colors hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
              rel="noopener noreferrer"
              target="_blank"
            >
              GitHub
            </a>
          </div>
        </div>
      </div>

      <div className="border-t border-gray-100">
        <p className="mx-auto max-w-6xl px-6 py-6 text-sm text-gray-400">
          © {new Date().getFullYear()} MiniOp. Apache 2.0 open core.
        </p>
      </div>
    </footer>
  )
}