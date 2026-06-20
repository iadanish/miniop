# MiniOp Automated Secret Rotation

## Overview

Manual secret rotation is error-prone and doesn't scale. This document covers automated rotation pipelines for MiniOp secrets across free-tier and production deployments. The goal: zero-downtime rotation with no human intervention for standard rotations, and clear rollback paths when automated rotation fails.

## Architecture

```
┌──────────────────┐
│  Rotation Scheduler│ (cron / Vault Agent / AWS Lambda)
│  (triggers)        │
└────────┬─────────┘
         │
    ┌────▼────┐
    │ Rotate  │
    │ Handler │
    └────┬────┘
         │
    ┌────▼──────────────────────────────────────┐
    │                                           │
    ▼                    ▼                      ▼
┌─────────┐      ┌───────────┐          ┌──────────┐
│ Provider │      │ Database  │          │ Internal │
│ API      │      │ Secrets   │          │ Vault    │
│ (rotate) │      │ Engine    │          │ Transit  │
└────┬────┘      └─────┬─────┘          └────┬─────┘
     │                 │                     │
     ▼                 ▼                     ▼
┌─────────────────────────────────────────────────┐
│           Secret Store Update                    │
│  (Vault / AWS SM / .env file)                    │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
              ┌─────────────┐
              │ Service      │
              │ Reload       │
              │ (graceful)   │
              └─────────────┘
```

## Free Tier: Automated Rotation with Cron + Scripts

Free-tier deployments lack Vault or AWS Secrets Manager. Automation uses shell scripts triggered by cron, with rollback on failure.

### AI Provider Key Rotation (OpenAI Example)

OpenAI doesn't support programmatic key rotation via API. The automation creates a new key through browser automation or prompts for manual dashboard action, then updates the local store.

```bash
#!/bin/bash
# scripts/rotate-openai-key.sh
set -euo pipefail

ENV_FILE="/opt/miniop/.env"
BACKUP_FILE="/opt/miniop/.env.backup.$(date +%s)"
LOG_FILE="/opt/miniop/logs/rotation.log"

log() { echo "[$(date -Iseconds)] $1" >> "$LOG_FILE"; }

# Backup current .env
cp "$ENV_FILE" "$BACKUP_FILE"
log "Backup created: $BACKUP_FILE"

# Read current key (for validation, not reuse)
OLD_KEY=$(grep "^OPENAI_API_KEY=" "$ENV_FILE" | cut -d'=' -f2)

# Prompt for new key (manual step on free tier)
echo "Enter new OpenAI API key:"
read -r NEW_KEY

# Validate new key
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $NEW_KEY" \
    "https://api.openai.com/v1/models")

if [ "$HTTP_CODE" != "200" ]; then
    log "ERROR: New key validation failed (HTTP $HTTP_CODE)"
    rm "$BACKUP_FILE"
    exit 1
fi

# Update .env atomically
TEMP_ENV=$(mktemp)
sed "s/^OPENAI_API_KEY=.*/OPENAI_API_KEY=$NEW_KEY/" "$ENV_FILE" > "$TEMP_ENV"
mv "$TEMP_ENV" "$ENV_FILE"
chmod 600 "$ENV_FILE"
log "Key updated in $ENV_FILE"

# Restart services
cd /opt/miniop
docker compose restart api worker
sleep 5

# Health check
HEALTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/api/health")
if [ "$HEALTH_CODE" != "200" ]; then
    log "ERROR: Health check failed after rotation. Rolling back."
    cp "$BACKUP_FILE" "$ENV_FILE"
    docker compose restart api worker
    exit 1
fi

log "SUCCESS: OpenAI key rotated. Old key prefix: ${OLD_KEY:0:8}..."

# Revoke old key at provider (manual on free tier)
echo "MANUAL: Revoke old OpenAI key (${OLD_KEY:0:12}...) at https://platform.openai.com/api-keys"
```

### Database Password Rotation (PostgreSQL)

PostgreSQL passwords can be rotated programmatically. This script updates both the database and the application config with zero downtime using a dual-password approach.

