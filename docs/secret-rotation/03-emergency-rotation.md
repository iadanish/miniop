# MiniOp Emergency Secret Rotation

## Overview

Emergency rotation is triggered when a secret is suspected or confirmed compromised — leaked in a commit, exposed in logs, found in a breach notification, or detected by anomaly monitoring. Unlike scheduled rotation, emergency rotation prioritizes speed over zero-downtime and may require immediate service restarts.

**Target response time**: 15 minutes from detection to full rotation across all affected secrets.

## Detection Triggers

An emergency rotation is triggered by any of the following:

1. **Git leak detection**: `gitleaks` or `trufflehog` finds a secret in a commit (including history)
2. **Log exposure**: Secret found in application logs, error tracking (Sentry, Datadog), or CI output
3. **Provider breach notification**: OpenAI, AWS, or other provider reports credential exposure
4. **Anomaly detection**: Unusual API usage patterns on AI provider dashboards (spending spike, requests from unknown IPs)
5. **Access log anomaly**: Vault audit log shows reads from unexpected sources
6. **Employee departure**: Offboarding with shared credential access

## Emergency Rotation Runbook

### Step 1: Identify Scope (2 minutes)

Determine which secrets are affected:

```bash
# Check if a specific secret appears in git history
git log -p --all -S 'sk-proj-' -- '*.env' '*.ts' '*.json' '*.yaml' '*.yml'

# Scan full history for any leaked secrets
trufflehog git file://. --json | jq '.SourceMetadata.Data.Git.file'

# Check recent application logs
grep -r "sk-proj\|sk-ant\|AKIA\|eyJ" /var/log/miniop/ --include="*.log" -l

# List all active Vault leases
vault list sys/leases/lookup/secret/data/miniop/ --format=json
```

### Step 2: Revoke Compromised Secrets (5 minutes)

Revoke at the provider BEFORE updating local config. This prevents the compromised credential from being used even if local rotation hasn't completed.

#### AI Provider Keys

```bash
#!/bin/bash
# scripts/emergency-revoke-ai-keys.sh
set -euo pipefail

echo "=== EMERGENCY: Revoking all AI provider keys ==="

# OpenAI - revoke via API (requires admin key)
# Note: OpenAI doesn't have a revoke endpoint. Delete and recreate.
echo "MANUAL: Delete all OpenAI API keys at https://platform.openai.com/api-keys"
echo "Create new keys immediately after deletion."

# Anthropic - revoke via API
echo "MANUAL: Revoke Anthropic key at https://console.anthropic.com/settings/keys"

# If you have a secondary (uncompromised) key, use it to verify access:
if [ -n "${OPENAI_BACKUP_KEY:-}" ]; then
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "Authorization: Bearer $OPENAI_BACKUP_KEY" \
        "https://api.openai.com/v1/models")
    echo "Backup key status: $HTTP_CODE"
fi
```

#### Database Credentials

```bash
#!/bin/bash
# scripts/emergency-revoke-db-creds.sh
set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
ADMIN_USER="${ADMIN_USER:-postgres}"
APP_USER="${APP_USER:-miniop_app}"

echo "=== EMERGENCY: Revoking database credentials ==="

# Terminate all active connections for the compromised user
PGPASSWORD="$ADMIN_PASSWORD" psql -h "$DB_HOST" -U "$ADMIN_USER" -d postgres <<EOF
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE usename = '$APP_USER' AND pid <> pg_backend_pid();

ALTER ROLE "$APP_USER" NOLOGIN;
EOF

echo "User $APP_USER locked out. All connections terminated."

# Generate and set new password
NEW_PASSWORD=$(openssl rand -base64 48 | tr -d '/+=' | head -c 48)
PGPASSWORD="$ADMIN_PASSWORD" psql -h "$DB_HOST" -U "$ADMIN_USER" -d postgres <<EOF
ALTER ROLE "$APP_USER" PASSWORD '$NEW_PASSWORD';
ALTER ROLE "$APP_USER" LOGIN;
EOF

echo "New password set. Update application config immediately."
echo "New DATABASE_URL: postgresql://${APP_USER}:${NEW_PASSWORD}@${DB_HOST}:5432/miniop"
```

