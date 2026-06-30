# CONTEXT.md — Project State

## What is MiniOp?
MiniOp is an open-source Opus Clip clone — an AI-powered video clipping tool. Users upload videos, AI analyzes and selects the best moments, generates clips with captions and brand templates, then posts to social media. BYOK model (users bring their own API keys).

## Current State (2026-06-30)
- **135 docs** across 20+ categories — documentation complete
- **Phase 1 foundation shipped** — auth, landing, dashboard at `/dashboard`, video upload UI, video CRUD API routes, R2 upload integration, Playwright smoke suite
- **Auth complete** — Supabase Auth with email/password, login/signup/logout, middleware, protected dashboard
- **Landing page complete** — Apple-style minimalist marketing page with hero, pipeline demo, product sections, pricing, FAQ, and footer
- **Apple-style design system** — White/gray/black palette, generous spacing, rounded-full CTAs; applied across landing, auth, and dashboard pages
- **Playwright smoke tests** — `frontend/tests/smoke/` covers landing, login, and authenticated dashboard; gated on pre-push
- **All CLIs configured and verified:**
  - Supabase CLI: logged in via access token, linked to staging (`gjeymxxhrggsxytzbiur`)
  - Wrangler CLI: connected, R2 bucket `miniops` confirmed
  - Vercel CLI: connected (`liquidfinance` account)
- **All .env keys filled** — no placeholders remaining
- CI/CD configured: lint-staged, commitlint, husky pre-commit hooks
- Notion integration complete — 135 docs synced to Notion workspace

## Tech Stack
- **Frontend**: Next.js 14 + React 18 + TypeScript + Tailwind CSS
- **Backend**: Python (FastAPI planned)
- **Database**: Supabase (PostgreSQL + Auth)
- **Storage**: Cloudflare R2 (bucket: `miniops`)
- **Hosting**: Vercel (frontend), Cloudflare Workers (API)
- **AI/ML**: Whisper transcription, scene detection, virality scoring
- **Notifications**: Telegram Bot API primary, Resend email backup

## Key Files
- `frontend/src/app/page.tsx` — Landing page (hero, pipeline demo, products, workflow, pricing, FAQ)
- `frontend/src/components/landing-nav.tsx` — Sticky nav with mobile menu
- `frontend/src/components/landing-footer.tsx` — Footer with product and GitHub links
- `frontend/src/app/(auth)/` — Login/signup pages (Apple-style design)
- `frontend/src/app/dashboard/` — Dashboard shell, stats, upload page at `/dashboard/upload`
- `frontend/src/app/api/videos/` — Video list/create/upload/delete API routes
- `frontend/tests/smoke/` — Playwright smoke specs
- `supabase/migrations/` — profiles, videos, clips schema with RLS
- `frontend/` — Next.js app
- `backend/` — Python backend (skeleton only)
- `worker/` — Cloudflare Worker
- `docs/` — 135 documentation files
- `skills/` — Codex skill definitions
- `.env` — All environment variables filled (Supabase, R2, Vercel, Cloudflare, Telegram, Notion, Resend)

## Free Tier Targets
- GPU: Google Colab (15 hrs/wk) → Kaggle (30 hrs/wk)
- Storage: Cloudflare R2 (10GB free)
- DB: Supabase (500MB free)
- Hosting: Vercel (hobby tier)
- API: Cloudflare Workers (100K req/day)
- Target: 200-500 clips/month on free tier
