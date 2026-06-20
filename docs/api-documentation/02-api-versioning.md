# API Versioning — MiniOp Video Clipping Platform

## Why Versioning Matters for MiniOp

MiniOp's API serves a React frontend that ships weekly, a mobile app on a slower release cycle, and third-party integrators who may update quarterly. Without a disciplined versioning strategy, a single breaking change in the clip creation schema would break every consumer simultaneously. The versioning system must let the backend evolve without forcing coordinated deploys across all clients.

## Versioning Scheme

MiniOp uses URL path versioning: `/v1/`, `/v2/`, etc. This was chosen over header-based versioning (`Accept: application/vnd.minio.v2+json`) because:

1. URL versioning is cache-friendly — CDNs and reverse proxies key on the full path
2. It's immediately visible in logs, monitoring dashboards, and curl commands
3. It works with every HTTP client without custom header configuration

```
/v1/clips/{id}    # current stable
/v2/clips/{id}    # next version (when needed)
```

## What Constitutes a Breaking Change

A breaking change requires a new major version. These are breaking:

- Removing a field from a response
- Renaming a field
- Changing a field's type (string → number)
- Changing the URL structure
- Changing authentication requirements
- Changing error response format

These are NOT breaking and ship under the current version:

- Adding a new optional field to a request body
- Adding a new field to a response
- Adding a new endpoint
- Adding a new optional query parameter
- Adding a new error code (as long as the format stays RFC 7807)

## Version Lifecycle

Each version goes through four stages:

```
active → deprecated → sunset → removed
```

| Stage | Duration | Behavior |
|-------|----------|----------|
| Active | Indefinite | Normal operation, full support |
| Deprecated | 6 months minimum | `Sunset` header returned, warnings in dashboard |
| Sunset | 3 months | Returns `Sunset` header, rate limits reduced by 50% |
| Removed | — | Returns `410 Gone` with migration guide URL |

The `Sunset` header (RFC 8594) is included on every response during deprecated/sunset stages:

```
HTTP/1.1 200 OK
Sunset: Sat, 01 Jan 2027 00:00:00 GMT
Link: <https://docs.minio.dev/migration/v1-to-v2>; rel="successor-version"
```

## Implementation — Routing Layer

The Go API gateway routes by version prefix and injects the version into the request context:

```go
package router

import (
    "context"
    "net/http"
    "strings"
)

type versionKey struct{}

func VersionMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        path := r.URL.Path
        version := "v1" // default

        if strings.HasPrefix(path, "/v2/") {
            version = "v2"
            r.URL.Path = strings.TrimPrefix(path, "/v2/")
        } else if strings.HasPrefix(path, "/v1/") {
            r.URL.Path = strings.TrimPrefix(path, "/v1/")
        }

        ctx := context.WithValue(r.Context(), versionKey{}, version)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

func GetVersion(ctx context.Context) string {
    if v, ok := ctx.Value(versionKey{}).(string); ok {
        return v
    }
    return "v1"
}
```

## Implementation — Handler Branching

When a handler needs version-specific logic, it checks the context:

```go
func (h *ClipHandler) GetClip(w http.ResponseWriter, r *http.Request) {
    version := router.GetVersion(r.Context())
    clipID := chi.URLParam(r, "clip_id")

    clip, err := h.service.GetClip(r.Context(), clipID)
    if err != nil {
        writeError(w, err)
        return
    }

    switch version {
    case "v1":
        writeJSON(w, toV1Response(clip))
    case "v2":
        writeJSON(w, toV2Response(clip))
    default:
        writeJSON(w, toV1Response(clip))
    }
}

func toV1Response(c *model.Clip) ClipResponseV1 {
    return ClipResponseV1{
        ID:        c.ID,
        StartSec:  c.StartSec,
        EndSec:    c.EndSec,
        Score:     c.Score,
        CreatedAt: c.CreatedAt.Format(time.RFC3339),
    }
}

func toV2Response(c *model.Clip) ClipResponseV2 {
    return ClipResponseV2{
        ID:           c.ID,
        TimeRange:    TimeRange{Start: c.StartSec, End: c.EndSec},
        Score:        c.Score,
        ViralityTags: c.ViralityTags,
        CreatedAt:    c.CreatedAt,
    }
}
```

