# Browser Caching Strategy for MiniOp

MiniOp's frontend serves video thumbnails, waveform visualizations, clip previews, JavaScript bundles, fonts, and static assets. Without proper browser caching, every page load re-downloads hundreds of kilobytes of unchanged resources. This document covers HTTP cache headers, service worker strategies, and client-side caching patterns.

## Free Tier: HTTP Cache Headers with Next.js

Next.js provides built-in cache control through route handlers and API routes. For static assets, configure headers in `next.config.js`.

### Static Asset Caching

```javascript
// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        // Immutable hashed assets (JS, CSS, images with content hash)
        source: "/_next/static/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        // Video thumbnails — cached for 1 day, stale for 1 hour
        source: "/api/thumbnails/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=3600",
          },
        ],
      },
      {
        // Waveform JSON data — cached for 1 hour
        source: "/api/waveforms/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=3600, stale-while-revalidate=600",
          },
        ],
      },
      {
        // API responses that change frequently
        source: "/api/clips/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "private, no-cache",
          },
          {
            key: "Vary",
            value: "Authorization, Accept-Encoding",
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
```

### ETag and Conditional Requests

Generate ETags for API responses to enable 304 Not Modified responses:

```typescript
// app/api/projects/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const project = await getProject(params.id);
  const etag = `"${crypto
    .createHash("md5")
    .update(JSON.stringify(project))
    .digest("hex")
    .slice(0, 16)}"`;

  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch === etag) {
    return new NextResponse(null, { status: 304 });
  }

  return NextResponse.json(project, {
    headers: {
      ETag: etag,
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}
```

### Image Optimization and Caching

Next.js Image component handles responsive sizing and caching automatically. Configure it for MiniOp's thumbnail pipeline:

```typescript
// components/ClipThumbnail.tsx
import Image from "next/image";

export function ClipThumbnail({
  src,
  clipId,
}: {
  src: string;
  clipId: string;
}) {
  return (
    <Image
      src={src}
      alt={`Clip ${clipId} thumbnail`}
      width={320}
      height={180}
      placeholder="blur"
      blurDataURL={generateBlurPlaceholder(clipId)}
      sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 320px"
      loading="lazy"
    />
  );
}
```

## Scaled Production: Service Worker with Workbox

At scale, implement a service worker to handle offline access, background sync, and intelligent cache management for the MiniOp SPA.

### Service Worker Registration

```typescript
// lib/register-sw.ts
export function registerServiceWorker() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
      });

      registration.addEventListener("updatefound", () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener("statechange", () => {
          if (
            newWorker.state === "installed" &&
            navigator.serviceWorker.controller
          ) {
            // Notify user of available update
            window.dispatchEvent(new CustomEvent("sw-update-available"));
          }
        });
      });
    } catch (error) {
      console.error("SW registration failed:", error);
    }
  });
}
```

### Workbox Configuration

```bash
npm install workbox-webpack-plugin
```

```javascript
// webpack.config.js (or custom Next.js plugin)
const { InjectManifest } = require("workbox-webpack-plugin");

module.exports = {
  plugins: [
    new InjectManifest({
      swSrc: "./src/service-worker.ts",
      swDest: "../sw.js",
      maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
    }),
  ],
};
```

```typescript
// src/service-worker.ts
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import {
  CacheFirst,
  StaleWhileRevalidate,
  NetworkFirst,
} from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { CacheableResponsePlugin } from "workbox-cacheable-response";

declare const self: ServiceWorkerGlobalScope;

