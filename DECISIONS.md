# DECISIONS.md — Architecture & Design Choices

Track all significant decisions here. Format: date, decision, rationale.

---

## 2026-06-20: Tech Stack
**Decision**: Next.js 14 + React 18 + TypeScript + Tailwind CSS  
**Rationale**: Modern React ecosystem, great Vercel integration, strong TypeScript support

## 2026-06-20: Managed Services Over Self-Hosted
**Decision**: Supabase (DB+Auth), Cloudflare R2 (storage), Vercel (hosting), Cloudflare Workers (API)  
**Rationale**: Free tier friendly, scales well, less ops burden

## 2026-06-20: BYOK Model
**Decision**: All users are paid — bring your own API keys  
**Rationale**: No free-tier users on the platform, reduces our API cost burden

## 2026-06-20: Notifications via Telegram Only
**Decision**: Telegram Bot API for all notifications, no email  
**Rationale**: Simpler, cheaper, user preference

## 2026-06-20: No New MCPs
**Decision**: Stick with CLI tools for Supabase, Cloudflare, Vercel management  
**Rationale**: Existing Supabase MCP works, no standalone MCPs for others

## 2026-06-20: Agent Architecture
**Decision**: Supervisor-worker pattern. Free tier: in-process EventBus. Production: Redis Streams  
**Rationale**: Scales from free tier to production without rewriting

## 2026-06-20: PR Review Loop
**Decision**: 3 AI agents (code-quality, test-coverage, security-audit) run in parallel on PRs  
**Rationale**: Bug catch rate target 33%+ (Anthropic benchmark)

## 2026-06-20: CLI Configuration Complete
**Decision**: All CLIs configured and verified — Supabase (linked to staging), Wrangler (R2 bucket confirmed), Vercel (account verified)  
**Rationale**: Ready for Phase 1 development. All .env keys filled, no placeholders remaining.

## 2026-06-23: Apple-Style Minimalist Design
**Decision**: Adopt Apple-inspired minimalist design across the entire UI  
**Rationale**: Clean typography, lots of whitespace, subtle gray backgrounds, rounded corners, black/white/gray palette with minimal accents. Applied to landing page, auth pages, and dashboard.

## 2026-06-30: Staging Supabase Project Alignment
**Decision**: MiniOp staging uses Supabase project `vnzoksaiowqwaukmtbsi` (LittleOS Staging) with publishable/secret API keys (legacy JWT keys disabled)  
**Rationale**: CLI-linked staging project matches accessible Management API token; migration and API smoke verified end-to-end on this project

## 2026-06-30: Canonical Dashboard Path
**Decision**: Dashboard lives at `/dashboard` (not route-group `/`); landing stays public at `/`  
**Rationale**: Fixes redirect mismatch from login/callback; enables Playwright smoke tests and protected layout

## 2026-06-30: Video Upload Architecture (Phase 1)
**Decision**: Next.js API routes handle video CRUD; files go to Cloudflare R2 via `@aws-sdk/client-s3`; metadata in Supabase `videos` table with RLS  
**Rationale**: Keeps Phase 1 self-contained in `frontend/` without FastAPI dependency; validation helpers are unit-tested separately from I/O

## 2026-06-30: Playwright Smoke Gate
**Decision**: Single orchestrator `frontend/scripts/run-smoke-gate.mjs` — one production build, external `next start`, two consecutive `test:smoke:ci` passes; wired to **pre-commit**, pre-push, `npm run test:smoke:gate`, and `e2e.yml`  
**Rationale**: Eliminates flaky second-pass failures from missing `.next`; CI uses `fuser` on Linux instead of `npx kill-port`; Playwright `webServer` disabled when `PW_EXTERNAL_SERVER=1`

## 2026-07-01: Upload/Delete Storage Ordering
**Decision**: Upload writes R2 then DB with R2 cleanup on insert failure; delete removes DB row first then R2 object  
**Rationale**: Prevents orphaned R2 files on failed inserts and stale DB metadata pointing at deleted objects

## 2026-07-01: Middleware Auth Scope
**Decision**: `getUser()` runs only on `/dashboard/*` and `/api/videos/*`; unauthenticated `/dashboard` requests redirect to `/login` in middleware  
**Rationale**: Public pages skip auth roundtrip; protection is centralized before layout render

## 2026-06-30: Security Dependency Baseline
**Decision**: Frontend pins `next@14.2.35`, `vitest@3.2.6`; backend pins `fastapi@0.138.2`, `starlette@1.3.1`, `pydantic@2.11.7`; CI `npm audit --audit-level=critical` and `pip-audit` run without `continue-on-error`  
**Rationale**: Clears critical CVEs in Next.js and Vitest UI; pip-audit green on FastAPI/Starlette chain; no softened security gates

## 2026-06-28: Landing Page Messaging Alignment
**Decision**: Landing page emphasizes self-hostable open core first; managed cloud uses BYOK  
**Rationale**: Matches product vision (Docker self-host is free, no external API keys for core pipeline) and DECISIONS BYOK model for managed tiers. Pricing, hero copy, and FAQ now reflect this split.