#### Object Storage Keys (AWS S3)

```bash
#!/bin/bash
# scripts/emergency-revoke-storage-keys.sh
set -euo pipefail

IAM_USER="miniop-s3-user"
echo "=== EMERGENCY: Rotating S3 access keys ==="

# List and delete all access keys for the user
for KEY_ID in $(aws iam list-access-keys --user-name "$IAM_USER" \
    --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
    echo "Deleting access key: $KEY_ID"
    aws iam delete-access-key --user-name "$IAM_USER" --access-key-id "$KEY_ID"
done

# Create new access key
NEW_KEY_OUTPUT=$(aws iam create-access-key --user-name "$IAM_USER" --output json)
NEW_ACCESS_KEY=$(echo "$NEW_KEY_OUTPUT" | jq -r '.AccessKey.AccessKeyId')
NEW_SECRET_KEY=$(echo "$NEW_KEY_OUTPUT" | jq -r '.AccessKey.SecretAccessKey')

echo "New access key: $NEW_ACCESS_KEY"
echo "Update AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in application config."

# Verify new key works
aws sts get-caller-identity --access-key "$NEW_ACCESS_KEY" --secret-key "$NEW_SECRET_KEY"
echo "New key verified."
```

#### JWT Signing Keys

```bash
#!/bin/bash
# scripts/emergency-revoke-jwt-keys.sh
set -euo pipefail

echo "=== EMERGENCY: Rotating JWT signing keys ==="

KEYS_DIR="/opt/miniop/keys"
BACKUP_DIR="/opt/miniop/keys.backup.$(date +%s)"
mkdir -p "$BACKUP_DIR"

# Backup current keys
cp "$KEYS_DIR"/*.pem "$BACKUP_DIR/" 2>/dev/null || true

# Generate new RSA key pair
openssl genrsa -out "$KEYS_DIR/jwt-private.pem" 4096
openssl rsa -in "$KEYS_DIR/jwt-private.pem" -pubout -out "$KEYS_DIR/jwt-public.pem"
chmod 600 "$KEYS_DIR/jwt-private.pem"
chmod 644 "$KEYS_DIR/jwt-public.pem"

# Generate a key ID for the new key
NEW_KID=$(openssl rand -hex 8)
echo "$NEW_KID" > "$KEYS_DIR/current-kid.txt"

echo "New JWT key pair generated. KID: $NEW_KID"
echo "All existing tokens will be invalidated on service restart."
```

### Step 3: Update Application Configuration (3 minutes)

```bash
#!/bin/bash
# scripts/emergency-update-config.sh
set -euo pipefail

ENV_FILE="/opt/miniop/.env"
EMERGENCY_BACKUP="/opt/miniop/.env.emergency.$(date +%s)"

cp "$ENV_FILE" "$EMERGENCY_BACKUP"

# Update all potentially compromised secrets
# (Values should be set as environment variables before running)
cat >> /tmp/env-patches <<'EOF'
DATABASE_URL=postgresql://${DB_USER}:${NEW_DB_PASSWORD}@${DB_HOST}:5432/miniop
OPENAI_API_KEY=${NEW_OPENAI_KEY}
ANTHROPIC_API_KEY=${NEW_ANTHROPIC_KEY}
AWS_ACCESS_KEY_ID=${NEW_AWS_ACCESS_KEY}
AWS_SECRET_ACCESS_KEY=${NEW_AWS_SECRET_KEY}
EOF

# Apply patches
while IFS='=' read -r key value; do
    [ -z "$key" ] && continue
    # Use envsubst to expand variables
    expanded_value=$(echo "$value" | envsubst)
    sed -i "s|^${key}=.*|${key}=${expanded_value}|" "$ENV_FILE"
    echo "Updated: $key"
done < /tmp/env-patches

rm /tmp/env-patches
chmod 600 "$ENV_FILE"
echo "Configuration updated. Restart services immediately."
```

### Step 4: Restart Services (2 minutes)

