# Authentication System

## Overview

MiniOp's authentication layer handles identity verification for creators uploading video content, viewers accessing shared clips, and administrators managing platform resources. The system is built on Supabase Auth with JWT-based session management, supporting email/password, OAuth 2.0 social login, and magic link flows. This document covers the free-tier Supabase implementation and the production-hardened scaled deployment.

---

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Client     │────▶│  Supabase Auth   │────▶│  Supabase DB    │
│  (Next.js)   │◀────│  (GoTrue)        │◀────│  (PostgreSQL)   │
└──────┬───────┘     └──────────────────┘     └─────────────────┘
       │                      │
       │              ┌───────▼────────┐
       │              │  JWT Issuer    │
       └──────────────│  (HS256/RS256) │
                      └────────────────┘
```

Supabase Auth runs the GoTrue server internally. On successful authentication, it issues a JWT containing the user's UUID, role, and metadata. Every subsequent request to MiniOp's API routes includes this JWT in the `Authorization: Bearer <token>` header. The API validates the token, extracts the `sub` claim (user ID), and uses it for Row-Level Security policy enforcement.

---

## Free Tier: Supabase Auth (Managed)

### Email/Password Registration

The default flow uses Supabase's built-in email provider. No additional configuration is required beyond enabling the provider in the Supabase dashboard.

```typescript
// lib/auth/signup.ts
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export async function signUpWithEmail(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        display_name: email.split('@')[0],
        plan: 'free',
        upload_quota_seconds: 300, // 5 minutes of video on free tier
      }
    }
  })

  if (error) throw error
  return data
}
```

The `user_metadata` field stores plan-specific data directly in the JWT. This avoids an extra database lookup on every request to determine tier limits.

### OAuth 2.0 Social Login

MiniOp supports Google and GitHub OAuth. Configure each provider in the Supabase dashboard under **Authentication > Providers**, supplying the client ID and secret from the respective developer console.

```typescript
// lib/auth/oauth.ts
export async function signInWithProvider(provider: 'google' | 'github') {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
      queryParams: {
        access_type: 'offline',
        prompt: 'consent',
      }
    }
  })

  if (error) throw error
  return data
}
```

The callback route exchanges the authorization code for tokens:

```typescript
// app/auth/callback/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')

  if (code) {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          },
        },
      }
    )
    await supabase.auth.exchangeCodeForSession(code)
  }

  return NextResponse.redirect(new URL('/dashboard', request.url))
}
```

### Magic Link Authentication

For passwordless flows, Supabase sends a one-time link to the user's email:

```typescript
export async function signInWithMagicLink(email: string) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`
    }
  })

  if (error) throw error
}
```

### JWT Structure

A decoded free-tier JWT looks like:

```json
{
  "aud": "authenticated",
  "exp": 1719000000,
  "sub": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "email": "creator@example.com",
  "role": "authenticated",
  "app_metadata": {
    "provider": "email",
    "providers": ["email"]
  },
  "user_metadata": {
    "display_name": "creator",
    "plan": "free",
    "upload_quota_seconds": 300
  },
  "iat": 1718996400
}
```

The `sub` claim is the primary key used in all RLS policies. The `user_metadata.plan` field gates feature access without database round-trips.

---

## Scaled Production: Hardened Authentication

### Custom JWT Signing Key (RS256)

In production, switch from Supabase's default HS256 (shared secret) to RS256 (asymmetric key pair). This prevents token forgery even if the signing key is compromised from the client side — only the private key can sign.

In `supabase/config.toml`:

```toml
[auth]
jwt_secret = ""  # Disable symmetric signing

[auth.jwt]
algorithm = "RS256"
private_key_file = "./keys/jwt-private.pem"
public_key_file = "./keys/jwt-public.pem"
```

Generate the key pair:

```bash
openssl genrsa -out jwt-private.pem 4096
openssl rsa -in jwt-private.pem -pubout -out jwt-public.pem
```

Distribute `jwt-public.pem` to your API servers. Only the Supabase Auth server holds the private key.

### Token Expiry and Refresh Strategy

Configure aggressive token lifetimes for production:

```toml
[auth]
jwt_expiry = 900          # 15 minutes access token
refresh_token_rotation = true  # Rotate refresh tokens on use
refresh_token_lifetime = 86400 # 24 hours
```

Implement silent refresh in the client:

```typescript
// lib/auth/session.ts
import { useEffect } from 'react'
import { supabase } from './supabase-client'

export function useSessionRefresh() {
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'TOKEN_REFRESHED') {
          console.log('Token refreshed, expires at:', session?.expires_at)
        }
        if (event === 'SIGNED_OUT') {
          window.location.href = '/login'
        }
      }
    )

    return () => subscription.unsubscribe()
  }, [])
}
```

### Multi-Factor Authentication (MFA)

