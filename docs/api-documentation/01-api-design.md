# API Design — MiniOp Video Clipping Platform

## Design Philosophy

MiniOp's API follows a resource-oriented REST design where every core domain entity — clips, projects, jobs, users — maps to a predictable URL pattern. The API serves two consumers: the React/Next.js frontend and third-party integrators who build on top of MiniOp's clipping engine. Every endpoint must work identically whether a free-tier user clips a 5-minute video or an enterprise customer processes a 4-hour livestream.

## Resource Hierarchy

```
/v1/users/{user_id}
  /projects
    /clips
      /exports
  /jobs
  /usage
/v1/public/clips/{clip_id}
```

Each resource returns a consistent envelope:

```json
{
  "data": { ... },
  "meta": {
    "request_id": "req_8f3a2b1c",
    "timestamp": "2026-06-20T10:30:00Z"
  },
  "pagination": {
    "cursor": "eyJpZCI6MTAwfQ==",
    "has_more": true
  }
}
```

Error responses follow RFC 7807:

```json
{
  "type": "https://docs.minio.dev/errors/quota-exceeded",
  "title": "Monthly clip limit reached",
  "status": 429,
  "detail": "Free tier allows 50 clips/month. Upgrade at /v1/billing/checkout",
  "instance": "req_8f3a2b1c"
}
```

## Endpoint Specification — Clips

### Create Clip

```
POST /v1/projects/{project_id}/clips
Content-Type: application/json
Authorization: Bearer {token}
```

Request body:

```json
{
  "source_url": "https://storage.minio.dev/uploads/vid_abc123.mp4",
  "strategy": "ai_highlight",
  "options": {
    "target_duration_sec": 60,
    "max_clips": 5,
    "aspect_ratio": "9:16",
    "languages": ["en"],
    "caption_style": "bold-outline"
  },
  "webhook_url": "https://api.customer.com/hooks/minio"
}
```

Free-tier constraint: `max_clips` capped at 3, `source_url` duration capped at 30 minutes. The server returns `403` with a clear upgrade path if exceeded.

Response (`202 Accepted`):

```json
{
  "data": {
    "id": "clip_set_9x8y7z",
    "status": "processing",
    "project_id": "proj_abc",
    "created_at": "2026-06-20T10:30:00Z",
    "jobs": [
      { "id": "job_001", "type": "transcription", "status": "queued" },
      { "id": "job_002", "type": "scene_detection", "status": "queued" },
      { "id": "job_003", "type": "clip_generation", "status": "pending" }
    ]
  }
}
```

### List Clips

```
GET /v1/projects/{project_id}/clips?status=completed&limit=20&cursor={cursor}
```

Filterable by `status`, `created_after`, `created_before`. The `cursor` parameter is a base64-encoded opaque token — never expose internal IDs in pagination.

### Get Clip Detail

```
GET /v1/clips/{clip_id}
```

Returns the clip with its generated variants:

```json
{
  "data": {
    "id": "clip_abc",
    "source_video_id": "vid_xyz",
    "start_sec": 45.2,
    "end_sec": 107.8,
    "score": 0.92,
    "virality_reason": "Strong hook, emotional peak at 0:22",
    "variants": [
      {
        "id": "var_001",
        "aspect_ratio": "9:16",
        "resolution": "1080x1920",
        "url": "https://cdn.minio.dev/clips/var_001.mp4",
        "captions_url": "https://cdn.minio.dev/clips/var_001.srt",
        "size_bytes": 12400000,
        "expires_at": "2026-06-27T10:30:00Z"
      }
    ]
  }
}
```

## Endpoint Specification — Jobs

Jobs are the async work units. MiniOp uses a job queue because video processing is inherently long-running.

```
GET /v1/jobs/{job_id}
```

```json
{
  "data": {
    "id": "job_001",
    "type": "transcription",
    "status": "running",
    "progress_pct": 67,
    "started_at": "2026-06-20T10:30:05Z",
    "estimated_completion": "2026-06-20T10:31:30Z",
    "attempts": 1,
    "worker_id": "worker-gpu-07"
  }
}
```

