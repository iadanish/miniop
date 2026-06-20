# Threat Model

## Overview

This document applies the STRIDE threat modeling framework to MiniOp's architecture. It identifies threats across the entire attack surface — authentication, video processing, storage, API, and infrastructure — and maps each threat to specific mitigations already implemented or planned. The model covers both the free-tier Supabase-managed deployment and the scaled production environment.

---

## System Overview and Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│  INTERNET (Untrusted)                                           │
│                                                                 │
│  ┌──────────┐     ┌──────────────────────────────────────────┐  │
│  │  Browser  │────▶│  Cloudflare / CDN (TLS Termination)     │  │
│  └──────────┘     └──────────────┬───────────────────────────┘  │
│                                  │                              │
├──────────────────────────────────┼──────────────────────────────┤
│  TRUST BOUNDARY 1: Edge          │                              │
│                                  ▼                              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Next.js API Routes (Rate Limited, Authenticated)        │   │
│  └──────────────┬──────────────────────┬────────────────────┘   │
│                 │                      │                        │
│  ┌──────────────▼───────────┐  ┌──────▼───────────────────┐   │
│  │  Supabase Auth (GoTrue)  │  │  Video Processing Workers │   │
│  └──────────────┬───────────┘  └──────┬───────────────────┘   │
│                 │                      │                        │
├─────────────────┼──────────────────────┼────────────────────────┤
│  TRUST BOUNDARY 2: Database / Storage  │                        │
│                 ▼                      ▼                        │
│  ┌─────────────────────┐  ┌────────────────────────────────┐   │
│  │  PostgreSQL (RLS)    │  │  S3 / Supabase Storage (SSE)  │   │
│  └─────────────────────┘  └────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Redis (Session Cache, Rate Limits)                      │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**Trust boundaries**:
1. **Edge**: Between the internet and MiniOp's API. All traffic must be TLS-encrypted and rate-limited.
2. **Data layer**: Between API servers and databases/storage. Service role keys are the gatekeeper.
3. **Worker boundary**: Video processing workers run in isolated containers with no direct DB access.

---

## STRIDE Analysis

### 1. Spoofing Identity

**Threat**: An attacker impersonates a legitimate user to access their projects, videos, or billing information.

| Attack Vector | Severity | Mitigation |
|---|---|---|
| Stolen JWT token (XSS, network sniffing) | Critical | TLS-only transmission, httpOnly cookies, short token expiry (15 min in production) |
| Credential stuffing on login | High | Rate limiting (5 attempts/60s), MFA for non-free tiers |
| OAuth token leakage | Critical | Tokens encrypted at rest (`pgcrypto` + KMS), never logged |
| Forged JWT (HS256 key leak) | Critical | Production uses RS256 asymmetric keys; private key isolated to auth server |
| Session fixation | High | Supabase regenerates session ID on login, refresh token rotation enabled |

**Specific mitigations implemented**:

```typescript
// Set secure cookie attributes for JWT storage
// lib/auth/cookies.ts
export const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,          // HTTPS only
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 900,           // 15 minutes (matches JWT expiry)
  domain: '.minioop.com', // Subdomain-scoped
}
```

```typescript
// Detect anomalous login patterns
// lib/auth/anomaly.ts
export async function checkLoginAnomaly(userId: string, ip: string, userAgent: string) {
  const { data: recentLogins } = await supabaseAdmin
    .from('auth_audit_log')
    .select('ip, user_agent, created_at')
    .eq('user_id', userId)
    .eq('event_type', 'login')
    .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false })
    .limit(10)

  if (!recentLogins?.length) return { suspicious: false }

  const knownIPs = new Set(recentLogins.map(l => l.ip))
  if (!knownIPs.has(ip)) {
    // New IP — send notification but don't block
    await notifyUser(userId, 'login_new_device', { ip, userAgent })
    return { suspicious: true, reason: 'new_ip' }
  }

  return { suspicious: false }
}
```

### 2. Tampering with Data

**Threat**: An attacker modifies video content, project metadata, or user data without authorization.

| Attack Vector | Severity | Mitigation |
|---|---|---|
| SQL injection via API | Critical | Supabase client uses parameterized queries; no raw SQL from user input |
| RLS policy bypass | Critical | Double-layer: app-level checks + RLS; policies tested in CI |
| Video file tampering in storage | High | S3 object integrity (ETag verification), SSE-KMS checksums |
| JWT claim manipulation | Critical | JWT signed by Supabase Auth (RS256); claims verified on every request |
| Direct database access via leaked service role key | Critical | Service role key stored in vault, rotated quarterly, IP-restricted |

**Specific mitigations**:

Input validation on all API endpoints:

```typescript
// lib/validation/projects.ts
import { z } from 'zod'

export const createProjectSchema = z.object({
  name: z.string()
    .min(1, 'Name is required')
    .max(100, 'Name too long')
    .regex(/^[a-zA-Z0-9\s\-_]+$/, 'Invalid characters in name'),
  description: z.string().max(500).optional(),
  visibility: z.enum(['private', 'unlisted', 'public']).default('private'),
})

export const updateProjectSchema = createProjectSchema.partial()
```

