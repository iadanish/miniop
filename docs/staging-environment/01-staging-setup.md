# Staging Environment Setup

## Overview

MiniOp's staging environment mirrors production with isolated infrastructure for testing video processing pipelines, AI model integrations, and deployment workflows before reaching end users. This document covers setup for both free-tier development (individual contributors) and scaled production staging (team/enterprise).

---

## Free Tier Setup

### Supabase Branching

Supabase branching provides database isolation per pull request without provisioning separate infrastructure.

```bash
# Install Supabase CLI
npm install -g supabase

# Link to your project
supabase link --project-ref your-project-ref

# Enable branching in dashboard: Settings > Branching
# Each PR automatically gets a branched database
```

Configure branching in `supabase/config.toml`:

```toml
[branching]
enabled = true
production_branch = "main"

[db]
major_version = 15
port = 54322
shadow_port = 54320

[auth]
site_url = "http://localhost:3000"
additional_redirect_urls = ["https://localhost:3000"]

[storage]
file_size_limit = "50MB"
```

Run migrations against the branch:

```bash
# Push migrations to branched database
supabase db push

# Generate types for the branch
supabase gen types typescript --linked > src/types/supabase.ts

# Reset branch if needed
supabase db reset --linked
```

### Vercel Preview Deployments

Vercel preview deployments give each PR a unique URL with full MiniOp functionality.

```json
// vercel.json
{
  "framework": "nextjs",
  "buildCommand": "npm run build",
  "installCommand": "npm install",
  "env": {
    "NEXT_PUBLIC_SUPABASE_URL": "@supabase-url",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY": "@supabase-anon-key",
    "SUPABASE_SERVICE_ROLE_KEY": "@supabase-service-role-key",
    "OPENAI_API_KEY": "@openai-api-key",
    "AWS_ACCESS_KEY_ID": "@aws-access-key-id",
    "AWS_SECRET_ACCESS_KEY": "@aws-secret-access-key"
  },
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [
        { "key": "Access-Control-Allow-Origin", "value": "*" }
      ]
    }
  ]
}
```

Environment variable scoping in Vercel:

```bash
# Set preview-only environment variables via CLI
vercel env add NEXT_PUBLIC_SUPABASE_URL preview
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY preview
vercel env add SUPABASE_SERVICE_ROLE_KEY preview

# These override production values only in preview deployments
```

### Local Development Stack

```yaml
# docker-compose.staging.yml
version: "3.9"

services:
  minio-op:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=staging
      - NEXT_PUBLIC_SUPABASE_URL=http://kong:8000
      - NEXT_PUBLIC_SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
      - DATABASE_URL=postgresql://postgres:postgres@db:5432/minioop
    depends_on:
      - db
      - kong
      - storage

  db:
    image: supabase/postgres:15.1.0
    ports:
      - "54322:5432"
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: minioop
    volumes:
      - ./supabase/migrations:/docker-entrypoint-initdb.d
      - postgres_data:/var/lib/postgresql/data

  kong:
    image: kong:2.8.1
    ports:
      - "8000:8000"
      - "8443:8443"
    environment:
      KONG_DATABASE: "off"
      KONG_DECLARATIVE_CONFIG: /var/lib/kong/kong.yml

  storage:
    image: supabase/storage-api:v0.46.4
    ports:
      - "5000:5000"
    environment:
      ANON_KEY: ${SUPABASE_ANON_KEY}
      SERVICE_KEY: ${SUPABASE_SERVICE_ROLE_KEY}
      POSTGREST_URL: http://rest:3000
      PGRST_JWT_SECRET: ${JWT_SECRET}

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  postgres_data:
```

Start the stack:

```bash
docker compose -f docker-compose.staging.yml up -d
npx supabase db push
npm run dev
```

---

## Scaled Production Staging

### Infrastructure Provisioning

For teams requiring dedicated staging infrastructure:

```bash
# Terraform configuration for staging environment
# infra/staging/main.tf

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket = "minioop-terraform-state"
    key    = "staging/terraform.tfstate"
    region = "us-east-1"
  }
}

provider "aws" {
  region = "us-east-1"
}

module "vpc" {
  source = "./modules/vpc"

  environment = "staging"
  cidr_block  = "10.1.0.0/16"
}

module "ecs" {
  source = "./modules/ecs"

  environment    = "staging"
  vpc_id         = module.vpc.vpc_id
  subnet_ids     = module.vpc.private_subnet_ids
  container_port = 3000
  cpu            = 512
  memory         = 1024
  desired_count  = 2
}

module "rds" {
  source = "./modules/rds"

  environment        = "staging"
  instance_class     = "db.t3.medium"
  allocated_storage  = 50
  engine_version     = "15.4"
  multi_az           = false
  vpc_id             = module.vpc.vpc_id
  subnet_ids         = module.vpc.database_subnet_ids
}

module "elasticache" {
  source = "./modules/elasticache"

  environment    = "staging"
  node_type      = "cache.t3.micro"
  num_cache_nodes = 1
  vpc_id         = module.vpc.vpc_id
  subnet_ids     = module.vpc.private_subnet_ids
}

module "s3" {
  source = "./modules/s3"

  environment = "staging"
  bucket_name = "minioop-staging-media"
}

module "cloudfront" {
  source = "./modules/cloudfront"

  environment       = "staging"
  s3_bucket_id      = module.s3.bucket_id
  s3_bucket_arn     = module.s3.bucket_arn
  acm_certificate_arn = var.acm_certificate_arn
  domain_name       = "staging.minioop.example.com"
}
```

Apply staging infrastructure:

```bash
cd infra/staging
terraform init
terraform plan -out=staging.tfplan
terraform apply staging.tfplan
```

### Supabase Self-Hosted Staging

Deploy Supabase to your staging infrastructure:

```yaml
# infra/staging/supabase/docker-compose.yml
version: "3.9"

services:
  studio:
    image: supabase/studio:20240101-40fb968
    ports:
      - "3001:3000"
    environment:
      STUDIO_PG_META_URL: http://meta:8080
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      SUPABASE_URL: http://kong:8000
      SUPABASE_ANON_KEY: ${ANON_KEY}
      SUPABASE_SERVICE_KEY: ${SERVICE_ROLE_KEY}

  kong:
    image: kong:2.8.1
    ports:
      - "8000:8000"
    environment:
      KONG_DATABASE: "off"
      KONG_DECLARATIVE_CONFIG: /var/lib/kong/kong.yml
    volumes:
      - ./volumes/api/kong.yml:/var/lib/kong/kong.yml:ro

  auth:
    image: supabase/gotrue:v2.132.3
    environment:
      GOTRUE_DB_DRIVER: postgres
      API_EXTERNAL_URL: https://staging.minioop.example.com
      GOTRUE_SITE_URL: https://staging.minioop.example.com
      GOTRUE_JWT_SECRET: ${JWT_SECRET}

  rest:
    image: supabase/postgrest:v12.0.2
    environment:
      PGRST_DB_URI: postgres://postgres:${POSTGRES_PASSWORD}@db:5432/minioop
      PGRST_DB_SCHEMAS: public,storage
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: ${JWT_SECRET}

  realtime:
    image: supabase/realtime:v2.25.35
    environment:
      DB_HOST: db
      DB_NAME: minioop
      DB_PASSWORD: ${POSTGRES_PASSWORD}
      SECRET_KEY_BASE: ${SECRET_KEY_BASE}

  storage:
    image: supabase/storage-api:v0.46.4
    environment:
      ANON_KEY: ${ANON_KEY}
      SERVICE_KEY: ${SERVICE_ROLE_KEY}
      TENANT_ID: staging
      REGION: us-east-1
      GLOBAL_S3_BUCKET: minioop-staging-media

  meta:
    image: supabase/postgres-meta:v0.75.0
    environment:
      PG_META_DB_HOST: db
      PG_META_DB_PASSWORD: ${POSTGRES_PASSWORD}

  db:
    image: supabase/postgres:15.1.0
    ports:
      - "5432:5432"
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./volumes/db/realtime.sql:/docker-entrypoint-initdb.d/realtime.sql

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  postgres_data:
```

### Environment Configuration

Create staging-specific environment files:

```bash
# .env.staging
NODE_ENV=staging
NEXT_PUBLIC_APP_URL=https://staging.minioop.example.com
NEXT_PUBLIC_SUPABASE_URL=https://staging.minioop.example.com
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...  # staging anon key

DATABASE_URL=postgresql://postgres:password@staging-rds.internal:5432/minioop
REDIS_URL=redis://staging-redis.internal:6379

OPENAI_API_KEY=sk-staging-...
AWS_REGION=us-east-1
AWS_S3_BUCKET=minioop-staging-media
AWS_CLOUDFRONT_DISTRIBUTION_ID=E1STAGING123

STRIPE_SECRET_KEY=sk_test_...  # test keys for staging
STRIPE_WEBHOOK_SECRET=whsec_staging_...

LOG_LEVEL=debug
ENABLE_DEBUG_ENDPOINTS=true
```