Status values: `queued`, `running`, `completed`, `failed`, `retrying`. Free-tier jobs run on shared CPU workers; paid-tier jobs get GPU-accelerated workers with 3x throughput.

## Authentication Design

All endpoints require a Bearer token except `/v1/public/clips/{clip_id}` (read-only, for shared clips). Tokens are JWTs signed with RS256:

```bash
# Token generation (internal auth service)
curl -X POST http://auth-service:3001/token \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "usr_abc",
    "tier": "pro",
    "scopes": ["clips:write", "jobs:read", "exports:write"],
    "expires_in": 3600
  }'
```

Scopes follow the pattern `{resource}:{action}`. Free-tier tokens include `clips:write` but the gateway enforces rate limits and quota checks before the request reaches the clip service.

## Rate Limiting

Rate limits are applied at the API gateway level using a sliding window counter stored in Redis:

| Tier | Requests/min | Concurrent Jobs | Max Upload |
|------|-------------|-----------------|------------|
| Free | 30 | 2 | 500 MB |
| Pro | 120 | 10 | 5 GB |
| Enterprise | 600 | 50 | 50 GB |

Rate limit headers are included in every response:

```
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 24
X-RateLimit-Reset: 1718876460
```

When exceeded, the response is `429 Too Many Requests` with a `Retry-After` header.

## Pagination

All list endpoints use cursor-based pagination. The cursor is a base64-encoded JSON object containing the last item's sort key:

```json
{ "id": 100, "created_at": "2026-06-20T10:00:00Z" }
```

Implementation in the Go handler:

```go
func encodeCursor(lastID int, ts time.Time) string {
    raw, _ := json.Marshal(map[string]interface{}{
        "id":         lastID,
        "created_at": ts.Format(time.RFC3339),
    })
    return base64.StdEncoding.EncodeToString(raw)
}

func decodeCursor(cursor string) (int, time.Time, error) {
    raw, err := base64.StdEncoding.DecodeString(cursor)
    if err != nil {
        return 0, time.Time{}, err
    }
    var c struct {
        ID        int       `json:"id"`
        CreatedAt time.Time `json:"created_at"`
    }
    json.Unmarshal(raw, &c)
    return c.ID, c.CreatedAt, nil
}
```

Never use offset-based pagination — it breaks when items are inserted or deleted during traversal.

## Webhook Delivery

When a clip set finishes processing, MiniOp POSTs to the `webhook_url` provided during creation:

```json
{
  "event": "clip_set.completed",
  "data": {
    "clip_set_id": "clip_set_9x8y7z",
    "clips_count": 5,
    "total_duration_sec": 300,
    "completed_at": "2026-06-20T10:32:00Z"
  },
  "signature": "sha256=a1b2c3d4..."
}
```

Webhook signature verification uses HMAC-SHA256 with the user's webhook secret. Delivery retries follow exponential backoff: 1s, 4s, 16s, 64s, 256s — max 5 attempts.

## Free-Tier vs Paid-Tier Differences

The API surface is identical across tiers. The differences are enforced at the middleware layer:

- **Quota middleware**: Counts clips created this billing period. Returns `429` with `upgrade_url` when exceeded.
- **Upload middleware**: Validates file size and source video duration before accepting.
- **Worker routing**: Job creation routes to `shared-cpu` queue for free, `dedicated-gpu` queue for paid.
- **CDT (Content Delivery TTL)**: Free-tier clip URLs expire after 7 days; paid-tier after 90 days.

No endpoint returns different fields based on tier. This keeps the client code identical and avoids branching logic in the frontend.

## Versioning Strategy

All endpoints are prefixed with `/v1/`. When breaking changes are needed, `/v2/` is introduced while `/v1/` continues to operate. See `02-api-versioning.md` for the full policy.

## Implementation Checklist

1. Define OpenAPI 3.1 spec at `api/openapi.yaml` — single source of truth
2. Generate Go server stubs with `oapi-codegen`
3. Generate TypeScript client with `openapi-typescript-codegen`
4. Add middleware chain: CORS → Auth → Rate Limit → Quota → Handler
5. Deploy API gateway (Kong or Caddy) in front of the Go services
6. Configure webhook retry worker as a separate microservice