Require TOTP-based MFA for admin and pro-tier accounts:

```typescript
// lib/auth/mfa.ts
export async function enrollMFA() {
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'MiniOp Authenticator'
  })

  if (error) throw error

  return {
    qrCode: data.totp.qr_code,
    secret: data.totp.secret,
    factorId: data.id
  }
}

export async function verifyMFA(factorId: string, challengeId: string, code: string) {
  const { data, error } = await supabase.auth.mfa.verify({
    factorId,
    challengeId,
    code
  })

  if (error) throw error
  return data
}

export async function getAuthenticatorAssuranceLevel() {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (error) throw error

  // If AAL1 but enrolled factors exist, redirect to MFA challenge
  if (data.currentLevel === 'aal1' && data.nextLevel === 'aal2') {
    return { requiresMFA: true, factors: data.factors }
  }

  return { requiresMFA: false }
}
```

Enforce MFA at the middleware level:

```typescript
// middleware.ts
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

const PROTECTED_ROUTES = ['/dashboard', '/projects', '/api/videos']

export async function middleware(request: NextRequest) {
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { /* ... */ } }
  )

  const { data: { session } } = await supabase.auth.getSession()

  if (!session) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  const isProtected = PROTECTED_ROUTES.some(r =>
    request.nextUrl.pathname.startsWith(r)
  )

  if (isProtected) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    const userPlan = session.user.user_metadata?.plan

    if (userPlan !== 'free' && aal.currentLevel !== 'aal2') {
      return NextResponse.redirect(new URL('/auth/mfa-challenge', request.url))
    }
  }

  return NextResponse.next()
}
```

### Rate Limiting Authentication Endpoints

Protect login and signup endpoints from brute-force attacks:

```typescript
// lib/rate-limit.ts
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(5, '60 s'), // 5 attempts per 60 seconds
  analytics: true,
})

export async function checkAuthRateLimit(ip: string) {
  const { success, remaining, reset } = await ratelimit.limit(`auth:${ip}`)
  return { success, remaining, reset }
}
```

Apply in the API route:

```typescript
// app/api/auth/login/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { checkAuthRateLimit } from '@/lib/rate-limit'

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') ?? '127.0.0.1'
  const { success, remaining, reset } = await checkAuthRateLimit(ip)

  if (!success) {
    return NextResponse.json(
      { error: 'Too many login attempts. Try again later.' },
      {
        status: 429,
        headers: {
          'X-RateLimit-Remaining': remaining.toString(),
          'X-RateLimit-Reset': reset.toString(),
        }
      }
    )
  }

  // Proceed with authentication...
}
```

### Session Revocation

Supabase does not natively support server-side token revocation (JWTs are stateless). To implement it, maintain a revocation list in Redis:

```typescript
// lib/auth/revocation.ts
import { Redis } from '@upstash/redis'

const redis = Redis.fromEnv()
const REVOCATION_PREFIX = 'revoked:session:'
const REVOCATION_TTL = 86400 // Match refresh token lifetime

export async function revokeSession(jti: string, expiresAt: number) {
  const ttl = Math.max(expiresAt - Math.floor(Date.now() / 1000), 60)
  await redis.set(`${REVOCATION_PREFIX}${jti}`, '1', { ex: ttl })
}

export async function isSessionRevoked(jti: string): Promise<boolean> {
  return (await redis.exists(`${REVOCATION_PREFIX}${jti}`)) === 1
}
```

Check revocation on each request:

```typescript
// lib/auth/verify.ts
export async function verifyToken(token: string) {
  const payload = await verifyJWT(token) // Use jose or Supabase's verifier

  if (await isSessionRevoked(payload.jti)) {
    throw new Error('Session has been revoked')
  }

  return payload
}
```

---

## Free vs. Scaled: Summary

| Aspect | Free Tier | Scaled Production |
|---|---|---|
| JWT Algorithm | HS256 (Supabase default) | RS256 (asymmetric) |
| Token Expiry | 3600s (1 hour) | 900s (15 min) |
| MFA | Not enforced | Required for admin/pro |
| Rate Limiting | None | Upstash sliding window |
| Session Revocation | Not supported | Redis-backed revocation list |
| OAuth Providers | Google, GitHub | Google, GitHub, SAML/SSO |
| Refresh Rotation | Disabled | Enabled |

---

## Environment Variables

```bash
# .env.local (free tier)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# .env.production (scaled)
NEXT_PUBLIC_SUPABASE_URL=https://auth.minioop.com
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
MFA_ISSUER=MiniOp
```

---

## Next Steps

- Review [02-authorization.md](./02-authorization.md) for how authenticated identities map to resource-level permissions via RLS.
- Review [04-threat-model.md](./04-threat-model.md) for authentication-specific attack vectors and mitigations.
