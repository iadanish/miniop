# CDN Caching Strategy for MiniOp

MiniOp serves video files, thumbnails, waveform images, and static assets to users across geographies. A CDN caches these assets at edge locations close to users, reducing latency from 200-500ms (origin fetch) to 10-30ms (edge hit) and offloading bandwidth from the origin server.

## Free Tier: Cloudflare CDN with Pages/R2

Cloudflare's free tier provides unlimited bandwidth CDN for static assets, 100K Worker invocations per day, and 10GB R2 storage — sufficient for a small MiniOp deployment serving under 5,000 daily users.

### Cloudflare Pages for Static Assets

Deploy the Next.js static export or use Cloudflare Pages with Next.js adapter:

```bash
npm install -D @cloudflare/next-on-pages
```

```toml
# wrangler.toml
name = "miniop"
compatibility_date = "2024-01-01"
compatibility_flags = ["nodejs_compat"]

[vars]
NODE_ENV = "production"
```

```json
// package.json scripts
{
  "scripts": {
    "pages:build": "npx @cloudflare/next-on-pages",
    "pages:deploy": "wrangler pages deploy .vercel/output/static",
    "pages:dev": "npx wrangler pages dev .vercel/output/static --compatibility-flag=nodejs_compat"
  }
}
```

### Cloudflare R2 for Video and Thumbnail Storage

R2 provides S3-compatible object storage with zero egress fees, making it ideal for MiniOp's video clip storage:

```bash
npm install @aws-sdk/client-s3
```

```typescript
// lib/r2-client.ts
import { S3Client } from "@aws-sdk/client-s3";

export const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});
```

```typescript
// lib/storage.ts
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2Client } from "./r2-client";

const BUCKET = "miniop-media";

export async function uploadClip(
  userId: string,
  clipId: string,
  videoBuffer: Buffer,
  contentType: string
) {
  const key = `clips/${userId}/${clipId}/video.mp4`;

  await r2Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: videoBuffer,
      ContentType: contentType,
      CacheControl: "public, max-age=86400",
    })
  );

  return `https://media.miniop.com/${key}`;
}

export async function uploadThumbnail(
  userId: string,
  clipId: string,
  imageBuffer: Buffer
) {
  const key = `clips/${userId}/${clipId}/thumb.webp`;

  await r2Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: imageBuffer,
      ContentType: "image/webp",
      CacheControl: "public, max-age=604800", // 7 days
    })
  );

  return `https://media.miniop.com/${key}`;
}

export async function getSignedVideoUrl(key: string, expiresIn = 3600) {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(r2Client, command, { expiresIn });
}
```

### Cloudflare Cache Rules

Configure caching behavior through the Cloudflare dashboard or API:

```bash
# Create a cache rule via Cloudflare API
curl -X POST "https://api.cloudflare.com/client/v4/zones/{zone_id}/rules" \
  -H "Authorization: Bearer {api_token}" \
  -H "Content-Type: application/json" \
  --data '{
    "rules": [
      {
        "expression": "(http.request.uri.path contains \"/api/thumbnails/\")",
        "action": "cache",
        "action_parameters": {
          "browser_ttl": { "mode": "override_origin", "default": 86400 },
          "edge_ttl": { "mode": "override_origin", "default": 604800 },
          "serve_stale": { "disable_stale_while_updating": false },
          "cache_key": {
            "custom_key": {
              "query_string": { "include": "*" },
              "header": { "include": ["Accept", "Accept-Encoding"] }
            }
          }
        }
      },
      {
        "expression": "(http.request.uri.path contains \"/api/waveforms/\")",
        "action": "cache",
        "action_parameters": {
          "browser_ttl": { "mode": "override_origin", "default": 3600 },
          "edge_ttl": { "mode": "override_origin", "default": 86400 }
        }
      }
    ]
  }'
```

### Cloudflare Transform Rules for Cache Headers

Set cache-control headers on R2 responses at the edge:

```typescript
// Cloudflare Worker for R2 with cache headers
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key = url.pathname.slice(1); // Remove leading slash

    // Check Cloudflare cache first
    const cache = caches.default;
    const cacheKey = new Request(request.url, request);
    let response = await cache.match(cacheKey);

    if (response) {
      return response;
    }

    // Fetch from R2
    const object = await env.MINIO_MEDIA_BUCKET.get(key);

    if (!object) {
      return new Response("Not Found", { status: 404 });
    }

    const headers = new Headers();
    headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
    headers.set("ETag", object.etag);
    headers.set("Access-Control-Allow-Origin", "https://miniop.com");

    // Set cache control based on file type
    if (key.endsWith(".webp") || key.endsWith(".jpg")) {
      headers.set("Cache-Control", "public, max-age=604800, stale-while-revalidate=86400");
    } else if (key.endsWith(".mp4")) {
      headers.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=3600");
    } else {
      headers.set("Cache-Control", "public, max-age=3600");
    }

    response = new Response(object.body, { headers });

    // Store in Cloudflare cache
    await cache.put(cacheKey, response.clone());
    return response;
  },
};
```

## Scaled Production: Multi-CDN with Purging and Image Resizing

For production deployments serving 50,000+ users across regions, implement Cloudflare Pro/Business with image resizing, cache purging on upload, and origin shielding.

### Cloudflare Image Resizing for Thumbnails

Generate responsive thumbnails at the edge instead of pre-generating all sizes:

```typescript
// Request resized thumbnails through Cloudflare
export function getThumbnailUrl(
  originalUrl: string,
  width: number,
  height: number,
  quality = 80
): string {
  // Cloudflare Image Resizing format
  return `https://miniop.com/cdn-cgi/image/width=${width},height=${height},quality=${quality},format=auto/${originalUrl}`;
}