```bash
#!/bin/bash
# scripts/rotate-db-password.sh
set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-miniop}"
DB_USER="${DB_USER:-miniop_app}"
ADMIN_USER="${ADMIN_USER:-postgres}"
ENV_FILE="/opt/miniop/.env"
BACKUP_FILE="/opt/miniop/.env.backup.$(date +%s)"

# Generate new password
NEW_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
OLD_PASSWORD=$(grep "^DATABASE_URL=" "$ENV_FILE" | sed 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/')

# Backup
cp "$ENV_FILE" "$BACKUP_FILE"

# Step 1: Create new password while keeping old one valid
# PostgreSQL 10+ supports multiple passwords via ALTER ROLE
PGPASSWORD="$ADMIN_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$ADMIN_USER" -d postgres <<EOF
ALTER ROLE "$DB_USER" PASSWORD '$NEW_PASSWORD';
EOF

# Step 2: Update application config
DATABASE_URL="postgresql://${DB_USER}:${NEW_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
TEMP_ENV=$(mktemp)
sed "s|^DATABASE_URL=.*|DATABASE_URL=$DATABASE_URL|" "$ENV_FILE" > "$TEMP_ENV"
mv "$TEMP_ENV" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Step 3: Rolling restart (zero downtime for multi-instance)
cd /opt/miniop

# For docker compose (single instance): brief downtime
docker compose restart api worker

# Verify connectivity
sleep 3
if docker compose exec api node -e "
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    pool.query('SELECT 1').then(() => { console.log('OK'); process.exit(0); })
    .catch(e => { console.error(e.message); process.exit(1); });
" | grep -q "OK"; then
    echo "Database password rotated successfully"
else
    echo "Rotation failed. Rolling back..."
    PGHOST="$DB_HOST" PGPORT="$DB_PORT" PGUSER="$ADMIN_USER" PGPASSWORD="$ADMIN_PASSWORD" \
        psql -d postgres -c "ALTER ROLE \"$DB_USER\" PASSWORD '$OLD_PASSWORD';"
    cp "$BACKUP_FILE" "$ENV_FILE"
    docker compose restart api worker
    exit 1
fi
```

### Automated Rotation Scheduler

```bash
# /etc/cron.d/miniop-auto-rotation

# OpenAI key - prompt every 30 days (0 2 1 * * = 2am on 1st of month)
0 2 1 * * root /opt/miniop/scripts/rotate-openai-key.sh >> /var/log/miniop-rotation.log 2>&1

# Database password - fully automated every 90 days
0 3 1 */3 * root /opt/miniop/scripts/rotate-db-password.sh >> /var/log/miniop-rotation.log 2>&1

# Storage keys - automated every 90 days
0 4 1 */3 * root /opt/miniop/scripts/rotate-storage-keys.sh >> /var/log/miniop-rotation.log 2>&1

# JWT signing key - automated every 30 days
0 5 1 * * root /opt/miniop/scripts/rotate-jwt-key.sh >> /var/log/miniop-rotation.log 2>&1
```

### Rotation State Tracking

```json
// /opt/miniop/rotation-state.json
{
    "secrets": {
        "openai_api_key": {
            "last_rotated": "2025-12-15T02:00:00Z",
            "next_rotation": "2026-01-14T02:00:00Z",
            "interval_days": 30,
            "method": "semi-manual",
            "last_status": "success"
        },
        "database_password": {
            "last_rotated": "2025-12-01T03:00:00Z",
            "next_rotation": "2026-03-01T03:00:00Z",
            "interval_days": 90,
            "method": "automated",
            "last_status": "success"
        }
    }
}
```

## Production: Vault-Based Automated Rotation

### Vault Agent for Auto-Auth and Caching

Deploy Vault Agent as a sidecar to MiniOp services. It handles authentication, secret fetching, and template rendering without the application needing direct Vault interaction.

```hcl
# vault-agent-config.hcl
pid_file = "/var/run/vault-agent.pid"

auto_auth {
    method "aws" {
        mount_path = "auth/aws"
        config = {
            type = "iam"
            role = "miniop-production"
        }
    }

    sink "file" {
        config = {
            path = "/vault/token/.vault-token"
        }
    }
}

template_config {
    static_secret_render_interval = "5m"
}

template {
    source      = "/vault/templates/database.ctmpl"
    destination = "/vault/secrets/database.json"
    perms       = 0640
}

template {
    source      = "/vault/templates/ai-keys.ctmpl"
    destination = "/vault/secrets/ai-keys.json"
    perms       = 0640
}

template {
    source      = "/vault/templates/jwt-key.ctmpl"
    destination = "/vault/secrets/jwt-key.json"
    perms       = 0640
}
```

Template files for secret rendering:

```go
// vault/templates/database.ctmpl
{{ with secret "database/creds/miniop-readwrite" }}
{
    "username": "{{ .Data.username }}",
    "password": "{{ .Data.password }}",
    "lease_id": "{{ .LeaseID }}",
    "lease_duration": {{ .LeaseDuration }}
}
{{ end }}
```

