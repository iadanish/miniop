# Data Protection and Encryption

## Overview

MiniOp processes sensitive user data: video files, email addresses, OAuth tokens, payment information, and AI-generated clip metadata. This document defines how data is classified, encrypted at rest and in transit, stored, and destroyed across the free tier (Supabase managed infrastructure) and scaled production (self-hosted or dedicated infrastructure).

---

## Data Classification

| Classification | Examples | Storage | Retention |
|---|---|---|---|
| **Critical** | Payment tokens, OAuth refresh tokens, API keys | Encrypted column + vault | Until revocation |
| **Sensitive** | Email, user metadata, JWT claims | Encrypted at rest (disk) | Account lifetime + 30 days |
| **Confidential** | Video files, AI transcripts, clip metadata | Encrypted at rest (disk) | Account lifetime |
| **Public** | Shared clip URLs, public project names | Unencrypted | Until deletion |

---

## Encryption at Rest

### Free Tier: Supabase Managed Encryption

Supabase encrypts all data at rest using AES-256 on the underlying AWS EBS volumes. This is transparent and requires no configuration. However, this encryption is disk-level — anyone with database access (Supabase staff, compromised service role key) can read plaintext data.

For sensitive columns, use application-level encryption via `pgcrypto`:

```sql
-- supabase/migrations/010_encrypted_columns.sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Encrypt OAuth tokens at the application level
CREATE TABLE user_oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  access_token_encrypted BYTEA NOT NULL,
  refresh_token_encrypted BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider)
);

-- Helper functions for encrypt/decrypt
CREATE OR REPLACE FUNCTION encrypt_token(plaintext TEXT, key TEXT)
RETURNS BYTEA AS $$
BEGIN
  RETURN pgp_sym_encrypt(plaintext, key, 'cipher-algo=aes256');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION decrypt_token(ciphertext BYTEA, key TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN pgp_sym_decrypt(ciphertext, key);
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL; -- Invalid key or corrupted data
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

Usage in the application:

```typescript
// lib/crypto/tokens.ts
import { supabaseAdmin } from '@/lib/supabase-admin'

const ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY!

export async function storeOAuthToken(
  userId: string,
  provider: string,
  accessToken: string,
  refreshToken: string,
  expiresAt: Date
) {
  const { error } = await supabaseAdmin.rpc('store_encrypted_oauth_token', {
    p_user_id: userId,
    p_provider: provider,
    p_access_token: accessToken,
    p_refresh_token: refreshToken,
    p_expires_at: expiresAt.toISOString(),
    p_encryption_key: ENCRYPTION_KEY,
  })

  if (error) throw error
}

export async function getOAuthToken(userId: string, provider: string) {
  const { data, error } = await supabaseAdmin.rpc('get_decrypted_oauth_token', {
    p_user_id: userId,
    p_provider: provider,
    p_encryption_key: ENCRYPTION_KEY,
  })

  if (error) throw error
  return data?.[0] ?? null
}
```

### Scaled Production: Column-Level Encryption with External Key Management

In production, use a dedicated key management service (AWS KMS, HashiCorp Vault, or Supabase Vault) instead of storing the encryption key in an environment variable.

```typescript
// lib/crypto/kms.ts
import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms'

const kms = new KMSClient({ region: process.env.AWS_REGION })
const KEY_ID = process.env.KMS_KEY_ARN!

export async function encryptWithKMS(plaintext: string): Promise<string> {
  const command = new EncryptCommand({
    KeyId: KEY_ID,
    Plaintext: Buffer.from(plaintext, 'utf-8'),
  })

  const { CiphertextBlob } = await kms.send(command)
  return Buffer.from(CiphertextBlob!).toString('base64')
}

export async function decryptWithKMS(ciphertext: string): Promise<string> {
  const command = new DecryptCommand({
    CiphertextBlob: Buffer.from(ciphertext, 'base64'),
  })

  const { Plaintext } = await kms.send(command)
  return Buffer.from(Plaintext!).toString('utf-8')
}
```

For Supabase Vault (native to the Supabase ecosystem):

```sql
-- Install the vault extension
CREATE EXTENSION IF NOT EXISTS supabase_vault;

-- Store the encryption key in the vault
SELECT vault.create_secret(
  'your-256-bit-encryption-key-here',
  'token_encryption_key',
  'Key for encrypting OAuth tokens'
);

-- Use vault secret in encryption functions
CREATE OR REPLACE FUNCTION encrypt_token_vault(plaintext TEXT)
RETURNS BYTEA AS $$
DECLARE
  key TEXT;
BEGIN
  SELECT decrypted_secret INTO key
  FROM vault.decrypted_secrets
  WHERE name = 'token_encryption_key';

  RETURN pgp_sym_encrypt(plaintext, key, 'cipher-algo=aes256');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

---

## Encryption in Transit