### CI/CD Pipeline

GitHub Actions workflow for staging deployment:

```yaml
# .github/workflows/staging.yml
name: Deploy to Staging

on:
  push:
    branches: [staging]
  pull_request:
    branches: [main]

concurrency:
  group: staging-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: supabase/postgres:15.1.0
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: minioop_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci

      - name: Run migrations
        run: npx supabase db push
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/minioop_test

      - run: npm run test:unit
      - run: npm run test:integration
      - run: npm run lint
      - run: npm run typecheck

  deploy-staging:
    needs: test
    if: github.ref == 'refs/heads/staging'
    runs-on: ubuntu-latest
    environment: staging

    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1

      - name: Login to ECR
        id: ecr-login
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push image
        env:
          ECR_REGISTRY: ${{ steps.ecr-login.outputs.registry }}
          IMAGE_TAG: ${{ github.sha }}
        run: |
          docker build -t $ECR_REGISTRY/minioop:$IMAGE_TAG .
          docker push $ECR_REGISTRY/minioop:$IMAGE_TAG

      - name: Deploy to ECS
        run: |
          aws ecs update-service \
            --cluster minioop-staging \
            --service minioop-staging \
            --force-new-deployment

      - name: Run migrations
        run: |
          aws ecs run-task \
            --cluster minioop-staging \
            --task-definition minioop-migrate-staging \
            --network-configuration "awsvpcConfiguration={subnets=[subnet-staging-1],securityGroups=[sg-staging]}"

      - name: Wait for service stability
        run: |
          aws ecs wait services-stable \
            --cluster minioop-staging \
            --services minioop-staging

      - name: Run smoke tests
        run: npm run test:smoke -- --env=staging
        env:
          STAGING_URL: https://staging.minioop.example.com
```

---

## DNS and SSL

Configure staging subdomain:

```bash
# Route 53 record
aws route53 change-resource-record-sets \
  --hosted-zone-id Z1234567890 \
  --change-batch '{
    "Changes": [{
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "staging.minioop.example.com",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "Z2FDTNDATAQYW2",
          "DNSName": "d1234.cloudfront.net",
          "EvaluateTargetHealth": false
        }
      }
    }]
  }'
```

Request ACM certificate:

```bash
aws acm request-certificate \
  --domain-name "*.minioop.example.com" \
  --validation-method DNS \
  --region us-east-1
```

---

## Health Checks

Add staging health endpoint:

```typescript
// src/app/api/health/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Redis from 'ioredis';

export async function GET() {
  const checks: Record<string, { status: string; latency?: number }> = {};

  // Database check
  const dbStart = Date.now();
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    await supabase.from('videos').select('id').limit(1);
    checks.database = { status: 'healthy', latency: Date.now() - dbStart };
  } catch (error) {
    checks.database = { status: 'unhealthy', latency: Date.now() - dbStart };
  }

  // Redis check
  const redisStart = Date.now();
  try {
    const redis = new Redis(process.env.REDIS_URL!);
    await redis.ping();
    await redis.quit();
    checks.redis = { status: 'healthy', latency: Date.now() - redisStart };
  } catch (error) {
    checks.redis = { status: 'unhealthy', latency: Date.now() - redisStart };
  }

  const allHealthy = Object.values(checks).every(c => c.status === 'healthy');

  return NextResponse.json(
    {
      status: allHealthy ? 'healthy' : 'degraded',
      environment: process.env.NODE_ENV,
      version: process.env.VERCEL_GIT_COMMIT_SHA || 'unknown',
      checks,
      timestamp: new Date().toISOString(),
    },
    { status: allHealthy ? 200 : 503 }
  );
}
```

Verify staging is running:

```bash
curl -s https://staging.minioop.example.com/api/health | jq .
```

---

## Next Steps

Once staging is operational, proceed to [02-staging-workflow.md](./02-staging-workflow.md) for the development workflow and [03-smoke-testing.md](./03-smoke-testing.md) for validation procedures.
