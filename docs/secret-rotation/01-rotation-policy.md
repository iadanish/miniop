# MiniOp Secret Rotation Policy

## Overview

MiniOp handles sensitive credentials across its video processing pipeline: API keys for AI providers (OpenAI, Anthropic, Replicate), database connection strings, object storage credentials (AWS S3, Cloudflare R2, MinIO), JWT signing keys, webhook secrets, and encryption keys for stored media metadata. A compromised credential in any of these systems can lead to unauthorized access to user video content, billing abuse on AI provider accounts, or full database exfiltration.

This policy defines mandatory rotation schedules, ownership, and enforcement mechanisms for every secret class in both free-tier single-instance deployments and scaled production environments.

## Secret Classification

### Tier 1 — Critical (Rotate every 30 days)

| Secret | Storage Location | Owner |
|--------|-----------------|-------|
| AI provider API keys (OpenAI, Anthropic, Replicate) | Vault/KMS or env vars | Platform team |
| Database credentials (PostgreSQL) | Vault or connection string env | Data team |
| Object storage access keys (S3/R2/MinIO) | Vault or IAM roles | Infrastructure team |
| JWT signing keys (RS256) | Vault or filesystem mount | Auth team |
| Encryption keys for media metadata (AES-256-GCM) | KMS or Vault transit | Security team |

### Tier 2 — Standard (Rotate every 90 days)

| Secret | Storage Location | Owner |
|--------|-----------------|-------|
| Webhook signing secrets (Stripe, GitHub) | Env vars or Vault | Platform team |
| Redis connection passwords | Vault or env vars | Infrastructure team |
| SMTP credentials for notifications | Env vars | Platform team |
| Session encryption keys | Env vars | Auth team |

### Tier 3 — Low Risk (Rotate every 180 days)

| Secret | Storage Location | Owner |
|--------|-----------------|-------|
| Internal service-to-service API tokens | Vault | Platform team |
| Log drain tokens | Env vars | Infrastructure team |
| Feature flag service tokens | Env vars | Product team |

## Free Tier Policy

Free-tier deployments run a single MiniOp instance (Docker Compose or bare metal) without centralized secret management. Rotation is manual but enforced through calendar reminders and pre-expiration warnings.

### Storage

All secrets live in a `.env` file at the project root or in environment variables injected by the hosting platform (Railway, Render, Fly.io). The `.env` file must:

- Be excluded from version control via `.gitignore`
- Have file permissions `600` (owner read/write only) on Linux/macOS
- Never be copied into Docker images — use `env_file` in `docker-compose.yml`

### Rotation Procedure

```bash
# 1. Generate new secret value
openssl rand -base64 32

# 2. Update the provider console (e.g., OpenAI dashboard)
#    Revoke old key, create new key

# 3. Update .env
sed -i 's/OPENAI_API_KEY=sk-old.*/OPENAI_API_KEY=sk-new-value/' .env

# 4. Restart services
docker compose restart api worker

# 5. Verify
curl -H "Authorization: Bearer $NEW_KEY" https://api.openai.com/v1/models
```

### Free Tier Rotation Schedule

| Secret Type | Rotation Interval | Reminder |
|-------------|------------------|----------|
| AI API keys | 30 days | Calendar event + cron reminder |
| DB password | 90 days | Calendar event |
| Storage keys | 90 days | Calendar event |
| JWT key | 90 days | Calendar event |

Set up a cron job to warn when rotation is overdue:

```bash
# /etc/cron.d/miniop-rotation-check (runs daily at 9am)
0 9 * * * root /opt/miniop/scripts/check-rotation-due.sh
```

```bash
#!/bin/bash
# scripts/check-rotation-due.sh
ROTATION_LOG="/opt/miniop/rotation-log.json"
CURRENT_DATE=$(date +%s)

for SECRET_NAME in $(jq -r 'keys[]' "$ROTATION_LOG"); do
    LAST_ROTATED=$(jq -r ".[\"$SECRET_NAME\"].last_rotated" "$ROTATION_LOG")
    INTERVAL_DAYS=$(jq -r ".[\"$SECRET_NAME\"].interval_days" "$ROTATION_LOG")
    LAST_TS=$(date -d "$LAST_ROTATED" +%s 2>/dev/null || date -j -f "%Y-%m-%d" "$LAST_ROTATED" +%s)
    DAYS_SINCE=$(( (CURRENT_DATE - LAST_TS) / 86400 ))

    if [ "$DAYS_SINCE" -ge "$INTERVAL_DAYS" ]; then
        echo "OVERDUE: $SECRET_NAME last rotated $DAYS_SINCE days ago (interval: ${INTERVAL_DAYS}d)"
        # Send alert via webhook or email
        curl -X POST "$ALERT_WEBHOOK_URL" \
            -H "Content-Type: application/json" \
            -d "{\"text\": \"Secret rotation overdue: $SECRET_NAME (${DAYS_SINCE}d since last rotation)\"}"
    fi
done
```

