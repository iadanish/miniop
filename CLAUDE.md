# CLAUDE.md — Agent Instructions

## Startup Protocol
Every new session MUST:
1. Read this file (CLAUDE.md)
2. Read CONTEXT.md
3. Read TASKS.md
4. Read DECISIONS.md
5. Wait for user confirmation before building anything

## Rules
- User is non-technical — avoid jargon, use simple explanations
- User wants authentic, distinctive UI — no generic/AI-typical designs
- User prefers minimal/clean design over flashy
- User expects continuity across sessions — reference prior work
- Never put secrets in repo — use .env and .gitignore
- Only touch D:\minio-project without asking
- Telegram only for notifications (no email)
- Update CONTEXT.md, TASKS.md, DECISIONS.md when work completes
- Architecture decisions go to DECISIONS.md immediately

## Code Style
- TypeScript strict mode
- ESLint + Prettier (already configured)
- Conventional commits (commitlint + husky)
- Tailwind CSS for styling
- App Router for Next.js

## File Structure
```
frontend/          — Next.js app
  src/app/         — App Router pages
  src/components/  — React components
  src/lib/         — Utilities, Supabase client
  src/types/       — TypeScript types
backend/           — Python FastAPI (future)
worker/            — Cloudflare Worker
docs/              — Documentation (135 files)
skills/            — Codex skill definitions
```

## Environment Variables
See .env for actual values. Key services:
- Supabase (staging + prod)
- Cloudflare R2
- Telegram Bot
- Notion API
- Vercel