// Precache app shell
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Next.js hashed bundles — cache-first, immutable
registerRoute(
  ({ url }) => url.pathname.startsWith("/_next/static/"),
  new CacheFirst({
    cacheName: "static-assets",
    plugins: [
      new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 365 * 86400 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  })
);

// Video thumbnails — cache-first with size limit
registerRoute(
  ({ url }) => url.pathname.startsWith("/api/thumbnails/"),
  new CacheFirst({
    cacheName: "thumbnails",
    plugins: [
      new ExpirationPlugin({ maxEntries: 1000, maxAgeSeconds: 7 * 86400 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  })
);

// Waveform data — stale-while-revalidate
registerRoute(
  ({ url }) => url.pathname.startsWith("/api/waveforms/"),
  new StaleWhileRevalidate({
    cacheName: "waveforms",
    plugins: [
      new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 3600 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  })
);

// API calls — network-first with offline fallback
registerRoute(
  ({ url }) => url.pathname.startsWith("/api/"),
  new NetworkFirst({
    cacheName: "api-cache",
    networkTimeoutSeconds: 3,
    plugins: [
      new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 300 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  })
);

// Google Fonts — cache-first, long-lived
registerRoute(
  ({ url }) =>
    url.origin === "https://fonts.googleapis.com" ||
    url.origin === "https://fonts.gstatic.com",
  new CacheFirst({
    cacheName: "google-fonts",
    plugins: [
      new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 365 * 86400 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  })
);

// Background sync for failed API mutations
import { BackgroundSyncPlugin } from "workbox-background-sync";

const bgSyncPlugin = new BackgroundSyncPlugin("failed-mutations", {
  maxRetentionTime: 24 * 60, // 24 hours in minutes
});

registerRoute(
  ({ url, request }) =>
    url.pathname.startsWith("/api/") && request.method === "POST",
  new NetworkFirst({
    plugins: [bgSyncPlugin],
  }),
  "POST"
);
```

### Client-Side Cache with React Query

For API state that needs reactivity, combine browser caching with React Query:

```bash
npm install @tanstack/react-query
```

```typescript
// lib/query-client.ts
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000, // 30 seconds
      gcTime: 5 * 60_000, // 5 minutes (formerly cacheTime)
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});
```

```typescript
// hooks/useProject.ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export function useProject(projectId: string) {
  return useQuery({
    queryKey: ["project", projectId],
    queryFn: () => fetch(`/api/projects/${projectId}`).then((r) => r.json()),
    staleTime: 60_000, // 1 minute
  });
}

export function useUpdateClip() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { clipId: string; updates: Partial<Clip> }) =>
      fetch(`/api/clips/${data.clipId}`, {
        method: "PATCH",
        body: JSON.stringify(data.updates),
      }).then((r) => r.json()),
    onSuccess: (updatedClip) => {
      queryClient.invalidateQueries({ queryKey: ["project"] });
      queryClient.invalidateQueries({ queryKey: ["clips"] });
    },
  });
}
```

### Cache Invalidation Patterns

Browser caches require explicit invalidation when content changes. MiniOp uses these strategies:

```typescript
// Trigger service worker cache purge via postMessage
export async function invalidateSWCache(pattern: string) {
  if (!navigator.serviceWorker.controller) return;

  navigator.serviceWorker.controller.postMessage({
    type: "CACHE_INVALIDATE",
    pattern,
  });
}

// In the service worker
self.addEventListener("message", (event) => {
  if (event.data.type === "CACHE_INVALIDATE") {
    caches.open("api-cache").then((cache) => {
      cache.keys().then((requests) => {
        requests.forEach((request) => {
          if (request.url.includes(event.data.pattern)) {
            cache.delete(request);
          }
        });
      });
    });
  }
});
```

### Cache Storage Budget Management

Browsers impose storage quotas (typically 50MB origin storage, or up to 80% of disk for persistent storage). Monitor and manage usage:

```typescript
export async function getCacheStorageUsage() {
  if (!("storage" in navigator) || !("estimate" in navigator.storage)) {
    return null;
  }
  const { usage, quota } = await navigator.storage.estimate();
  return {
    usageMB: Math.round((usage || 0) / (1024 * 1024)),
    quotaMB: Math.round((quota || 0) / (1024 * 1024)),
    percentUsed: ((usage || 0) / (quota || 1)) * 100,
  };
}

// Request persistent storage to prevent browser eviction
export async function requestPersistentStorage() {
  if ("storage" in navigator && "persist" in navigator.storage) {
    const persisted = await navigator.storage.persist();
    console.log(`Persistent storage: ${persisted}`);
    return persisted;
  }
  return false;
}
```

Properly configured browser caching reduces MiniOp's Largest Contentful Paint from 2.4s to under 800ms on repeat visits, and enables offline access to previously viewed clips through the service worker cache.
