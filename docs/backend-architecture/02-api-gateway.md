# API Gateway — MiniOp Video Clipping Platform

## Role of the API Gateway

The API gateway is the single entry point for all external traffic. It sits in front of the application servers and handles cross-cutting concerns that don't belong in application code: TLS termination, request routing, rate limiting, CORS, and DDoS protection. The gateway is configured declaratively and updated independently of the application.

MiniOp uses three gateway strategies depending on deployment tier:

- **Free tier (serverless):** Supabase Edge Functions — zero-cost, zero-ops, runs alongside the Supabase database
- **Self-hosted single-instance:** Caddy — zero-config HTTPS and reverse proxying for a single-server deployment
- **Scaled production:** Kong + AWS ALB — full plugin ecosystem, horizontal scaling, WAF integration

## Supabase Edge Functions — Free-Tier Gateway

For the free-tier serverless deployment, Supabase Edge Functions serve as the API gateway. They run on Deno's edge runtime with zero cold-start overhead and are included in Supabase's free tier (500K invocations/month). This keeps the entire free-tier stack within a single platform.

**Core gateway function:**

```typescript
// supabase/functions/api-gateway/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://app.minio.dev",
  "http://localhost:3000",
];

function corsHeaders(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  };
}

serve(async (req) => {
  const origin = req.headers.get("Origin");
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null(), { status: 204, headers });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing auth" }), {
      status: 401,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }

  const { data: { user } } = await supabase.auth.getUser(
    authHeader.replace("Bearer ", "")
  );
  if (!user) {
    return new Response(JSON.stringify({ error: "Invalid token" }), {
      status: 401,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  if (path.endsWith("/jobs") && req.method === "POST") {
    const body = await req.json();
    const { data, error } = await supabase
      .from("processing_queue")
      .insert({ project_id: body.project_id, payload: body, priority: 0 })
      .select()
      .single();

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ job_id: data.id }), {
      status: 200,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { ...headers, "Content-Type": "application/json" },
  });
});
```

**Deploy:**

```bash
supabase functions deploy api-gateway
```

The Edge Function handles auth verification, CORS, and request routing. Rate limiting is enforced at the Supabase platform level (500K invocations/month on free tier). No additional gateway software is needed.

## Caddy — Self-Hosted Gateway

For the free-tier single-server deployment, Caddy provides zero-config HTTPS and reverse proxying:

```caddyfile
# Caddyfile
api.minio.dev {
    # Automatic HTTPS via Let's Encrypt
    tls internal

    # Security headers
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        Referrer-Policy strict-origin-when-cross-origin
    }

    # Rate limiting handled by the app layer
    reverse_proxy localhost:8080 {
        health_uri /healthz
        health_interval 10s
        health_timeout 5s
    }
}

# Public clip sharing (no auth required)
clips.minio.dev {
    tls internal
    reverse_proxy localhost:8080
}
```

Start Caddy:

```bash
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
```

Caddy handles TLS certificate renewal automatically. No certbot, no cron jobs.

## Kong — Production Gateway

Production uses Kong with the following plugin stack:

```yaml
# kong.yml (declarative config)
_format_version: "3.0"

services:
  - name: minio-api
    url: http://minio-api.internal:8080
    routes:
      - name: api-v1
        paths: ["/v1"]
        strip_path: false
      - name: api-v2
        paths: ["/v2"]
        strip_path: false
    plugins:
      - name: rate-limiting
        config:
          minute: 30
          policy: redis
          redis:
            host: redis.internal
            port: 6379
      - name: cors
        config:
          origins:
            - "https://app.minio.dev"
            - "https://minio.dev"
          methods: [GET, POST, PUT, DELETE, OPTIONS]
          headers: [Authorization, Content-Type]
          max_age: 86400
      - name: ip-restriction
        config:
          deny: []
          allow: []
      - name: bot-detection
      - name: request-size-limiting
        config:
          allowed_payload_size: 50
          size_unit: megabytes

  - name: minio-public
    url: http://minio-api.internal:8080
    routes:
      - name: public-clips
        paths: ["/v1/public"]
        strip_path: false
    plugins:
      - name: rate-limiting
        config:
          minute: 60
          policy: redis
          redis:
            host: redis.internal
            port: 6379
```

Apply the configuration:

```bash
# Sync declarative config
kong config db_import kong.yml

# Or for DB-less mode
kong start -c kong.conf --declarative-config kong.yml
```

## Per-Tier Rate Limiting

Kong's rate-limiting plugin supports per-consumer limits via ACL groups:

```yaml
# Consumer definitions per tier
consumers:
  - username: free-user-group
    acls:
      - group: free
  - username: pro-user-group
    acls:
      - group: pro
  - username: enterprise-user-group
    acls:
      - group: enterprise

plugins:
  - name: rate-limiting
    config:
      policy: redis
      redis:
        host: redis.internal
        port: 6379
      hide_client_headers: false
    consumer_group: free
    config:
      minute: 30

  - name: rate-limiting
    config:
      policy: redis
      redis:
        host: redis.internal
        port: 6379
    consumer_group: pro
    config:
      minute: 120

  - name: rate-limiting
    config:
      policy: redis
      redis:
        host: redis.internal
        port: 6379
    consumer_group: enterprise
    config:
      minute: 600
```

