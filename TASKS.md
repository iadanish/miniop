# TASKS.md — Active Work

## Status Legend
- `[ ]` Not started
- `[~]` In progress
- `[x]` Done
- `[!]` Blocked

---

## Phase 1: Foundation
> Get a working Next.js app with auth and basic UI

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1.1 | Create context files (CONTEXT, TASKS, DECISIONS, CLAUDE) | [x] | Created in ses_11aea9b32ffe |
| 1.2 | Set up Next.js with App Router, Tailwind, TypeScript | [x] | Already scaffolded |
| 1.3 | Configure all CLIs and .env (Supabase, R2, Vercel, Cloudflare) | [x] | gh/wrangler/vercel/supabase OK; `ANTHROPIC_API_KEY` optional (auto-decision skips) |
| 1.4 | Add Supabase auth (login/signup/logout) | [x] | Email/password auth with @supabase/ssr, split layout, middleware |
| 1.5 | Create landing page + Apple-style design | [x] | Landing page audited: mobile nav, a11y, FAQ accordion, doc-aligned copy |
| 1.6 | Create dashboard layout | [x] | `/dashboard` route with nav, stats from DB, upload CTA |
| 1.7 | Build video upload page | [x] | `/dashboard/upload` with validation + R2-backed API |
| 1.8 | Set up Supabase database schema (users, videos, clips) | [x] | Migration applied to staging `vnzoksaiowqwaukmtbsi`; profiles/videos/clips tables + RLS verified |
| 1.9 | Basic API routes for video CRUD | [x] | `/api/videos`, `/api/videos/upload`, `/api/videos/[id]` |
| 1.10 | Playwright smoke tests + pre-push gate | [x] | 5 smoke specs, 2 consecutive green runs |

## Phase 2: AI Pipeline
> Video analysis and clip generation

| # | Task | Status | Notes |
|---|------|--------|-------|
| 2.1 | Whisper transcription integration | [ ] | |
| 2.2 | Scene detection + virality scoring | [ ] | |
| 2.3 | Clip extraction with FFmpeg | [ ] | |
| 2.4 | Caption generation | [ ] | |

## Phase 3: Brand & Social
> Templates and social media posting

| # | Task | Status | Notes |
|---|------|--------|-------|
| 3.1 | Brand template system | [ ] | |
| 3.2 | Social media integrations | [ ] | |
| 3.3 | Notion sync (fix existing) | [x] | 135 docs synced via scripts/notion-sync.mjs |

---

## Next Action
**2.1** — Whisper transcription integration (Phase 2)