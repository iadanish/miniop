# API Security — MiniOp Video Clipping Platform

## Threat Model

MiniOp's API faces three primary threat categories:

1. **Account abuse**: Free-tier users attempting to bypass clip quotas, upload limits, or processing queue priority
2. **Data exfiltration**: Unauthorized access to other users' videos, clips, or project metadata
3. **Infrastructure attacks**: DDoS, credential stuffing, and token theft targeting the API gateway

Every control below addresses one of these threats. Security measures are applied uniformly — the same middleware chain processes free-tier and enterprise requests.

## Authentication — JWT with RS256

All API requests (except public clip reads) require a Bearer token. Tokens are JWTs signed with RS256 using a 2048-bit RSA key pair.

Token structure:

```json
{
  "sub": "usr_a1b2c3",
  "tier": "pro",
  "scopes": ["clips:write", "jobs:read", "exports:write"],
  "org_id": "org_x7y8z9",
  "iat": 1718876400,
  "exp": 1718880000,
  "jti": "tok_unique_id"
}
```

Key management:

```bash
# Generate key pair (do this once, store in vault)
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem

# Rotate keys quarterly — publish both old and new public keys
# during rotation window via JWKS endpoint
```

The JWKS endpoint (`/.well-known/jwks.json`) publishes all active public keys:

```json
{
  "keys": [
    {
      "kty": "RSA",
      "kid": "key_2026_q2",
      "use": "sig",
      "alg": "RS256",
      "n": "0vx7agoebGcQSuu...",
      "e": "AQAB"
    },
    {
      "kty": "RSA",
      "kid": "key_2026_q3",
      "use": "sig",
      "alg": "RS256",
      "n": "yK9s2dXq3fP...",
      "e": "AQAB"
    }
  ]
}
```

## Token Validation Middleware

Every request passes through token validation before reaching any handler:

```go
package middleware

import (
    "context"
    "crypto/rsa"
    "net/http"
    "strings"

    "github.com/golang-jwt/jwt/v5"
)

type Claims struct {
    UserID string   `json:"sub"`
    Tier   string   `json:"tier"`
    Scopes []string `json:"scopes"`
    OrgID  string   `json:"org_id"`
    jwt.RegisteredClaims
}

func AuthMiddleware(keyFunc func(*jwt.Token) (interface{}, error)) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            auth := r.Header.Get("Authorization")
            if !strings.HasPrefix(auth, "Bearer ") {
                writeError(w, 401, "missing or malformed Authorization header")
                return
            }

            tokenStr := strings.TrimPrefix(auth, "Bearer ")
            claims := &Claims{}

            token, err := jwt.ParseWithClaims(tokenStr, claims, keyFunc,
                jwt.WithValidMethods([]string{"RS256"}),
                jwt.WithIssuer("https://auth.minio.dev"),
            )
            if err != nil || !token.Valid {
                writeError(w, 401, "invalid or expired token")
                return
            }

            ctx := context.WithValue(r.Context(), userKey{}, claims)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

func RequireScope(scope string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            claims := GetClaims(r.Context())
            if !hasScope(claims.Scopes, scope) {
                writeError(w, 403, "insufficient scope: required "+scope)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

## Authorization — Scope-Based Access Control

Scopes follow the `{resource}:{action}` pattern. The full scope table:

| Scope | Grants |
|-------|--------|
| `clips:write` | Create, update, delete clips |
| `clips:read` | Read own clips and their metadata |
| `jobs:read` | View job status and progress |
| `jobs:cancel` | Cancel running jobs |
| `exports:write` | Create export tasks |
| `projects:write` | Create and manage projects |
| `admin:*` | Full access (internal services only) |

Route-level scope enforcement:

```go
r.Route("/v1/clips", func(r chi.Router) {
    r.Use(middleware.RequireScope("clips:read"))
    r.Get("/", listClips)
    r.Get("/{id}", getClip)
})

r.Route("/v1/projects/{projectID}/clips", func(r chi.Router) {
    r.Use(middleware.RequireScope("clips:write"))
    r.Post("/", createClip)
    r.Delete("/{id}", deleteClip)
})
```

## Resource Ownership Validation

Having a scope isn't enough — the user must own the resource. Every data access goes through an ownership check:

```go
func (s *ClipService) GetClip(ctx context.Context, clipID string) (*Clip, error) {
    claims := GetClaims(ctx)
    clip, err := s.repo.GetByID(ctx, clipID)
    if err != nil {
        return nil, err
    }

    if clip.UserID != claims.UserID && clip.OrgID != claims.OrgID {
        return nil, ErrForbidden
    }

    return clip, nil
}
```

Organization-level access: users within the same `org_id` can share clips. This is checked via a `org_members` table join at query time.

## Rate Limiting — Sliding Window Counter

Rate limits are enforced at the API gateway using Redis:

```go
package ratelimit

import (
    "context"
    "fmt"
    "net/http"
    "strconv"
    "time"

    "github.com/redis/go-redis/v9"
)

type Limiter struct {
    rdb    *redis.Client
    limits map[string]int // tier -> requests per minute
}

func New(rdb *redis.Client) *Limiter {
    return &Limiter{
        rdb: rdb,
        limits: map[string]int{
            "free":       30,
            "pro":        120,
            "enterprise": 600,
        },
    }
}