## TLS Configuration

Production TLS terminates at the load balancer (AWS ALB) before reaching Kong. Internal traffic between Kong and the API servers uses plain HTTP within the VPC:

```
Client → ALB (TLS) → Kong (HTTP) → API Server (HTTP)
```

ALB certificate management via ACM:

```bash
# Request certificate
aws acm request-certificate \
  --domain-name api.minio.dev \
  --subject-alternative-names "*.minio.dev" \
  --validation-method DNS

# ALB listener config
aws elbv2 create-listener \
  --load-balancer-arn $ALB_ARN \
  --protocol HTTPS \
  --port 443 \
  --certificates CertificateArn=$CERT_ARN \
  --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06
```

For the free tier, Caddy handles TLS directly with automatic Let's Encrypt certificates.

## Request Tracing

Every request gets a unique `X-Request-ID` that flows through the entire stack:

```go
// Kong adds the request ID (or uses the client-provided one)
// The Go middleware ensures it's propagated:

func RequestID(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        reqID := r.Header.Get("X-Request-ID")
        if reqID == "" {
            reqID = "req_" + uuid.New().String()[:8]
        }

        w.Header().Set("X-Request-ID", reqID)
        ctx := context.WithValue(r.Context(), requestIDKey{}, reqID)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

All log entries include the request ID, making it possible to trace a single request across API server, worker, and database logs:

```json
{"level":"INFO","msg":"clip created","request_id":"req_8f3a2b1c","user_id":"usr_abc","clip_id":"clip_xyz"}
{"level":"INFO","msg":"job queued","request_id":"req_8f3a2b1c","job_id":"job_001","type":"transcription"}
{"level":"INFO","msg":"job completed","request_id":"req_8f3a2b1c","job_id":"job_001","duration_ms":4200}
```

## Health Check Endpoints

The gateway uses health checks to route traffic only to healthy instances:

```yaml
# Kong upstream health checks
upstreams:
  - name: minio-api
    healthchecks:
      active:
        http_path: /healthz
        healthy:
          interval: 10
          successes: 2
        unhealthy:
          interval: 10
          http_failures: 3
          timeouts: 3
      passive:
        healthy:
          successes: 5
        unhealthy:
          http_failures: 5
          timeouts: 3
```

The `/healthz` endpoint returns `200 ok` immediately. The `/readyz` endpoint checks database and Redis connectivity — the load balancer uses `/readyz` for traffic routing.

## WebSocket Support (Future)

When real-time job progress updates are added, Kong supports WebSocket proxying:

```yaml
services:
  - name: minio-ws
    url: http://minio-api.internal:8080/ws
    routes:
      - name: websocket
        paths: ["/ws"]
        protocols: [ws, wss]
    plugins:
      - name: rate-limiting
        config:
          minute: 10  # Max 10 new WS connections per minute
```

## DDoS Protection

Layer 1: AWS Shield Standard (automatic, free with ALB)
Layer 2: AWS WAF rules attached to the ALB:

```hcl
# terraform/waf.tf
resource "aws_wafv2_web_acl" "api" {
  name  = "minio-api-waf"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "rate-limit"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 2000  # requests per 5 minutes per IP
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name               = "RateLimitRule"
      sampled_requests_enabled  = true
    }
  }

  rule {
    name     = "aws-managed-common"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name               = "AWSManagedRules"
      sampled_requests_enabled  = true
    }
  }
}
```

Layer 3: Application-level rate limiting via Kong (described above).

## Free-Tier vs Self-Hosted vs Production Comparison

| Concern | Free Tier (Supabase Edge Functions) | Self-Hosted (Caddy) | Production (Kong + ALB) |
|---------|-------------------------------------|---------------------|------------------------|
| TLS | Supabase-managed | Caddy auto-Let's Encrypt | AWS ACM + ALB termination |
| Rate limiting | Platform-level (500K invocations/mo) | Application-level (Redis) | Kong plugin + WAF |
| Load balancing | Supabase edge network | Single instance, no LB | ALB with health checks |
| DDoS | Supabase platform | Fail2ban + app rate limit | Shield + WAF + Kong |
| Observability | Supabase dashboard | File logs | Structured logs → CloudWatch |
| Config | TypeScript Edge Functions | Caddyfile | Declarative kong.yml |
| Cost | $0 (free tier) | $0 (self-hosted) | $5+/month |

## Deployment Commands

```bash
# Free tier: deploy Edge Functions
supabase functions deploy api-gateway

# Self-hosted: start Caddy
docker compose up -d

# Production: deploy via Helm
helm upgrade --install minio-gateway ./charts/gateway \
  --namespace minio \
  --set image.tag=v1.2.3 \
  --set replicaCount=3

# Verify gateway health
curl -s https://api.minio.dev/healthz
# → ok
```