### TLS Configuration

All traffic between clients and MiniOp uses TLS 1.3. Supabase enforces this by default. For custom domains:

```nginx
# nginx/conf.d/minioop.conf
server {
    listen 443 ssl http2;
    server_name api.minioop.com;

    ssl_certificate /etc/letsencrypt/live/api.minioop.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.minioop.com/privkey.pem;

    ssl_protocols TLSv1.3;
    ssl_ciphers 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256';
    ssl_prefer_server_ciphers off;

    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:10m;
    ssl_session_tickets off;

    # HSTS
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

    # OCSP Stapling
    ssl_stapling on;
    ssl_stapling_verify on;
    resolver 1.1.1.1 8.8.8.8 valid=300s;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Internal Service Communication

In scaled deployments where MiniOp runs multiple services (API, video processor, clip generator), encrypt internal traffic:

```yaml
# docker-compose.yml (excerpt)
services:
  api:
    environment:
      - INTERNAL_TLS_CERT=/certs/api.crt
      - INTERNAL_TLS_KEY=/certs/api.key
      - INTERNAL_CA=/certs/ca.crt
    volumes:
      - ./certs:/certs:ro

  video-processor:
    environment:
      - INTERNAL_TLS_CERT=/certs/processor.crt
      - INTERNAL_TLS_KEY=/certs/processor.key
      - INTERNAL_CA=/certs/ca.crt
    volumes:
      - ./certs:/certs:ro
```

Generate internal certificates with a private CA:

```bash
# Generate CA
openssl genrsa -out ca.key 4096
openssl req -new -x509 -days 365 -key ca.key -out ca.crt \
  -subj "/CN=MiniOp Internal CA"

# Generate service certificate
openssl genrsa -out api.key 2048
openssl req -new -key api.key -out api.csr \
  -subj "/CN=api.minioop-internal"
openssl x509 -req -in api.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out api.crt -days 90 \
  -extfile <(echo "subjectAltName=DNS:api.minioop-internal,DNS:localhost")
```

---

## Video File Storage Security

### Free Tier: Supabase Storage

Supabase Storage encrypts files at rest. Access is controlled via RLS-like policies on storage buckets:

```sql
-- supabase/migrations/011_storage_policies.sql

-- Create a private bucket for video uploads
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'videos',
  'videos',
  false,
  524288000, -- 500MB
  ARRAY['video/mp4', 'video/webm', 'video/quicktime']
);

-- Users can upload to their own folder
CREATE POLICY "users_upload_own_videos"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'videos'
    AND (storage.foldername(name))[1] = auth.uid()::TEXT
  );

-- Users can read their own videos
CREATE POLICY "users_read_own_videos"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'videos'
    AND (storage.foldername(name))[1] = auth.uid()::TEXT
  );

-- Users can delete their own videos
CREATE POLICY "users_delete_own_videos"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'videos'
    AND (storage.foldername(name))[1] = auth.uid()::TEXT
  );
```

Generate signed URLs for video access (time-limited, no public exposure):

```typescript
// lib/storage/videos.ts
export async function getSignedVideoUrl(path: string, expiresIn = 3600) {
  const { data, error } = await supabaseAdmin.storage
    .from('videos')
    .createSignedUrl(path, expiresIn)

  if (error) throw error
  return data.signedUrl
}
```

### Scaled Production: S3 with Server-Side Encryption

```typescript
// lib/storage/s3.ts
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const s3 = new S3Client({ region: process.env.AWS_REGION })

export async function uploadVideo(
  userId: string,
  videoId: string,
  buffer: Buffer,
  contentType: string
) {
  const key = `videos/${userId}/${videoId}/${Date.now()}.mp4`

  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET!,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: process.env.S3_KMS_KEY_ARN!,
    Metadata: {
      'user-id': userId,
      'video-id': videoId,
    },
  }))

  return key
}

export async function getSignedDownloadUrl(key: string, expiresIn = 3600) {
  const command = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET!,
    Key: key,
  })

  return getSignedUrl(s3, command, { expiresIn })
}
```

Bucket policy enforcing encryption:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyUnencryptedUploads",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::minioop-videos/*",
      "Condition": {
        "StringNotEquals": {
          "s3:x-amz-server-side-encryption": "aws:kms"
        }
      }
    },
    {
      "Sid": "DenyHTTP",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::minioop-videos",
        "arn:aws:s3:::minioop-videos/*"
      ],
      "Condition": {
        "Bool": {
          "aws:SecureTransport": "false"
        }
      }
    }
  ]
}
```

---

## Data in Use: Processing Pipeline Security

Video processing (scene detection, transcription, clip generation) happens in isolated worker containers. Each worker receives a signed URL, processes the video, and writes output back to storage. Workers never have direct database access.