```bash
#!/bin/bash
# scripts/emergency-restart.sh
set -euo pipefail

cd /opt/miniop

echo "=== EMERGENCY: Restarting all services ==="

# For Docker Compose deployments
docker compose down
docker compose up -d

# Wait for health check
echo "Waiting for services to become healthy..."
for i in $(seq 1 30); do
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/api/health" 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        echo "Services healthy after ${i}0 seconds"
        break
    fi
    if [ "$i" = "30" ]; then
        echo "ERROR: Services failed to start within 5 minutes"
        echo "Check logs: docker compose logs api worker"
        exit 1
    fi
    sleep 10
done
```

### Step 5: Verify and Monitor (3 minutes)

```bash
#!/bin/bash
# scripts/emergency-verify.sh
set -euo pipefail

echo "=== EMERGENCY: Post-rotation verification ==="

# 1. Verify all secrets are functional
echo "--- Checking API health ---"
curl -s http://localhost:3000/api/health/secrets | jq .

# 2. Verify no old credentials are in use
echo "--- Checking for old credential usage ---"
docker compose logs api worker --since=2m | grep -i "401\|403\|unauthorized\|forbidden" || echo "No auth errors detected"

# 3. Check Vault for stale leases (if using Vault)
if command -v vault &>/dev/null; then
    echo "--- Checking for stale Vault leases ---"
    vault list sys/leases/lookup/secret/data/miniop/ --format=json 2>/dev/null | \
        jq -r '.[]' | while read -r lease; do
            vault write sys/leases/revoke lease_id="$lease"
            echo "Revoked stale lease: $lease"
        done
fi

# 4. Check for any remaining references to old secrets in running containers
echo "--- Checking container environment for old secrets ---"
OLD_KEY_PREFIX=$(grep "^OLD_KEY_PREFIX=" /opt/miniop/.env.emergency.* 2>/dev/null | head -1 | cut -d'=' -f2)
if [ -n "$OLD_KEY_PREFIX" ]; then
    docker compose exec api env | grep "$OLD_KEY_PREFIX" && \
        echo "WARNING: Old key prefix still found in container environment!" || \
        echo "No old credentials found in running containers"
fi

echo "=== Verification complete ==="
```

## Post-Incident Actions

### 1. Investigate Root Cause

```bash
# If leaked via git: find the exact commit
git log --all --diff-filter=A -p -- '*.env' | grep -B5 "LEAKED_KEY_PREFIX"

# Check who had access
vault audit -format=json | jq 'select(.request.path | contains("miniop")) | {time: .time, operation: .request.operation, path: .request.path, remote_addr: .request.remote_address}'
```

### 2. Update Rotation State

```json
// Update rotation-state.json with emergency rotation event
{
    "secrets": {
        "openai_api_key": {
            "last_rotated": "2026-01-15T14:32:00Z",
            "rotation_type": "emergency",
            "incident_id": "INC-2026-0115-001",
            "reason": "Key found in git history (commit abc123)",
            "next_rotation": "2026-02-14T14:32:00Z"
        }
    }
}
```

### 3. Prevent Recurrence

```bash
# Add pre-commit hook to prevent future leaks
cat > .git/hooks/pre-commit <<'HOOK'
#!/bin/bash
# Run gitleaks on staged files
gitleaks protect --staged --no-banner --redact
if [ $? -ne 0 ]; then
    echo "COMMIT BLOCKED: Potential secret detected. Run 'gitleaks protect --staged' for details."
    exit 1
fi
HOOK
chmod +x .git/hooks/pre-commit
```

### 4. Generate Incident Report

```markdown
## Incident Report: INC-YYYYMMDD-NNN

**Detection**: [How was the compromise discovered?]
**Scope**: [Which secrets were affected?]
**Timeline**:
- T+0: Compromise detected
- T+2m: Scope identified
- T+7m: Provider-side revocation complete
- T+10m: Application config updated
- T+12m: Services restarted
- T+15m: Verification complete

**Impact**: [What data/services were potentially exposed?]
**Root cause**: [How did the secret leak?]
**Prevention**: [What measures were added to prevent recurrence?]
```

## Production: Emergency Rotation with Vault

### Immediate Revocation