// Usage in React component
export function ResponsiveThumbnail({
  clipId,
  userId,
}: {
  clipId: string;
  userId: string;
}) {
  const base = `https://media.miniop.com/clips/${userId}/${clipId}/thumb.webp`;

  return (
    <picture>
      <source
        srcSet={`${getThumbnailUrl(base, 640, 360)} 640w, ${getThumbnailUrl(base, 1280, 720)} 1280w`}
        sizes="(max-width: 640px) 100vw, 640px"
        type="image/webp"
      />
      <img
        src={getThumbnailUrl(base, 320, 180)}
        alt={`Clip ${clipId}`}
        loading="lazy"
        width={320}
        height={180}
      />
    </picture>
  );
}
```

### Cache Purging on Content Update

When a clip's thumbnail or video is replaced, purge the CDN cache to prevent stale content:

```typescript
// lib/cdn-purge.ts
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID!;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN!;

export async function purgeUrls(urls: string[]) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ files: urls }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Cache purge failed: ${error}`);
  }

  return response.json();
}

export async function purgeClipCache(userId: string, clipId: string) {
  await purgeUrls([
    `https://media.miniop.com/clips/${userId}/${clipId}/thumb.webp`,
    `https://media.miniop.com/clips/${userId}/${clipId}/video.mp4`,
    `https://miniop.com/cdn-cgi/image/*/${userId}/${clipId}/thumb.webp`,
  ]);
}

// Purge by prefix (Cloudflare Enterprise feature or use tags)
export async function purgeUserCache(userId: string) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        hosts: ["media.miniop.com"],
        tags: [`user:${userId}`],
      }),
    }
  );

  return response.json();
}
```

### Origin Shield Configuration

Enable Cloudflare's origin shield to reduce origin load during cache misses:

```bash
# Enable Origin Shield via API
curl -X PATCH "https://api.cloudflare.com/client/v4/zones/{zone_id}/settings/origin_shield" \
  -H "Authorization: Bearer {api_token}" \
  -H "Content-Type: application/json" \
  --data '{
    "value": {
      "enabled": true,
      "region": "WNAM"
    }
  }'
```

### Cache Reserve for Long-Term Storage

Enable Cache Reserve to persist assets in Cloudflare's storage layer beyond edge cache TTLs:

```bash
curl -X PATCH "https://api.cloudflare.com/client/v4/zones/{zone_id}/cache/cache_reserve" \
  -H "Authorization: Bearer {api_token}" \
  -H "Content-Type: application/json" \
  --data '{
    "value": {
      "eligible": true,
      "min_non_zero_ttl": 2592000
    }
  }'
```

### Monitoring Cache Performance

Track cache hit ratios and bandwidth savings:

```bash
# Query Cloudflare Analytics API
curl "https://api.cloudflare.com/client/v4/zones/{zone_id}/analytics/dashboard?since=-1440&until=0&continuous=true" \
  -H "Authorization: Bearer {api_token}" | jq '.result.timeseries[] | {ts: .ts, cached: .caching.bandwidth.cached, uncached: .caching.bandwidth.uncached}'
```

Key metrics:
- **Cache hit ratio**: Target above 85% for thumbnails and above 70% for API responses
- **Bandwidth saved**: Track the percentage served from cache vs origin
- **Edge response time**: p95 should be under 50ms for cached content
- **Origin requests per second**: Should be a fraction of total requests with proper caching

### Cache Key Strategy

Design cache keys to maximize hit rates while preventing cache poisoning:

```typescript
// Cloudflare Worker cache key construction
function buildCacheKey(request: Request): string {
  const url = new URL(request.url);

  // Strip tracking params that don't affect content
  url.searchParams.delete("utm_source");
  url.searchParams.delete("utm_medium");
  url.searchParams.delete("utm_campaign");
  url.searchParams.delete("_t");

  // Normalize Accept header for image format negotiation
  const accept = request.headers.get("Accept") || "";
  const format = accept.includes("image/avif")
    ? "avif"
    : accept.includes("image/webp")
      ? "webp"
      : "original";

  return `${url.pathname}${url.search}?cf_format=${format}`;
}
```

A properly configured CDN layer reduces MiniOp's Time to First Byte from 300ms to under 30ms for static assets, cuts origin bandwidth costs by 80-90%, and provides the global distribution needed for users accessing video content from any region.