```typescript
// app/api/projects/[id]/route.ts
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const body = await request.json()

  // Validate input before any database operation
  const parsed = updateProjectSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  // Ownership check before update
  await assertProjectOwnership(supabase, user.id, params.id)

  // RLS also enforces owner_id = auth.uid() on UPDATE
  const { data, error } = await supabase
    .from('projects')
    .update(parsed.data)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json(data)
}
```

### 3. Repudiation

**Threat**: A user denies performing an action (uploading illegal content, deleting a project, changing billing).

| Attack Vector | Severity | Mitigation |
|---|---|---|
| Denying video upload | Medium | Audit log with user ID, IP, timestamp, file hash |
| Denying project deletion | Medium | Soft delete with 30-day recovery window |
| Denying billing changes | High | Stripe webhook logs, immutable billing audit trail |
| Admin action repudiation | High | All admin actions logged to `authorization_audit_log` |

**Audit logging implementation**:

```sql
-- supabase/migrations/013_audit_triggers.sql
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  record_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  old_data JSONB,
  new_data JSONB,
  user_id UUID,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION audit_trigger_func()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO audit_log (table_name, record_id, action, old_data, new_data, user_id)
  VALUES (
    TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id),
    TG_OP,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END,
    auth.uid()
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER audit_projects
  AFTER INSERT OR UPDATE OR DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_func();

CREATE TRIGGER audit_videos
  AFTER INSERT OR UPDATE OR DELETE ON videos
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_func();
```

### 4. Information Disclosure

**Threat**: Sensitive data (user emails, video content, OAuth tokens) is exposed to unauthorized parties.

| Attack Vector | Severity | Mitigation |
|---|---|---|
| RLS bypass exposing other users' data | Critical | RLS enforced on every table; tested in CI |
| Signed URL guessing | Medium | UUIDv4 paths, 1-hour expiry, single-use option |
| Error messages leaking internal details | Medium | Generic error responses in production, detailed logs server-side |
| Video content accessed via predictable URLs | High | Signed URLs only; no public bucket access |
| OAuth tokens in logs | Critical | Structured logging with PII redaction |
| Database dump exposure | Critical | Encrypted at rest, access restricted to service role |

**PII-safe logging**:

```typescript
// lib/logger.ts
import pino from 'pino'

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'user.email',
      'user.phone',
      '*.access_token',
      '*.refresh_token',
      '*.password',
    ],
    remove: true,
  },
  ...(process.env.NODE_ENV === 'production' && {
    transport: {
      target: 'pino-opentelemetry-transport',
    },
  }),
})

export default logger
```

**Generic error responses**:

```typescript
// lib/errors/handler.ts
export function handleAPIError(error: unknown) {
  logger.error({ err: error }, 'API error')

  if (error instanceof AuthorizationError) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (error instanceof ValidationError) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  // Never expose internal error details to the client
  return NextResponse.json(
    { error: 'Internal server error' },
    { status: 500 }
  )
}
```

### 5. Denial of Service

**Threat**: An attacker makes MiniOp unavailable to legitimate users.

| Attack Vector | Severity | Mitigation |
|---|---|---|
| API rate limit exhaustion | High | Upstash rate limiter per IP and per user |
| Large video upload (resource exhaustion) | High | File size limit (500MB free, 2GB pro), upload resumption |
| Video processing queue flooding | High | Job queue with per-user concurrency limits |
| Database connection exhaustion | High | PgBouncer connection pooling, query timeout (30s) |
| Storage bandwidth exhaustion | Medium | CDN caching for public clips, signed URL throttling |

**Rate limiting configuration**:

```typescript
// lib/rate-limit/limits.ts
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

const redis = Redis.fromEnv()

export const rateLimits = {
  // Global API: 100 requests per minute per IP
  global: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(100, '60 s'),
    analytics: true,
    prefix: 'rl:global',
  }),

  // Auth endpoints: 5 attempts per minute per IP
  auth: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(5, '60 s'),
    analytics: true,
    prefix: 'rl:auth',
  }),

  // Video upload: 10 uploads per hour per user
  upload: new Ratelimit({
    redis,
    limiter: Ratelimit.fixedWindow(10, '3600 s'),
    analytics: true,
    prefix: 'rl:upload',
  }),

  // Video processing: 3 concurrent jobs per user
  processing: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(3, '60 s'),
    analytics: true,
    prefix: 'rl:process',
  }),
}
```

**Video processing concurrency control**:

```typescript
// lib/queue/concurrency.ts
import { Queue, Worker } from 'bullmq'

const videoQueue = new Queue('video-processing', {
  connection: { host: process.env.REDIS_HOST, port: 6379 },
})

export async function enqueueVideoJob(userId: string, videoId: string) {
  // Check per-user concurrency
  const activeJobs = await videoQueue.getJobs(['active', 'waiting'])
  const userJobs = activeJobs.filter(j => j.data.userId === userId)

  if (userJobs.length >= 3) {
    throw new Error('Too many concurrent video processing jobs')
  }

  return videoQueue.add('process', { userId, videoId }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 86400 },
    removeOnFail: { age: 604800 },
  })
}
```

