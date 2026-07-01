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

## 2026-07-01: MiniOp-Only Boundary

**Decision**: All agent work stays inside `D:\minio-project` using MiniOp-owned `.env` credentials only. No access to other repos, Supabase projects, or Vercel teams unless the user explicitly requests it.  
**Rationale**: Strict project isolation — one repo, one set of cloud credentials.

## 2026-07-01: MiniOp Supabase Staging + Prod

**Decision**: Two Supabase projects in `.env` — staging `gjeymxxhrggsxytzbiur` (local dev), prod `pycaruihndpxznvxuqdk` (live). Active `NEXT_PUBLIC_*` vars mirror staging.  
**Rationale**: Clear separation for dev vs production; connection checks via `scripts/check-connections.mjs`

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
**Rationale**: UI reads from DB — stale rows are worse than orphan R2 blobs; if R2 cleanup fails after DB delete, API returns `{ success: true, warning: 'storage_cleanup_pending' }` and logs the orphan key

## 2026-07-01: Canonical Verification Runner

**Decision**: `run-verification-plan.mjs` owns plan steps 1–7 with fixed log filenames; `run-smoke-gate.mjs` writes only `smoke-gate-run-*.log`  
**Rationale**: Separates pre-commit gate evidence from plan-prescribed `npm run dev` + playwright logs in `smoke-run-*.log`

## 2026-07-01: Smoke Auth WebSocket Transport

**Decision**: `smoke-auth.ts` passes `ws` as Supabase realtime transport (same as `global-setup.ts`)  
**Rationale**: Node 20 CI lacks browser WebSocket; without `ws`, API CRUD and video-crud-ui specs fail sign-in

## 2026-07-01: Middleware Auth Scope

**Decision**: `getUser()` runs only on `/dashboard/*` and `/api/videos/*`; unauthenticated `/dashboard` requests redirect to `/login` in middleware  
**Rationale**: Public pages skip auth roundtrip; protection is centralized before layout render

## 2026-06-30: Security Dependency Baseline

**Decision**: Frontend pins `next@14.2.35`, `vitest@3.2.6`; backend pins `fastapi@0.138.2`, `starlette@1.3.1`, `pydantic@2.11.7`; CI `npm audit --audit-level=critical` and `pip-audit` run without `continue-on-error`  
**Rationale**: Clears critical CVEs in Next.js and Vitest UI; pip-audit green on FastAPI/Starlette chain; no softened security gates

## 2026-06-28: Landing Page Messaging Alignment

**Decision**: Landing page emphasizes self-hostable open core first; managed cloud uses BYOK  
**Rationale**: Matches product vision (Docker self-host is free, no external API keys for core pipeline) and DECISIONS BYOK model for managed tiers. Pricing, hero copy, and FAQ now reflect this split.

## 2026-07-01: Strict Isolation Rule

**Decision**: Add explicit hard rule: never touch any other project memory (global or project-based), never access any other local or GitHub repo, and restrict all activity exclusively to the minio-project directory, the MiniOp GitHub repo, and the MiniOp Supabase projects (staging + prod).  
**Rationale**: User request to enforce ironclad boundaries and prevent accidental leakage or cross-project actions even under prompt pressure.

## 2026-07-01: Stag Branch for Local Merge Workflow
**Decision**: Create and push dedicated `stag` branch to origin (`origin/stag`). All changes are committed on `stag` first, then can be merged into local `main`. Remote branch created so merges can be done from local machine.  
**Rationale**: Directly fulfills "commit code to stag and create repo so we can merge into main from local". Provides controlled flow: stag acts as the pre-merge area. Conventional commit used. Smoke gate skipped only because this was pure docs + rules change.

## 2026-07-01: Secrets Removal (No Secrets in Code)
**Decision**: Removed secret injection logic from `frontend/next.config.js` (no longer loads .env secrets at build). Replaced all example secret strings (eyJ... JWTs and keys) in documentation with safe placeholders like "your_*_key". Confirmed all runtime code already uses process.env only and .env is ignored.  
**Rationale**: Reinforce "Never put secrets in repo". Hardens security posture for MiniOp GitHub repo. All actual credentials stay exclusively in local .env + platform secret stores (Vercel, GitHub Secrets).
**Rationale**: User request to enforce ironclad boundaries and prevent accidental leakage or cross-project actions even under prompt pressure. Supersedes and strengthens prior MiniOp-Only Boundary. This rule is now in CLAUDE.md and must be respected in all future sessions.