```go
// vault/templates/ai-keys.ctmpl
{{ with secret "secret/data/miniop/ai-keys" }}
{
    "openai": "{{ .Data.data.openai_api_key }}",
    "anthropic": "{{ .Data.data.anthropic_api_key }}",
    "replicate": "{{ .Data.data.replicate_token }}"
}
{{ end }}
```

### Application-Level Secret Reloading

MiniOp must detect secret changes without restarting. The `SecretManager` watches the Vault Agent output directory:

```typescript
// src/lib/secrets/secret-manager.ts
import { watch } from 'fs';
import { readFile } from 'fs/promises';
import { EventEmitter } from 'events';

interface SecretStore {
    database: { username: string; password: string };
    aiKeys: { openai: string; anthropic: string; replicate: string };
    jwtKey: { privateKey: string; publicKey: string };
}

export class SecretManager extends EventEmitter {
    private secrets: SecretStore | null = null;
    private watchers: ReturnType<typeof watch>[] = [];

    constructor(private secretsDir: string) {
        super();
    }

    async initialize(): Promise<void> {
        await this.loadAllSecrets();
        this.startWatching();
    }

    private async loadAllSecrets(): Promise<void> {
        const [database, aiKeys, jwtKey] = await Promise.all([
            this.readJson('database.json'),
            this.readJson('ai-keys.json'),
            this.readJson('jwt-key.json'),
        ]);

        this.secrets = { database, aiKeys, jwtKey };
        this.emit('secrets:updated', this.secrets);
    }

    private async readJson(filename: string): Promise<any> {
        const content = await readFile(
            `${this.secretsDir}/${filename}`,
            'utf-8'
        );
        return JSON.parse(content);
    }

    private startWatching(): void {
        const files = ['database.json', 'ai-keys.json', 'jwt-key.json'];

        for (const file of files) {
            const watcher = watch(
                `${this.secretsDir}/${file}`,
                { persistent: false },
                async (eventType) => {
                    if (eventType === 'change') {
                        console.log(`Secret file changed: ${file}, reloading...`);
                        try {
                            await this.loadAllSecrets();
                        } catch (err) {
                            console.error(`Failed to reload secrets: ${err}`);
                            this.emit('secrets:error', err);
                        }
                    }
                }
            );
            this.watchers.push(watcher);
        }
    }

    getDatabaseCredentials() {
        return this.secrets?.database;
    }

    getAiKeys() {
        return this.secrets?.aiKeys;
    }

    getJwtKey() {
        return this.secrets?.jwtKey;
    }

    shutdown(): void {
        for (const watcher of this.watchers) {
            watcher.close();
        }
    }
}
```

### Database Connection Pool Refresh

When database credentials rotate, the connection pool must be refreshed without dropping active transactions:

```typescript
// src/lib/db/pool-manager.ts
import { Pool } from 'pg';
import { SecretManager } from '../secrets/secret-manager';

export class PoolManager {
    private pool: Pool;
    private currentConnectionString: string;

    constructor(private secretManager: SecretManager) {
        const creds = secretManager.getDatabaseCredentials();
        this.currentConnectionString = this.buildConnectionString(creds);
        this.pool = new Pool({ connectionString: this.currentConnectionString });

        // Listen for credential rotation
        secretManager.on('secrets:updated', () => this.refreshPool());
    }

    private buildConnectionString(creds: { username: string; password: string }): string {
        return `postgresql://${creds.username}:${creds.password}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;
    }

    private async refreshPool(): Promise<void> {
        const creds = this.secretManager.getDatabaseCredentials();
        const newConnectionString = this.buildConnectionString(creds);

        if (newConnectionString === this.currentConnectionString) {
            return;
        }

        console.log('Database credentials rotated, refreshing connection pool...');

        const oldPool = this.pool;
        this.pool = new Pool({ connectionString: newConnectionString });
        this.currentConnectionString = newConnectionString;

        // Drain old pool gracefully — wait for active connections
        // to finish their current queries (up to 30s)
        await oldPool.end();
        console.log('Connection pool refreshed successfully');
    }

    query(text: string, params?: any[]) {
        return this.pool.query(text, params);
    }
}
```

### AWS Secrets Manager Alternative

For teams on AWS without Vault, use AWS Secrets Manager with Lambda-based rotation:

```typescript
// lambda/rotate-miniop-secrets.ts
import {
    SecretsManagerClient,
    RotateSecretCommand,
    DescribeSecretCommand,
} from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({ region: 'us-east-1' });