func (l *Limiter) Allow(ctx context.Context, key string, tier string) (bool, int, error) {
    limit := l.limits[tier]
    windowKey := fmt.Sprintf("rl:%s:%d", key, time.Now().Unix()/60)

    pipe := l.rdb.Pipeline()
    incr := pipe.Incr(ctx, windowKey)
    pipe.Expire(ctx, windowKey, 2*time.Minute)
    _, err := pipe.Exec(ctx)
    if err != nil {
        return false, 0, err
    }

    count := int(incr.Val())
    remaining := limit - count
    if remaining < 0 {
        remaining = 0
    }

    return count <= limit, remaining, nil
}
```

## Upload Security

Video uploads are the highest-risk surface. Controls:

1. **Presigned URLs**: Clients upload directly to object storage, never through the API server:

```go
func (h *UploadHandler) GetUploadURL(w http.ResponseWriter, r *http.Request) {
    claims := GetClaims(r.Context())

    maxSize := getMaxUploadSize(claims.Tier) // 500MB free, 5GB pro
    contentLength := r.ContentLength

    // Generate presigned PUT URL for S3/MinIO
    url, err := h.storage.PresignedPutObject(r.Context(),
        "uploads",
        fmt.Sprintf("%s/%s/%s", claims.UserID, uuid.New(), "video.mp4"),
        15*time.Minute,
        func(opts *s3.PutObjectInput) {
            opts.ContentLength = &maxSize
            opts.ContentType = aws.String("video/mp4")
        },
    )
    if err != nil {
        writeError(w, 500, "failed to generate upload URL")
        return
    }

    writeJSON(w, map[string]interface{}{
        "upload_url":  url,
        "max_size_mb": maxSize / 1024 / 1024,
        "expires_in":  900,
    })
}
```

2. **File type validation**: After upload, a worker checks the file's magic bytes and FFprobe output. Non-video files are deleted immediately.

3. **Malware scanning**: Uploaded files pass through ClamAV before processing begins.

## Input Sanitization

All user-provided strings are sanitized before storage:

```go
func sanitizeProjectName(name string) string {
    // Strip control characters
    name = strings.Map(func(r rune) rune {
        if unicode.IsControl(r) && r != '\n' {
            return -1
        }
        return r
    }, name)
    // Truncate
    if len(name) > 200 {
        name = name[:200]
    }
    return strings.TrimSpace(name)
}
```

URL fields are validated against an allowlist of schemes (`https` only) and blocked domains (internal IPs, metadata endpoints):

```go
func validateSourceURL(rawURL string) error {
    u, err := url.Parse(rawURL)
    if err != nil || u.Scheme != "https" {
        return fmt.Errorf("only HTTPS URLs allowed")
    }

    ip := net.ParseIP(u.Hostname())
    if ip != nil {
        if ip.IsPrivate() || ip.IsLoopback() {
            return fmt.Errorf("internal URLs not allowed")
        }
    }

    return nil
}
```

## CORS Configuration

```go
func CORSMiddleware(allowedOrigins []string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            origin := r.Header.Get("Origin")
            if contains(allowedOrigins, origin) {
                w.Header().Set("Access-Control-Allow-Origin", origin)
                w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
                w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
                w.Header().Set("Access-Control-Max-Age", "86400")
            }

            if r.Method == "OPTIONS" {
                w.WriteHeader(204)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

Allowed origins for production: `https://app.minio.dev`, `https://minio.dev`. Never use `*` — even for free tier.

## Security Headers

Every response includes these headers via middleware:

```go
func SecurityHeaders(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("X-Content-Type-Options", "nosniff")
        w.Header().Set("X-Frame-Options", "DENY")
        w.Header().Set("X-XSS-Protection", "0")
        w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        w.Header().Set("Content-Security-Policy", "default-src 'none'")
        w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
        next.ServeHTTP(w, r)
    })
}
```

## Audit Logging

Every authenticated request is logged to an audit table for forensics:

```sql
CREATE TABLE audit_log (
    id BIGSERIAL PRIMARY KEY,
    request_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    org_id TEXT,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status_code INT,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_user_time ON audit_log(user_id, created_at DESC);
```

Audit logs are retained for 90 days (free tier) or 1 year (enterprise). They are write-only — no API endpoint exposes them. Only the internal security team can query them directly.

## Free-Tier Specific Controls

| Control | Free Tier | Paid Tier |
|---------|-----------|-----------|
| Token TTL | 1 hour | 8 hours |
| Rate limit | 30 req/min | 120+ req/min |
| Upload size | 500 MB | 5 GB+ |
| Webhook URL | Must be HTTPS | Must be HTTPS |
| API key rotation | Manual only | Auto-rotate via API |
| Audit log retention | 90 days | 1 year |

## Incident Response

When anomalous activity is detected (spike in 401s, quota abuse patterns):

1. CloudWatch alarm triggers PagerDuty alert
2. Automated script revokes all tokens for the affected `user_id` via JWKS key rotation
3. User receives email notification
4. If pattern continues, account is flagged for manual review

```bash
# Emergency: revoke all tokens for a user
curl -X POST http://auth-service:3001/admin/revoke \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -d '{"user_id": "usr_suspicious", "reason": "quota_abuse"}'
```