Keep version-specific structs in separate files: `handlers/v1/clip.go`, `handlers/v2/clip.go`. The service layer returns domain models — never raw database rows.

## Database Migration Strategy

Version changes sometimes require schema evolution. MiniOp uses additive migrations only:

```sql
-- SAFE: adding a column (v2 needs virality_tags)
ALTER TABLE clips ADD COLUMN virality_tags JSONB DEFAULT '[]';

-- UNSAFE: removing or renaming a column — never do this
-- Instead, keep the old column and populate both during transition
```

When v2 adds a field that v1 doesn't use, the field is stored in the same table with a default value. v1 handlers simply ignore it. This avoids dual-write complexity.

## Client SDK Generation

Each version generates its own client SDK. The build pipeline:

```yaml
# .github/workflows/sdk-gen.yml
name: Generate SDKs
on:
  push:
    paths: ['api/v1/openapi.yaml', 'api/v2/openapi.yaml']

jobs:
  generate:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        version: [v1, v2]
    steps:
      - uses: actions/checkout@v4
      - name: Generate TypeScript client
        run: |
          npx openapi-typescript-codegen \
            --input api/${{ matrix.version }}/openapi.yaml \
            --output sdk/typescript/${{ matrix.version }} \
            --client fetch
      - name: Generate Go client
        run: |
          oapi-codegen -generate types,client \
            -package minio_${{ matrix.version }} \
            api/${{ matrix.version }}/openapi.yaml \
            > sdk/go/${{ matrix.version }}/client.go
```

The npm package publishes as `@minio/sdk@1.x` and `@minio/sdk@2.x`. Clients pin to a major version:

```typescript
import { MinioClient } from '@minio/sdk@1';

const client = new MinioClient({
  baseUrl: 'https://api.minio.dev/v1',
  token: process.env.MINIO_TOKEN,
});
```

## Deprecation Warnings in the Dashboard

When a client hits a deprecated endpoint, the response includes:

```
Deprecation: true
Sunset: Sat, 01 Jan 2027 00:00:00 GMT
Link: <https://docs.minio.dev/migration/v1-to-v2>; rel="successor-version"
```

The MiniOp admin dashboard queries a `api_usage` table to show which API keys are still calling deprecated endpoints:

```sql
SELECT api_key_id, endpoint, COUNT(*) as call_count
FROM api_request_log
WHERE version = 'v1'
  AND recorded_at > NOW() - INTERVAL '7 days'
GROUP BY api_key_id, endpoint
ORDER BY call_count DESC;
```

## Free-Tier vs Enterprise Versioning

Free-tier users get 30 days notice before any version deprecation. Enterprise customers get 6 months notice and a dedicated migration engineer. The `Sunset` header date is the same for everyone, but enterprise customers can request a 90-day extension via their account manager.

## Rollout Procedure for a New Version

1. **Spec first**: Write the v2 OpenAPI spec. Get it reviewed by frontend, mobile, and integration partners.
2. **Parallel deploy**: Deploy v2 handlers alongside v1. Both versions hit the same database.
3. **Shadow traffic**: Route 5% of v1 traffic to v2 handlers internally. Compare response shapes for 1 week.
4. **Beta opt-in**: Let integrators opt into v2 via dashboard toggle.
5. **GA + deprecation**: Mark v2 as stable, add `Sunset` header to v1.
6. **Monitor**: Track v1 usage daily. Send email warnings at 30, 14, and 7 days before sunset.
7. **Remove**: After sunset period, v1 returns `410 Gone`.

## Checklist

- [ ] OpenAPI spec per version at `api/{version}/openapi.yaml`
- [ ] URL prefix routing middleware
- [ ] Version-aware handler layer with separate response structs
- [ ] Additive-only database migrations
- [ ] SDK generation per version in CI
- [ ] Deprecation header middleware
- [ ] Dashboard showing deprecated endpoint usage per API key
- [ ] Migration guide template at `docs/migration/{old}-to-{new}.md`