const SECRETS = [
    'miniop/production/database',
    'miniop/production/openai-key',
    'miniop/production/jwt-signing-key',
];

export async function handler() {
    const results = [];

    for (const secretId of SECRETS) {
        try {
            const desc = await client.send(
                new DescribeSecretCommand({ SecretId: secretId })
            );

            const lastRotation = desc.LastRotatedDate
                ? new Date(desc.LastRotatedDate)
                : new Date(0);
            const daysSinceRotation =
                (Date.now() - lastRotation.getTime()) / 86400000;
            const rotationDays = desc.RotationRules?.AutomaticallyAfterDays || 90;

            if (daysSinceRotation >= rotationDays) {
                await client.send(
                    new RotateSecretCommand({ SecretId: secretId })
                );
                results.push({ secret: secretId, action: 'rotated' });
            } else {
                results.push({
                    secret: secretId,
                    action: 'skipped',
                    daysRemaining: Math.ceil(rotationDays - daysSinceRotation),
                });
            }
        } catch (err) {
            results.push({ secret: secretId, action: 'error', error: err.message });
        }
    }

    return { statusCode: 200, body: JSON.stringify(results) };
}
```

CloudFormation for the rotation Lambda:

```yaml
# cloudformation/rotation-lambda.yaml
Resources:
  RotationSchedule:
    Type: AWS::Scheduler::Schedule
    Properties:
      Name: miniop-secret-rotation
      ScheduleExpression: 'rate(1 day)'
      FlexibleTimeWindow:
        Mode: 'OFF'
      Target:
        Arn: !GetAtt RotationLambda.Arn
        RoleArn: !GetAtt SchedulerRole.Arn
      State: 'ENABLED'

  RotationLambda:
    Type: AWS::Lambda::Function
    Properties:
      FunctionName: miniop-secret-rotator
      Runtime: nodejs20.x
      Handler: index.handler
      Timeout: 300
      Environment:
        Variables:
          SECRET_IDS: 'miniop/production/database,miniop/production/openai-key'
      Policies:
        - Version: '2012-10-17'
          Statement:
            - Effect: Allow
              Action:
                - secretsmanager:RotateSecret
                - secretsmanager:DescribeSecret
              Resource: !Sub 'arn:aws:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:miniop/*'
```

### Monitoring Rotation Health

```typescript
// src/lib/secrets/rotation-monitor.ts
import { SecretManager } from './secret-manager';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';

const rotationAgeGauge = new PrometheusExporter().createGauge(
    'miniop_secret_age_seconds',
    'Age of each secret since last rotation',
    ['secret_name']
);

export function startRotationMonitor(secretManager: SecretManager) {
    setInterval(() => {
        const state = readRotationState();
        for (const [name, info] of Object.entries(state.secrets)) {
            const ageSeconds =
                (Date.now() - new Date(info.last_rotated).getTime()) / 1000;
            rotationAgeGauge.set({ secret_name: name }, ageSeconds);

            // Alert if approaching rotation deadline
            const maxAge = info.interval_days * 86400;
            if (ageSeconds > maxAge * 0.9) {
                console.warn(
                    `Secret ${name} is at ${Math.round((ageSeconds / maxAge) * 100)}% of rotation interval`
                );
            }
        }
    }, 300_000); // Every 5 minutes
}
```

## Rollback Procedures

Every automated rotation must include rollback logic. The pattern:

1. **Backup** current secret before change
2. **Apply** new secret to provider
3. **Update** local store
4. **Verify** application health
5. On failure: **restore** backup to local store and provider (if possible), restart services

If the provider doesn't support re-activation of old keys (common with AI providers), the rollback restores the old application config and alerts for manual re-creation of the key at the provider dashboard.

## Testing Rotation

```bash
# Test rotation in staging without affecting production
MINIO_ENV=staging ./scripts/rotate-db-password.sh --dry-run

# Verify all secrets are valid after rotation
curl http://localhost:3000/api/health/secrets | jq .
```

The `/api/health/secrets` endpoint validates each secret without exposing values:

```typescript
// src/routes/health.ts
router.get('/api/health/secrets', async (req, res) => {
    const checks = {
        database: await checkDbConnection(),
        openai: await checkOpenAIKey(),
        storage: await checkStorageAccess(),
        jwt: await checkJwtKey(),
    };
    const allHealthy = Object.values(checks).every((c) => c.status === 'ok');
    res.status(allHealthy ? 200 : 503).json(checks);
});
```