### 6. Elevation of Privilege

**Threat**: An attacker gains higher privileges than intended (viewer accessing creator features, creator accessing admin functions).

| Attack Vector | Severity | Mitigation |
|---|---|---|
| JWT claim manipulation to add admin role | Critical | JWT signed by auth server; claims not modifiable client-side |
| Direct database manipulation via SQL injection | Critical | Parameterized queries only; no raw SQL with user input |
| RLS policy logic errors | Critical | Policy unit tests in CI; reviewed on every migration |
| Service role key exposure | Critical | Vault-managed, IP-restricted, rotated quarterly |
| Prototype pollution in API input | High | Zod schema validation on all endpoints |

**Role escalation prevention**:

```sql
-- Prevent users from granting themselves roles
-- Only platform_admins can insert into user_roles
CREATE POLICY "only_admins_grant_roles"
  ON user_roles FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_id = auth.uid()
      AND role = 'platform_admin'
    )
  );

-- Prevent users from modifying their own role
CREATE POLICY "no_self_role_modification"
  ON user_roles FOR UPDATE
  TO authenticated
  USING (
    user_id != auth.uid()
    AND EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_id = auth.uid()
      AND role = 'platform_admin'
    )
  );

-- Prevent users from deleting their own role
CREATE POLICY "no_self_role_deletion"
  ON user_roles FOR DELETE
  TO authenticated
  USING (
    user_id != auth.uid()
    AND EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_id = auth.uid()
      AND role = 'platform_admin'
    )
  );
```

---

## Threat Matrix Summary

| STRIDE Category | Top Threat | Severity | Primary Mitigation |
|---|---|---|---|
| Spoofing | Stolen JWT | Critical | Short expiry, httpOnly cookies, MFA |
| Tampering | RLS bypass | Critical | Dual-layer auth (app + RLS), policy tests |
| Repudiation | Billing dispute | High | Immutable audit log, Stripe webhook trail |
| Info Disclosure | Cross-user data leak | Critical | RLS on every table, signed URLs only |
| Denial of Service | Upload/processing abuse | High | Per-user rate limits, concurrency caps |
| Elevation | Role escalation | Critical | Signed JWT, admin-only role grants |

---

## Attack Surface by Deployment Tier

### Free Tier Attack Surface

```
┌──────────────────────────────────────────┐
│  Browser ──▶ Supabase Edge ──▶ Database  │
│              │                           │
│              ▼                           │
│         GoTrue Auth                      │
│              │                           │
│              ▼                           │
│         Storage (S3-backed)              │
└──────────────────────────────────────────┘
```

- Supabase manages infrastructure security (patching, DDoS, network isolation)
- Attack surface is limited to: API routes, RLS policies, client-side XSS
- No video processing workers (clips generated via Supabase Edge Functions)

### Scaled Production Attack Surface

```
┌──────────────────────────────────────────────────────────┐
│  Browser ──▶ CDN ──▶ Load Balancer ──▶ API Servers       │
│                           │                              │
│                           ▼                              │
│                    Video Workers (isolated)               │
│                           │                              │
│              ┌────────────┼────────────┐                 │
│              ▼            ▼            ▼                 │
│         PostgreSQL    S3 (SSE-KMS)   Redis               │
│              │                                             │
│              ▼                                             │
│         PgBouncer                                         │
└──────────────────────────────────────────────────────────┘
```

- Additional attack surface: worker containers, internal service mTLS, Redis, PgBouncer
- Requires: network segmentation, container scanning, secret rotation, infrastructure monitoring

---

## Incident Response Checklist

When a security incident is detected:

1. **Contain**: Revoke affected sessions via Redis revocation list
2. **Assess**: Query `audit_log` for scope of compromised data
3. **Notify**: Alert affected users if PII was exposed
4. **Rotate**: Compromised keys (service role, KMS, OAuth client secrets)
5. **Patch**: Fix the vulnerability, deploy, verify
6. **Review**: Post-incident review, update this threat model

```typescript
// Emergency session revocation for a compromised user
// lib/auth/emergency.ts
export async function revokeAllUserSessions(userId: string) {
  // Revoke all refresh tokens (Supabase admin API)
  await supabaseAdmin.auth.admin.signOut(userId)

  // Add all possible JTIs to revocation list
  // (Since JWTs are stateless, we revoke by user_id prefix)
  await redis.set(`revoked:user:${userId}`, '1', { ex: 86400 })

  // Log the revocation
  logger.warn({ userId }, 'Emergency session revocation executed')
}
```

---

## Next Steps

- Review [01-authentication.md](./01-authentication.md) for authentication-specific mitigations.
- Review [02-authorization.md](./02-authorization.md) for RLS policy design.
- Review [03-data-protection.md](./03-data-protection.md) for encryption details referenced in this model.
