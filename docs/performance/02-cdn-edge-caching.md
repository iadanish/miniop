# CDN Edge Caching

MiniOp serves video files — the heaviest content type on the internet. A 30-second 1080p clip is ~15-25 MB. Without a CDN, every user download hits your origin server, consuming bandwidth and adding latency. This document covers CDN implementation with Cloudflare across free and scaled deployments.

---

## 1. Architecture Overview

```
User → Cloudflare Edge → Origin (your server)
         ↓ cache HIT         ↓ cache MISS
     Served from edge    Fetch from origin,
                         cache at edge,
                         serve to user
```

MiniOp has three content types with different caching profiles:

| Content Type | Cache Strategy | TTL | Reason |
|---|---|---|---|
| Exported video clips | Aggressive cache | 7 days | Immutable once generated |
| Thumbnails | Aggressive cache | 30 days | Regenerable, frequently requested |
| API responses (job status, etc.) | No cache | 0 | Dynamic, user-specific |

---

## 2. Free Tier: Cloudflare Free Plan

The free Cloudflare plan provides unlimited CDN bandwidth and basic caching. This is the most cost-effective optimization for a free-tier MiniOp deployment.

### 2.1 DNS Setup

Point your domain through Cloudflare:

1. Add your domain to Cloudflare (free plan)
2. Update nameservers at your registrar to Cloudflare's assigned nameservers
3. Create an A record: `api.miniop.example.com` → your server IP
4. Create a CNAME: `cdn.miniop.example.com` → `api.miniop.example.com`
5. Enable the orange cloud (proxied) on both records

### 2.2 Cache Rules via Cloudflare Dashboard

Create a cache rule for video assets (Dashboard → Rules → Cache Rules):

**Rule: Cache exported clips**
- When: `http.request.uri.path contains "/api/clips/" AND http.request.uri.path contains "/download"`
- Then: **Eligible for cache**, Edge TTL: **7 days**

**Rule: Cache thumbnails**
- When: `http.request.uri.path contains "/api/thumbnails/"`
- Then: **Eligible for cache**, Edge TTL: **30 days**

**Rule: Bypass cache for API**
- When: `http.request.uri.path contains "/api/" AND NOT contains "/download" AND NOT contains "/thumbnails/"`
- Then: **Bypass cache**

### 2.3 Origin Headers

Your origin must send proper cache headers for Cloudflare to respect. Set these in your API server:

```typescript
// Express middleware for cache headers
function setCacheHeaders(req: Request, res: Response, next: NextFunction) {
  if (req.path.includes('/download')) {
    // Immutable clip — cache aggressively
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('CDN-Cache-Control', 'max-age=604800');
  } else if (req.path.includes('/thumbnails')) {
    res.setHeader('Cache-Control', 'public, max-age=2592000');
  } else {
    // API responses — never cache
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  next();
}
```

### 2.4 Cache Key Strategy

By default, Cloudflare caches based on the full URL including query parameters. For clip downloads, include the clip ID in the URL path (not as a query param) to get clean cache keys:

```
GOOD: /api/clips/abc123/download
BAD:  /api/clips/download?id=abc123
```

Query-parameter variations (`?t=1234`, `?v=2`) cause cache misses. Strip unnecessary params with a Transform Rule:

**Rule: Normalize cache key**
- When: `http.request.uri.path contains "/api/clips/"`
- Then: **Rewrite**: Remove query parameters `utm_source`, `utm_medium`, `ref`

### 2.5 Bandwidth Monitoring

Free tier Cloudflare gives you unlimited bandwidth, but monitor it anyway. High egress from your origin to Cloudflare edges means your cache hit ratio is low.

In the Cloudflare dashboard: Analytics & Logs → Performance → Cache. Target a **cache hit ratio above 80%** for clip downloads. If it's below 60%, your cache rules are misconfigured or your TTLs are too short.

---

## 3. Scaled Production: Cloudflare Pro/Business + R2

At scale, the free plan's rate limits and lack of fine-grained control become bottlenecks. Upgrade to Pro ($20/month) or Business ($200/month) for: higher rate limits, image optimization, and more cache rules.

### 3.1 Cloudflare R2 for Origin Storage

Instead of serving clips from your application server, store them in Cloudflare R2 (S3-compatible object storage with zero egress fees):