```typescript
// workers/video-processor.ts
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp, rm } from 'fs/promises'

export async function processVideo(job: {
  videoId: string
  signedUrl: string
  userId: string
}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'minioop-'))

  try {
    // Download to temp directory
    const response = await fetch(job.signedUrl)
    const buffer = Buffer.from(await response.arrayBuffer())
    const inputPath = join(tempDir, 'input.mp4')
    await writeFile(inputPath, buffer)

    // Process with ffmpeg (scene detection, clip extraction)
    const clips = await extractClips(inputPath, tempDir)

    // Upload results via signed URLs
    for (const clip of clips) {
      await uploadClipResult(job.videoId, clip)
    }
  } finally {
    // Always clean up temp files
    await rm(tempDir, { recursive: true, force: true })
  }
}
```

---

## Secret Management

### Environment Variables (Free Tier)

```bash
# .env.local — never commit this file
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
TOKEN_ENCRYPTION_KEY=256-bit-key-generate-with-openssl-rand-base64-32
```

Generate a strong encryption key:

```bash
openssl rand -base64 32
```

### Vault-Based Secrets (Scaled Production)

Use HashiCorp Vault or AWS Secrets Manager:

```typescript
// lib/secrets/vault.ts
import Vault from 'hashi-vault-node'

const vault = new Vault({
  endpoint: process.env.VAULT_ADDR!,
  token: process.env.VAULT_TOKEN!,
})

export async function getSecret(path: string): Promise<Record<string, string>> {
  const { data } = await vault.kvV2.readSecret({ path })
  return data.data
}

// Usage
const dbCreds = await getSecret('database/creds/minioop')
const encryptionKey = await getSecret('encryption/token-key')
```

Rotate secrets on a schedule:

```bash
# vault-policy.hcl
path "encryption/data/token-key" {
  capabilities = ["read"]
}

path "database/creds/minioop" {
  capabilities = ["read"]
}
```

---

## Data Deletion and Retention

### User Account Deletion

When a user deletes their account, cascade the deletion:

```sql
-- supabase/migrations/012_cascade_delete.sql
ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_owner_id_fkey,
  ADD CONSTRAINT projects_owner_id_fkey
    FOREIGN KEY (owner_id)
    REFERENCES auth.users(id)
    ON DELETE CASCADE;

ALTER TABLE videos
  DROP CONSTRAINT IF EXISTS videos_project_id_fkey,
  ADD CONSTRAINT videos_project_id_fkey
    FOREIGN KEY (project_id)
    REFERENCES projects(id)
    ON DELETE CASCADE;

-- Trigger to clean up storage files on deletion
CREATE OR REPLACE FUNCTION cleanup_user_storage()
RETURNS TRIGGER AS $$
BEGIN
  -- This calls a Supabase Edge Function to delete storage objects
  PERFORM net.http_post(
    url := current_setting('app.settings.storage_cleanup_url'),
    body := jsonb_build_object('user_id', OLD.id),
    headers := jsonb_build_object(
      'Authorization', concat('Bearer ', current_setting('app.settings.service_role_key'))
    )
  );
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_user_deleted
  AFTER DELETE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION cleanup_user_storage();
```

### Video Retention Policy

Enforce retention limits per plan:

```sql
-- Scheduled job to clean up expired free-tier videos
CREATE OR REPLACE FUNCTION cleanup_expired_videos()
RETURNS void AS $$
BEGIN
  -- Delete video records older than 30 days for free-tier users
  DELETE FROM videos
  WHERE id IN (
    SELECT v.id FROM videos v
    JOIN projects p ON v.project_id = p.id
    JOIN auth.users u ON p.owner_id = u.id
    WHERE u.raw_user_meta_data->>'plan' = 'free'
    AND v.created_at < now() - INTERVAL '30 days'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Run daily via pg_cron
SELECT cron.schedule('cleanup-expired-videos', '0 3 * * *', 'SELECT cleanup_expired_videos()');
```

---

## Summary: Free vs. Scaled

| Aspect | Free Tier | Scaled Production |
|---|---|---|
| Disk Encryption | Supabase managed (AES-256) | AWS EBS AES-256 or self-hosted LUKS |
| Column Encryption | `pgcrypto` with env var key | KMS-backed keys via Supabase Vault |
| TLS | Supabase default (TLS 1.2/1.3) | TLS 1.3 enforced, HSTS, OCSP |
| Video Storage | Supabase Storage (encrypted) | S3 + SSE-KMS |
| Internal Traffic | N/A (single service) | mTLS with private CA |
| Secret Management | `.env` files | HashiCorp Vault / AWS Secrets Manager |
| Data Retention | 30-day free-tier cleanup | Configurable per plan, pg_cron |

---

## Next Steps

- Review [04-threat-model.md](./04-threat-model.md) for how encryption mitigations map to specific threats.
- Review [01-authentication.md](./01-authentication.md) for token-level encryption details.