```bash
#!/bin/bash
# scripts/emergency-vault-rotation.sh
set -euo pipefail

VAULT_ADDR="${VAULT_ADDR:-https://vault.internal:8200}"

echo "=== EMERGENCY: Vault secret revocation ==="

# Revoke ALL leases under the miniop path
vault lease revoke -prefix secret/data/miniop

# Revoke all database dynamic credentials
vault lease revoke -prefix database/creds/miniop-readwrite

# Force-rotate the transit encryption key
vault write -f transit/keys/miniop-media/rotate

echo "All Vault leases revoked. New secrets will be issued on next request."

# Restart Vault Agent sidecars to force new secret fetch
# In Kubernetes:
kubectl rollout restart deployment miniop-api -n miniop
kubectl rollout restart deployment miniop-worker -n miniop

# In ECS:
aws ecs update-service --cluster miniop --service miniop-api --force-new-deployment
aws ecs update-service --cluster miniop --service miniop-worker --force-new-deployment
```

### Kubernetes Emergency Rotation

```yaml
# k8s/emergency-rotation-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: emergency-secret-rotation
  namespace: miniop
spec:
  template:
    spec:
      serviceAccountName: miniop-rotation
      containers:
        - name: rotator
          image: miniop/secret-rotator:latest
          env:
            - name: ROTATION_MODE
              value: "emergency"
            - name: VAULT_ADDR
              value: "https://vault.internal:8200"
          command: ["/bin/sh", "-c"]
          args:
            - |
              echo "Starting emergency rotation..."
              
              # Revoke all leases
              vault lease revoke -prefix secret/data/miniop
              vault lease revoke -prefix database/creds/miniop-readwrite
              
              # Rotate transit keys
              vault write -f transit/keys/miniop-media/rotate
              vault write -f transit/keys/miniop-jwt/rotate
              
              # Force rolling restart
              kubectl rollout restart deployment -n miniop -l app=miniop
              
              echo "Emergency rotation complete."
      restartPolicy: Never
  backoffLimit: 0
```

Trigger with:

```bash
kubectl create -f k8s/emergency-rotation-job.yaml -n miniop
```

## Communication Template

During an emergency rotation, notify affected parties immediately:

```
SUBJECT: [MINIOP] Emergency Secret Rotation in Progress

We have detected a potential credential compromise and are performing
emergency rotation of affected secrets.

**Status**: In Progress
**Estimated completion**: 15 minutes
**Impact**: Brief service interruptions during restart

**What happened**: [Brief description]
**What we're doing**: Rotating all potentially affected credentials
**What you need to do**: Nothing. We will update when rotation is complete.

Updates will be posted at: https://status.miniop.io/incidents/INC-XXXX
```

## Prevention Checklist

After every emergency rotation, verify these controls are in place:

- [ ] Pre-commit hooks with `gitleaks` or `trufflehog` installed
- [ ] CI/CD pipeline includes secret scanning stage
- [ ] `.env` files are in `.gitignore` and `.dockerignore`
- [ ] Application logs are scrubbed of secret patterns
- [ ] Error reporting (Sentry) is configured to redact sensitive values
- [ ] Vault audit logging is enabled
- [ ] AWS CloudTrail is logging Secrets Manager access
- [ ] Rotation state tracking is up to date
- [ ] Emergency runbook is accessible to on-call engineers
- [ ] Alerting is configured for anomalous secret access patterns

## Appendix: Quick Reference Card

Print and post near on-call stations:

```
╔══════════════════════════════════════════════════════════════╗
║                EMERGENCY SECRET ROTATION                     ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  1. IDENTIFY  → scripts/emergency-scope.sh (2 min)          ║
║  2. REVOKE    → scripts/emergency-revoke-*.sh (5 min)       ║
║  3. UPDATE    → scripts/emergency-update-config.sh (3 min)  ║
║  4. RESTART   → scripts/emergency-restart.sh (2 min)        ║
║  5. VERIFY    → scripts/emergency-verify.sh (3 min)         ║
║                                                              ║
║  Total target: 15 minutes                                    ║
║                                                              ║
║  Vault shortcut: vault lease revoke -prefix secret/miniop   ║
║  K8s shortcut: kubectl create -f k8s/emergency-rotation.yaml║
║                                                              ║
║  Escalation: security@miniop.io | +1-555-MINIOP-SEC         ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```
