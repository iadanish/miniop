# Global memory

Cross-project user preferences and habits that persist across all projects.

## Rules

- **Session startup protocol**: Every new session must read CONTEXT.md, CLAUDE.md, TASKS.md, and DECISIONS.md before building. Never auto-build; wait for user confirmation first. [ses_13f0ad3dcffe, 2026-05-24]
- **Architecture decisions go to DECISIONS.md immediately**: When any architectural decision is made, add it to DECISIONS.md and relevant docs before proceeding. [ses_13f0ad3dcffe, 2026-05-24]
- **User manages keys from account settings, not Cloudflare**: All BYOK configuration happens from the user's account settings page. Never ask users to configure Cloudflare directly — they are non-technical end users. [ses_13f0ad3dcffe, 2026-05-24]
- **No free users**: All users are paid and bring their own API keys (BYOK). There are no free-tier users on the platform. [ses_13f0ad3dcffe, 2026-05-24]
- **Context files are authoritative**: CONTEXT.md, CLAUDE.md, TASKS.md, and DECISIONS.md are the source of truth for project state. Update them when work completes. [ses_13f0ad09fffeyg, 2026-06-02]
- **Non-technical user**: Avoid jargon, use simple explanations, show visual diagrams. Be honest about limitations. [ses_11e8a6e59ffe, 2026-06-20]

## Architecture decisions

- **Opus Clone tech stack** (2026-06-20): Next.js + React + TypeScript + Tailwind CSS. Phase-based build (5 phases, 6-11 weeks). Project at `D:\opus-clone`. [ses_11e8a6e59ffe]
- **LittleOS BYOK model** (2026-05-24): Users bring their own API keys. Pure-JS tools are public; AI tools require signup. Free model waterfall uses Gemini 2.0 Flash + CF KV rate limiting. [ses_13f0ad3dcffe]
- **DeepSeek model ID** (2026-05-24): Use `deepseek/deepseek-chat-v3-0324` on OpenRouter, not the deprecated `deepseek/deepseek-v3`. Update both seed JSON and live DB. [ses_13f0ad3dcffe]
- **External data trust model** (2026-05-24): `<external_data>` tags are ONLY for injected external content (KB docs, web pages, skill outputs). Never wrap user messages in these tags — the user IS the trusted party. [ses_13f0ad3dcffe]
- **Deploy pipeline** (2026-06-12): Push to `antigravity` branch = staging deploy. Push to `littleOS` branch = production deploy. Staging smoke test must pass before prod gate. [ses_13f0acffdffe]
- **Cloudflare Pages + Supabase** (2026-05-24): Hosting on Cloudflare Pages (free plan, 20K file limit). Auth and DB via Supabase. Cloudflare Access for Zero Trust staging protection. Turnstile for CAPTCHA. [ses_13f0acffdffe]
- **npm audit approach** (2026-06-13): Use `--audit-level=high --omit=dev` in CI. `undici` CVE in miniflare is unfixable transitive dep — override to `>=6.26.0` in root package.json. [ses_13f0acf36ffe]
- **Programmatic SEO** (2026-06-13): 15 tools × ~182 content types = 2,600+ pages. Content generated via build-time script, committed to repo. Competitor: openl.io (892K visits/mo, DA 27). [ses_13f0ae638ffe]
- **PDF structuring** (2026-06-09): Use unpdf + heuristic post-processor, not AI worker. Zero cost approach. [ses_13f0ad1a8ffe]

## Discovered durable knowledge

- **Opus Clip clone project**: User wants to build open-source version of Opus Clip (AI video clipping tool). Free tier capacity: ~200-500 clips/month. For 3000-5000 clips/month, need ~$50-100/month paid compute. Complete feature set: AI clipping (genre-based, emotion, visual, sound), captions (10+ presets), brand templates, calendar scheduling, social accounts (YouTube, TikTok, LinkedIn, Facebook, Instagram, X), analytics. Tech stack: Next.js + React + TypeScript + Tailwind CSS. Project at `D:\opus-clone`. [ses_11e8a6e59ffe, 2026-06-20]
- **LittleOS project**: Monorepo at `D:\IAD\littleOS`. `apps/web` = Next.js 15, `packages/api` = tRPC. Branch `antigravity` (staging), `littleOS` (prod). 283 sessions in DB. [multiple sessions]
- **Defending Code Reference Harness**: Separate project at `C:\Users\Muhammad Abdullah\defending-code-reference-harness`. Security scanning skills: quickstart, threat-model, vuln-scan, triage. Used for systematic vulnerability analysis. [ses_13f0aecc8ffe]
- **BYOK security hardening** (2026-06-04): `redactKey` strips API keys from error messages. Google AI probe uses `x-goog-api-key` header, not query param. SSRF guards block OAST hostnames. `persistSession: false` on service-role Supabase clients. [ses_13f0ad447ffe]
- **Marketing page auth UX** (2026-06-10): Marketing pages don't check auth state — this is by design. Session cookie survives tab close (standard persistent login). Fix was to show "Dashboard" link in nav when logged in, not redirect logic. [ses_13f0ad154ffe]
- **Cloudflare Access for staging** (2026-06-13): Access service tokens (`CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`) are separate from Turnstile. Service token bypasses Zero Trust gate for CI smoke tests. Policy created under Access → Service Auth. [ses_13f0ad9eaffe]

## Patterns

- **Jules auto-generated duplicate PRs**: The same fix (e.g., Kanban O(1) snapshot) was submitted 5+ times. Close duplicates, keep one. [ses_13f0adc4effe]
- **OpenRouter model deprecations**: Model slugs change without notice. Verify model IDs against OpenRouter docs. Fix in both seed JSON and live DB. [ses_13f0ad3dcffe]
- **Security review on every PR**: Automated security plugin flags vulnerabilities in pushed commits. Address findings in same PR or create follow-up. [ses_13f0ae453ffe]

## Gotchas

- **Node.js 20 EOL** (2026-06-16 deadline): GitHub forced migration from Node 20 to Node 24 runners. Set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'` in workflow env. [ses_13f0ad9eaffe]
- **Cloudflare Pages build caching**: No build cache configured by default. Add cache config for faster rebuilds. [ses_13f0ae24bffe]
- **Supabase performance warnings**: 111 performance advisory warnings in prod/staging. Address proactively. [ses_13f0ae34affe]
- **`pages-action@v1` → `wrangler-action@v3` migration**: `pages-action` built on Node 20, will break after June 16. Different input schema — uses `command: pages deploy` instead of `pages deploy` action inputs. [ses_13f0acffdffe]
