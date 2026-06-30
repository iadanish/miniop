import Link from 'next/link'
import { redirect } from 'next/navigation'
import LandingFooter from '@/components/landing-footer'
import LandingNav from '@/components/landing-nav'
import { createClient } from '@/lib/supabase/server'

const formatPills = ['Whisper', 'FFmpeg', '9:16', 'API', 'Self-host']

const outputRows = [
  ['01', 'Hook: This changed our whole launch plan', '96%', '00:48'],
  ['02', 'Proof: Customers watched twice as long', '91%', '12:04'],
  ['03', 'Payoff: The exact clip structure', '88%', '27:31'],
] as const

const audienceTypes = [
  'Solo creators',
  'Marketing teams',
  'Podcasters',
  'Course creators',
  'Media teams',
  'Agencies',
] as const

const products = [
  [
    'Search',
    'Find strong moments across transcripts with hook, quote, and topic signals.',
  ],
  [
    'Score',
    'Rank every candidate clip with virality, retention, visual, and platform metrics.',
  ],
  [
    'Render',
    'Generate captioned clips with FFmpeg presets for TikTok, Reels, Shorts, and LinkedIn.',
  ],
] as const

const features = [
  [
    'Self-hostable by default',
    'Run the full pipeline on your own machine or VPS with Docker. No external API keys required for core transcription and rendering.',
  ],
  [
    'Reliable on long videos',
    'Chunk uploads, cache transcripts, recover failed jobs, and keep the source file in object storage.',
  ],
  [
    'Speed you can see',
    'Show progress through upload, transcription, analysis, ranking, rendering, and delivery.',
  ],
  [
    'Open source core',
    'Apache 2.0 engine for upload, transcription, clip analysis, captions, FFmpeg rendering, and API access.',
  ],
] as const

const pipeline = [
  [
    'Whisper transcription',
    'Timestamped words and segments become the base layer for scoring and captions.',
  ],
  [
    'Scene-aware boundaries',
    'PySceneDetect and transcript sentence endings keep cuts from feeling random.',
  ],
  [
    'Virality scoring',
    'Hook strength, retention architecture, quote density, face presence, emotion, and platform fit.',
  ],
  [
    'Caption styles',
    'Readable defaults plus brand-ready styles, word timing, and export presets.',
  ],
  [
    'Multi-ratio output',
    'Render 9:16, 16:9, 1:1, and 4:5 clips with crop strategies for each channel.',
  ],
  [
    'API workflows',
    'Create videos, queue jobs, render clips, and generate download URLs from REST endpoints.',
  ],
] as const

const useCases = [
  [
    'Podcast clipping',
    'Turn a two-hour episode into ranked clips with titles, captions, and vertical exports.',
  ],
  [
    'Webinar repurposing',
    'Find the highest-signal lessons, objections, and product moments from long sessions.',
  ],
  [
    'Course marketing',
    'Pull short lessons and quotable moments from educational content without manual scrubbing.',
  ],
  [
    'Media workflows',
    'Keep footage in your infrastructure and connect custom scoring models or MAM systems.',
  ],
] as const

const pricing = [
  {
    name: 'Self-hosted',
    price: '$0',
    description:
      'Run the open-source core on your own machine or infrastructure.',
    cta: 'View setup',
    href: '#workflow',
    highlight: false,
    items: [
      'Unlimited local processing',
      'Whisper + FFmpeg pipeline',
      'REST API and web UI',
    ],
  },
  {
    name: 'Managed Pro',
    price: '$29/mo',
    description:
      'Hosted GPU workflow for creators and small teams. Bring your own API keys.',
    cta: 'Get Started',
    href: '/signup',
    highlight: true,
    items: [
      '10 processing hours',
      'Team workspace',
      'Advanced captions',
    ],
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    description:
      'Dedicated cloud or self-hosted deployment for scale and compliance.',
    cta: 'Contact sales',
    href: 'mailto:hello@miniop.dev',
    highlight: false,
    items: [
      'SSO and audit logs',
      'Custom scoring models',
      'SLA and support',
    ],
  },
] as const