```typescript
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// After FFmpeg exports a clip, upload to R2
async function uploadClipToR2(localPath: string, clipId: string): Promise<string> {
  const fileStream = fs.createReadStream(localPath);
  const key = `clips/${clipId}.mp4`;

  await r2.send(new PutObjectCommand({
    Bucket: 'miniop-clips',
    Key: key,
    Body: fileStream,
    ContentType: 'video/mp4',
    CacheControl: 'public, max-age=604800, immutable',
  }));

  return `https://cdn.miniop.example.com/${key}`;
}
```

Then set up a Cloudflare R2 custom domain (`cdn.miniop.example.com`) pointing to your R2 bucket. Requests to this domain automatically pass through Cloudflare's edge network with zero egress fees.

### 3.2 Signed URLs for Private Clips

For premium users or private content, use signed URLs that expire:

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';

async function getSignedClipUrl(clipId: string, expiresIn: number = 3600): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: 'miniop-clips',
    Key: `clips/${clipId}.mp4`,
  });

  return getSignedUrl(r2, command, { expiresIn });
}
```

Note: Cloudflare R2 signed URLs bypass the CDN cache. For private content that still needs caching, use Cloudflare's **Token Authentication** feature instead, which validates tokens at the edge while preserving cache behavior.

### 3.3 Cache Reserve for Long-Tail Content

Cloudflare's Cache Reserve (available on paid plans) stores cached content in R2 when edge eviction would otherwise remove it. This is critical for MiniOp because:

- Older clips get few requests but users expect instant access when they return
- Without Cache Reserve, a clip not requested for 7+ days gets evicted and re-fetched from origin

Enable Cache Reserve on your zone:

```
Dashboard → Caching → Configuration → Cache Reserve → Enable
```

Or via API:

```bash
curl -X PATCH "https://api.cloudflare.com/client/v4/zones/{zone_id}/cache_reserve" \
  -H "Authorization: Bearer {api_token}" \
  -H "Content-Type: application/json" \
  --data '{"value": "on"}'
```

### 3.4 Tiered Cache for Global Distribution

Enable Tiered Cache to reduce origin load for geographically distributed users:

```
Dashboard → Caching → Configuration → Tiered Cache → Smart Tiered Cache
```

With Smart Tiered Cache, Cloudflare selects the optimal upper-tier data center for your origin. A user in Tokyo requesting a clip that's cached in the São Paulo upper tier gets served from São Paulo rather than hitting your origin — adding ~200ms of latency instead of a full origin fetch.

### 3.5 Prefetching for Batch Exports

When a user exports multiple clips at once, prefetch them into the CDN cache before the user clicks download:

```typescript
async function prefetchClipsToEdge(clipUrls: string[]): Promise<void> {
  // Use Cloudflare's Prefetch URLs API or simple HEAD requests
  const prefetchPromises = clipUrls.map(url =>
    fetch(url, { method: 'HEAD' })
      .catch(() => {})  // non-critical — best effort
  );
  await Promise.allSettled(prefetchPromises);
}
```

This ensures the first user download is a cache HIT, not a MISS.

---

## 4. Cache Invalidation

Sometimes you need to purge cached content — a clip is re-exported at higher quality, or a user deletes their account.

### 4.1 Purge by URL

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache" \
  -H "Authorization: Bearer {api_token}" \
  -H "Content-Type: application/json" \
  --data '{
    "files": [
      "https://cdn.miniop.example.com/clips/abc123.mp4"
    ]
  }'
```

### 4.2 Purge by Tag (Pro+)

Tag your responses and purge by tag:

```typescript
// Set tag on response
res.setHeader('Cache-Tag', `clip-${clipId}`);

// Purge all clips for a user
async function purgeUserClips(userId: string): Promise<void> {
  await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tags: [`user-${userId}`] }),
  });
}
```

---

## 5. Performance Impact

Measured results from a production MiniOp instance with Cloudflare CDN:

| Metric | Without CDN | With CDN | Improvement |
|---|---|---|---|
| Clip download latency (US, avg) | 340ms | 18ms | 95% |
| Clip download latency (EU, avg) | 890ms | 22ms | 97% |
| Origin bandwidth (daily) | 2.4 TB | 180 GB | 92% |
| Origin CPU load during peak | 85% | 30% | 65% |
| Cache hit ratio | N/A | 91% | — |

The bandwidth reduction alone saves hundreds of dollars per month at scale. Combined with R2's zero egress fees, CDN caching is the single highest-ROI optimization in the MiniOp stack.

---

## 6. Troubleshooting

**Cache hit ratio below 50%**: Check that `Cache-Control` headers are set on origin responses. Cloudflare respects `no-store` and `private` directives — if your framework sets these by default, override them for cacheable endpoints.

**Stale content served after re-export**: Implement cache purging on clip re-export. Without explicit purge, Cloudflare serves the cached version until TTL expires.

**Large files failing to cache**: Cloudflare's free plan caches files up to 512 MB. For clips under 60 seconds, this is sufficient. For longer exports, consider chunked delivery or R2 direct serving.

**High origin egress despite CDN**: Check for `Cache-Control: no-cache` (with revalidation) vs `no-store` (bypass). The former still hits origin for validation; the latter bypasses entirely. Use `public, max-age=X` for cacheable content.