`rotation-log.json` format:

```json
{
    "openai_api_key": {
        "last_rotated": "2025-12-15",
        "interval_days": 30,
        "owner": "platform"
    },
    "postgres_password": {
        "last_rotated": "2025-11-01",
        "interval_days": 90,
        "owner": "data"
    }
}
```

## Scaled Production Policy

Production deployments use HashiCorp Vault (self-hosted or HCP Vault) or AWS Secrets Manager for centralized secret storage, automatic rotation, and audit logging.

### Vault Integration Architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│  MiniOp API  │────▶│  Vault Agent │────▶│  Vault Server │
│  (read path) │     │  (sidecar)   │     │  (secrets/)   │
└─────────────┘     └─────────────┘     └──────────────┘
                                               │
                                        ┌──────┴──────┐
                                        │  Audit Log   │
                                        │  (file/syslog)│
                                        └─────────────┘
```

### Vault Policy for MiniOp

```hcl
# miniop-policy.hcl
path "secret/data/miniop/*" {
    capabilities = ["read", "list"]
}

path "secret/data/miniop/ai-keys/*" {
    capabilities = ["read"]
}

path "sys/leases/renew" {
    capabilities = ["create", "update"]
}

path "sys/leases/revoke" {
    capabilities = ["create", "update"]
}
```

### Dynamic Database Credentials

Instead of rotating static PostgreSQL passwords, use Vault's database secrets engine:

```bash
# Enable database secrets engine
vault secrets enable database

# Configure PostgreSQL connection
vault write database/config/miniop-postgres \
    plugin_name=postgresql-database-plugin \
    connection_url="postgresql://{{username}}:{{password}}@db.internal:5432/miniop" \
    allowed_roles="miniop-readwrite" \
    username="vault_admin" \
    password="initial-admin-password"

# Create role with rotation policy
vault write database/roles/miniop-readwrite \
    db_name=miniop-postgres \
    creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"{{name}}\";" \
    default_ttl="1h" \
    max_ttl="24h"
```

MiniOp fetches dynamic credentials at startup:

```typescript
// src/lib/secrets/vault-client.ts
import vault from 'node-vault';

const client = vault({
    endpoint: process.env.VAULT_ADDR,
    token: process.env.VAULT_TOKEN, // Injected by Vault Agent
});

export async function getDatabaseCredentials() {
    const { data } = await client.read('database/creds/miniop-readwrite');
    return {
        username: data.username,
        password: data.password,
        leaseId: data.lease_id,
        leaseDuration: data.lease_duration,
    };
}

export async function renewLease(leaseId: string) {
    return client.write('sys/leases/renew', { lease_id: leaseId });
}
```

### Automatic Key Rotation with Vault Transit

For JWT signing and media metadata encryption, use Vault's transit engine:

```bash
vault secrets enable transit

# Create encryption key with auto-rotation
vault write -f transit/keys/miniop-media \
    type=aes256-gcm96 \
    auto_rotate_period=720h  # 30 days

# Create JWT signing key
vault write -f transit/keys/miniop-jwt \
    type=rsa-4096 \
    auto_rotate_period=720h
```

### Compliance and Audit

Production environments must maintain rotation audit trails:

```bash
# Enable audit logging in Vault
vault audit enable file file_path=/var/log/vault/audit.log

# Query rotation events
grep '"operation":"update"' /var/log/vault/audit.log | \
    jq 'select(.request.path | startswith("secret/data/miniop"))'
```

Generate quarterly compliance reports:

```bash
# scripts/generate-rotation-report.sh
#!/bin/bash
REPORT_DATE=$(date +%Y-Q%q)
echo "# Secret Rotation Compliance Report - $REPORT_DATE" > reports/rotation-$REPORT_DATE.md

for SECRET_PATH in $(vault list -format=json secret/data/miniop/* | jq -r '.[]'); do
    LAST_UPDATED=$(vault read -field=updated_time "secret/data/$SECRET_PATH")
    echo "| $SECRET_PATH | $LAST_UPDATED |" >> reports/rotation-$REPORT_DATE.md
done
```

## Enforcement

- **Automated scanning**: CI/CD pipelines run `gitleaks` and `trufflehog` on every commit to detect leaked secrets. Any detection blocks the merge.
- **Vault lease monitoring**: A background job (`scripts/vault-lease-monitor.ts`) checks every 6 hours that no active lease exceeds its TTL by more than 10%.
- **Quarterly review**: Security team reviews all Tier 1 secrets quarterly against the rotation log. Non-compliance triggers an incident.

## Exceptions

Temporary exceptions (e.g., a third-party provider that doesn't support key rotation without downtime) must be documented in the `rotation-log.json` with an `exception` field and an expiration date. No exception may exceed 90 days.