const faqs = [
  [
    'What is MiniOp?',
    'MiniOp is an open-source video repurposing platform that finds the best moments in long-form video and renders them as short-form clips.',
  ],
  [
    'Is it a full video editor?',
    'No. MiniOp automates clipping, captions, scoring, crops, and exports. You still use a traditional editor for heavy creative work.',
  ],
  [
    'Can I self-host it?',
    'Yes. Self-hosting and data control are core to MiniOp. Run it locally with Docker, or use managed cloud when you want convenience or GPU scale.',
  ],
  [
    'How is it different from Opus Clip?',
    'MiniOp is open source, API-first, self-hostable, and built for users who care about cost control and infrastructure ownership.',
  ],
] as const

const sectionClassName = 'scroll-mt-20'

const ctaClassName =
  'inline-flex h-11 items-center justify-center rounded-full bg-black px-6 text-sm font-medium text-white transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2'

const secondaryCtaClassName =
  'inline-flex h-11 items-center justify-center rounded-full px-6 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2'

export default async function Home() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) {
    redirect('/dashboard')
  }

  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-black focus:px-4 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to main content
      </a>

      <div className="min-h-screen bg-white text-black">
        <div className="border-b border-gray-100 bg-gray-50 px-6 py-2.5 text-center text-sm text-gray-600">
          Open-source clipping engine for long-form creators.{' '}
          <a
            href="#workflow"
            className="font-medium text-black underline underline-offset-4 transition-colors hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2"
          >
            See the pipeline
          </a>
        </div>

        <LandingNav />

        <main id="main-content">
          <section className="px-6 pb-20 pt-16 lg:pb-24">
            <div className="mx-auto max-w-6xl">
              <div className="mx-auto flex max-w-3xl flex-wrap justify-center gap-2">
                {formatPills.map((pill) => (
                  <span
                    key={pill}
                    className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-medium text-gray-600"
                  >
                    {pill}
                  </span>
                ))}
              </div>

              <div className="mx-auto mt-10 max-w-4xl text-center">
                <h1 className="text-balance text-5xl font-semibold tracking-tight text-black sm:text-6xl lg:text-7xl">
                  Turn long-form video into clips that ship
                </h1>
                <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-8 text-gray-500">
                  MiniOp transcribes, scores, captions, and renders short-form
                  clips from long-form video. Open source, self-hostable, and
                  built for teams who want control over their media.
                </p>
                <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                  <Link href="/signup" className={ctaClassName}>
                    Get Started
                  </Link>
                  <a href="#products" className={secondaryCtaClassName}>
                    Explore the toolkit
                  </a>
                </div>
              </div>

              <div
                aria-label="Example clip pipeline output"
                className="mx-auto mt-14 max-w-5xl overflow-hidden rounded-3xl border border-gray-200 bg-gray-950 shadow-xl"
              >
                <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                  <div className="flex items-center gap-2" aria-hidden="true">
                    <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
                    <span className="h-3 w-3 rounded-full bg-[#ffbd2e]" />
                    <span className="h-3 w-3 rounded-full bg-[#28c840]" />
                  </div>
                  <p className="font-mono text-xs text-white/50">pipeline.json</p>
                </div>

                <div className="grid gap-0 lg:grid-cols-[1fr_380px]">
                  <div className="border-b border-white/10 p-5 lg:border-b-0 lg:border-r">
                    <pre className="overflow-x-auto font-mono text-sm leading-7 text-white/80">
                      <code>{`{
  "video": "founder-interview.mp4",
  "pipeline": ["upload", "transcribe", "analyze", "render"],
  "outputs": [
    { "clip": "Hook: This changed our whole launch plan", "score": "96%", "start": "00:48" },
    { "clip": "Proof: Customers watched twice as long", "score": "91%", "start": "12:04" },
    { "clip": "Payoff: The exact clip structure", "score": "88%", "start": "27:31" }
  ]
}`}</code>
                    </pre>
                  </div>

                  <div className="bg-gray-900 p-5">
                    <p className="font-mono text-xs uppercase tracking-wide text-emerald-300">
                      Rendering…
                    </p>
                    <div className="mt-4 space-y-3">
                      {outputRows.map(([id, title, score, time]) => (
                        <div
                          key={id}
                          className="rounded-2xl border border-white/10 bg-white/[0.04] p-4"
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-white">
                                {title}
                              </p>
                              <p className="mt-1 font-mono text-xs text-white/45">
                                {time} · vertical export
                              </p>
                            </div>
                            <span className="shrink-0 rounded-md bg-white px-2 py-1 font-mono text-xs font-semibold tabular-nums text-black">
                              {score}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div className="mx-auto mt-14 max-w-5xl text-center">
                <p className="text-sm font-medium text-gray-400">
                  Built for video teams of all sizes
                </p>
                <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  {audienceTypes.map((item) => (
                    <div
                      key={item}
                      className="rounded-2xl border border-gray-100 bg-gray-50 px-3 py-4 text-sm font-medium text-gray-600"
                    >
                      {item}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section
            id="products"
            className={`border-y border-gray-100 bg-gray-50 px-6 py-20 ${sectionClassName}`}
          >
            <div className="mx-auto max-w-6xl">
              <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
                <div>
                  <p className="text-sm font-medium text-gray-400">Developer first</p>
                  <h2 className="mt-4 max-w-md text-balance text-4xl font-semibold tracking-tight text-black sm:text-5xl">
                    Start clipping today
                  </h2>
                  <p className="mt-5 max-w-md text-base leading-7 text-gray-500">
                    MiniOp is a simple surface over a serious video pipeline.
                    Search moments, score candidates, and render clips with the
                    same API your dashboard uses.
                  </p>
                </div>
                <div className="grid gap-4 md:grid-cols-3">
                  {products.map(([title, body]) => (
                    <div
                      key={title}
                      className="rounded-2xl border border-gray-100 bg-white p-6"
                    >
                      <h3 className="text-lg font-semibold text-black">{title}</h3>
                      <p className="mt-3 text-sm leading-6 text-gray-500">{body}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-10 overflow-hidden rounded-2xl border border-gray-200 bg-gray-950">
                <div className="border-b border-white/10 px-5 py-3">
                  <p className="font-mono text-xs text-white/50">Python SDK</p>
                </div>
                <pre className="overflow-x-auto p-5 text-sm leading-7 text-white/80">
                  <code>{`from miniop import MiniOp

app = MiniOp(api_key="mo-YOUR_API_KEY")

job = app.videos.create(source="founder-interview.mp4")
clips = app.clips.rank(job.id, platform="tiktok")
app.clips.render(clips[0].id, aspect_ratio="9:16")`}</code>
                </pre>
              </div>
            </div>
          </section>

          <section
            id="workflow"
            className={`border-b border-gray-100 px-6 py-20 ${sectionClassName}`}
          >
            <div className="mx-auto max-w-6xl">
              <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr]">
                <div>
                  <p className="text-sm font-medium text-gray-400">Core workflow</p>
                  <h2 className="mt-4 max-w-lg text-balance text-4xl font-semibold tracking-tight text-black sm:text-5xl">
                    Fast, reliable, and self-hostable
                  </h2>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  {features.map(([title, body]) => (
                    <div
                      key={title}
                      className="rounded-2xl border border-gray-100 bg-gray-50 p-6"
                    >
                      <h3 className="text-lg font-semibold text-black">{title}</h3>
                      <p className="mt-3 text-sm leading-6 text-gray-500">{body}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="border-b border-gray-100 bg-gray-50 px-6 py-20">
            <div className="mx-auto max-w-6xl">
              <div className="max-w-2xl">
                <p className="text-sm font-medium text-gray-400">Pipeline</p>
                <h2 className="mt-4 text-balance text-4xl font-semibold tracking-tight text-black sm:text-5xl">
                  We handle the hard stuff
                </h2>
                <p className="mt-5 text-base leading-7 text-gray-500">
                  The default workflow is upload, generate, export. Advanced
                  controls stay available for teams that need deeper automation.
                </p>
              </div>
              <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {pipeline.map(([title, body]) => (
                  <div
                    key={title}
                    className="rounded-2xl border border-gray-100 bg-white p-6"
                  >
                    <h3 className="text-lg font-semibold text-black">{title}</h3>
                    <p className="mt-3 text-sm leading-6 text-gray-500">{body}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section
            id="use-cases"
            className={`border-b border-gray-100 px-6 py-20 ${sectionClassName}`}
          >
            <div className="mx-auto max-w-6xl">
              <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr]">
                <div>
                  <p className="text-sm font-medium text-gray-400">Use cases</p>
                  <h2 className="mt-4 max-w-md text-balance text-4xl font-semibold tracking-tight text-black sm:text-5xl">
                    Transform video into distribution
                  </h2>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  {useCases.map(([title, body]) => (
                    <div
                      key={title}
                      className="rounded-2xl border border-gray-100 bg-gray-50 p-6"
                    >
                      <h3 className="text-lg font-semibold text-black">{title}</h3>
                      <p className="mt-3 text-sm leading-6 text-gray-500">{body}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section
            id="pricing"
            className={`border-b border-gray-100 bg-gray-50 px-6 py-20 ${sectionClassName}`}
          >
            <div className="mx-auto max-w-6xl">
              <p className="text-sm font-medium text-gray-400">Pricing</p>
              <h2 className="mt-4 max-w-2xl text-balance text-4xl font-semibold tracking-tight text-black sm:text-5xl">
                Start free. Pay when convenience or scale matters.
              </h2>
              <p className="mt-5 max-w-2xl text-base leading-7 text-gray-500">
                Self-hosting stays free forever. Managed cloud uses a BYOK model
                so you control API spend.
              </p>
              <div className="mt-10 grid gap-4 lg:grid-cols-3">
                {pricing.map((tier) => (
                  <div
                    key={tier.name}
                    className={`flex flex-col rounded-2xl border p-6 ${
                      tier.highlight
                        ? 'border-black bg-white shadow-sm'
                        : 'border-gray-100 bg-white'
                    }`}
                  >
                    <h3 className="text-lg font-semibold text-black">{tier.name}</h3>
                    <p className="mt-4 text-4xl font-semibold tabular-nums text-black">
                      {tier.price}
                    </p>
                    <p className="mt-3 text-sm leading-6 text-gray-500">
                      {tier.description}
                    </p>
                    <ul className="mt-6 flex-1 space-y-3">
                      {tier.items.map((item) => (
                        <li
                          key={item}
                          className="flex gap-3 text-sm text-gray-600"
                        >
                          <span
                            aria-hidden="true"
                            className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-black"
                          />
                          {item}
                        </li>
                      ))}
                    </ul>
                    <a
                      href={tier.href}
                      className={`mt-8 inline-flex h-11 items-center justify-center rounded-full px-5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 ${
                        tier.highlight
                          ? 'bg-black text-white hover:bg-gray-800'
                          : 'border border-gray-200 text-black hover:bg-gray-50'
                      }`}
                    >
                      {tier.cta}
                    </a>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section
            id="faq"
            className={`px-6 py-20 ${sectionClassName}`}
          >
            <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[0.85fr_1.15fr]">
              <div>
                <p className="text-sm font-medium text-gray-400">FAQ</p>
                <h2 className="mt-4 text-balance text-4xl font-semibold tracking-tight text-black sm:text-5xl">
                  Frequently asked questions
                </h2>
                <Link href="/signup" className={`${ctaClassName} mt-8`}>
                  Get Started
                </Link>
              </div>
              <div className="divide-y divide-gray-100 rounded-2xl border border-gray-100 bg-gray-50">
                {faqs.map(([question, answer]) => (
                  <details key={question} className="group p-6">
                    <summary className="cursor-pointer list-none text-lg font-semibold text-black marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
                      <span className="flex items-center justify-between gap-4">
                        {question}
                        <span
                          aria-hidden="true"
                          className="text-gray-400 transition-transform group-open:rotate-45"
                        >
                          +
                        </span>
                      </span>
                    </summary>
                    <p className="mt-4 text-sm leading-6 text-gray-500">{answer}</p>
                  </details>
                ))}
              </div>
            </div>
          </section>
        </main>

        <LandingFooter />
      </div>
    </>
  )
}