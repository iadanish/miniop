# Compliance Logging for MiniOp

## Overview

MiniOp handles user-uploaded video content, generates AI-derived clips, processes payment information, and stores personal data. Compliance logging ensures that every data-handling operation is recorded in a way that satisfies regulatory requirements including GDPR, SOC 2 Type II, and CCPA.

This document covers the specific logging patterns, data handling controls, and technical implementations required for compliance across free-tier single-node deployments and scaled production infrastructure.

## Regulatory Requirements Mapped to MiniOp Operations

| Regulation | Requirement | MiniOp Touchpoint |
|-----------|------------|-------------------|
| GDPR Art. 5(1)(f) | Integrity and confidentiality | Video upload, storage, clip generation |
| GDPR Art. 17 | Right to erasure | User deletion requests, data purge jobs |
| GDPR Art. 30 | Records of processing activities | Automated processing log |
| SOC 2 CC6.1 | Logical access controls | Authentication, authorization events |
| SOC 2 CC7.2 | Monitoring | System anomaly detection, access pattern analysis |
| CCPA §1798.100 | Right to know | Data access request fulfillment |
| CCPA §1798.105 | Right to delete | Deletion pipeline logging |

## Data Processing Activity Log

GDPR Article 30 requires a record of processing activities. MiniOp generates this automatically.

```typescript
// src/compliance/processing-log.ts
interface ProcessingActivity {
  activity_id: string;
  description: string;
  legal_basis: 'consent' | 'contract' | 'legitimate_interest' | 'legal_obligation';
  data_categories: string[];
  data_subjects: string[];
  recipients: string[];
  retention_period_days: number;
  cross_border_transfers: boolean;
  security_measures: string[];
}

export const PROCESSING_ACTIVITIES: ProcessingActivity[] = [
  {
    activity_id: 'PA-001',
    description: 'Video upload and temporary storage for clip generation',
    legal_basis: 'contract',
    data_categories: ['video_content', 'file_metadata'],
    data_subjects: ['registered_users'],
    recipients: ['internal_transcoder', 'internal_analyzer'],
    retention_period_days: 30,
    cross_border_transfers: false,
    security_measures: ['encryption_at_rest', 'encryption_in_transit', 'access_control'],
  },
  {
    activity_id: 'PA-002',
    description: 'AI-powered speech-to-text transcription for clip segmentation',
    legal_basis: 'contract',
    data_categories: ['audio_content', 'transcribed_text'],
    data_subjects: ['registered_users', 'video_subjects'],
    recipients: ['whisper_model_service'],
    retention_period_days: 90,
    cross_border_transfers: false,
    security_measures: ['encryption_at_rest', 'access_control', 'model_isolation'],
  },
  {
    activity_id: 'PA-003',
    description: 'Payment processing for premium subscriptions',
    legal_basis: 'contract',
    data_categories: ['payment_method_token', 'billing_address'],
    data_subjects: ['paying_users'],
    recipients: ['stripe'],
    retention_period_days: 365,
    cross_border_transfers: true,
    security_measures: ['pci_dss_compliance', 'tokenization', 'encryption_in_transit'],
  },
];
```

### Processing Activity Log Table

```sql
-- Free tier: SQLite
CREATE TABLE processing_activity_log (
    log_id          TEXT PRIMARY KEY,
    timestamp       TEXT NOT NULL,
    activity_id     TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    data_categories TEXT NOT NULL,  -- JSON array
    operation       TEXT NOT NULL,  -- 'collect', 'process', 'store', 'transfer', 'delete'
    legal_basis     TEXT NOT NULL,
    retention_until TEXT NOT NULL,
    details         TEXT            -- JSON
);

-- Production: ClickHouse
CREATE TABLE processing_activity_log (
    log_id          String,
    timestamp       DateTime64(3),
    activity_id     LowCardinality(String),
    user_id         String,
    data_categories Array(LowCardinality(String)),
    operation       Enum8('collect'=1, 'process'=2, 'store'=3, 'transfer'=4, 'delete'=5),
    legal_basis     LowCardinality(String),
    retention_until DateTime,
    details_json    String
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (user_id, timestamp);
```

### Logging Processing Activities

```typescript
// src/compliance/logger.ts
import { audit } from '../audit/logger';

export async function logProcessing(
  activityId: string,
  userId: string,
  operation: ProcessingOperation,
  details?: Record<string, unknown>
): Promise<void> {
  const activity = PROCESSING_ACTIVITIES.find(a => a.activity_id === activityId);
  if (!activity) throw new Error(`Unknown processing activity: ${activityId}`);

  const retentionUntil = new Date();
  retentionUntil.setDate(retentionUntil.getDate() + activity.retention_period_days);

  await db.prepare(`
    INSERT INTO processing_activity_log
      (log_id, timestamp, activity_id, user_id, data_categories, operation,
       legal_basis, retention_until, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    generateId(),
    new Date().toISOString(),
    activityId,
    userId,
    JSON.stringify(activity.data_categories),
    operation,
    activity.legal_basis,
    retentionUntil.toISOString(),
    JSON.stringify(details || {})
  );
}
```

## Data Subject Rights Logging

Every data subject request (access, deletion, portability) must be logged with full lifecycle tracking.

```typescript
// src/compliance/dsr.ts
interface DataSubjectRequest {
  request_id: string;
  user_id: string;
  request_type: 'access' | 'deletion' | 'portability' | 'rectification' | 'restriction';
  status: 'received' | 'verified' | 'processing' | 'completed' | 'rejected';
  requested_at: string;
  verified_at?: string;
  completed_at?: string;
  rejection_reason?: string;
  fulfiller_id?: string;
  artifacts: string[];  // URLs to generated data exports, confirmation receipts
}
```

### DSR Logging Implementation

```typescript
// src/compliance/dsr-logger.ts
export async function createDSR(
  userId: string,
  type: DataSubjectRequest['request_type'],
  metadata?: Record<string, unknown>
): Promise<DataSubjectRequest> {
  const request: DataSubjectRequest = {
    request_id: `dsr_${uuidv7()}`,
    user_id: userId,
    request_type: type,
    status: 'received',
    requested_at: new Date().toISOString(),
    artifacts: [],
  };

  await db.run(
    `INSERT INTO dsr_log (request_id, user_id, request_type, status, requested_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [request.request_id, userId, type, 'received', request.requested_at, JSON.stringify(metadata)]
  );

  // Trigger identity verification workflow
  await verificationQueue.add('verify-dsr', { requestId: request.request_id });

  // Compliance log: request received
  await logComplianceEvent('dsr.received', {
    request_id: request.request_id,
    user_id: userId,
    type,
  });

  return request;
}

export async function completeDSR(
  requestId: string,
  fulfillerId: string,
  artifacts: string[]
): Promise<void> {
  const now = new Date().toISOString();
  await db.run(
    `UPDATE dsr_log SET status = 'completed', completed_at = ?, fulfiller_id = ?, artifacts = ?
     WHERE request_id = ?`,
    [now, fulfillerId, JSON.stringify(artifacts), requestId]
  );

  await logComplianceEvent('dsr.completed', {
    request_id: requestId,
    fulfiller_id: fulfillerId,
    artifacts,
    processing_duration_hours: calculateDuration(requestId),
  });
}
```

## GDPR Deletion Pipeline Logging

When a user requests deletion, every step must be logged to prove compliance.

```typescript
// src/compliance/deletion-pipeline.ts
export async function executeDeletion(userId: string, requestId: string): Promise<void> {
  const steps = [
    { name: 'revoke_sessions', fn: () => revokeAllSessions(userId) },
    { name: 'delete_uploads', fn: () => deleteS3Prefix(`uploads/${userId}/`) },
    { name: 'delete_clips', fn: () => deleteS3Prefix(`clips/${userId}/`) },
    { name: 'delete_transcriptions', fn: () => deleteTranscriptions(userId) },
    { name: 'anonymize_audit_logs', fn: () => anonymizeAuditLogs(userId) },
    { name: 'delete_user_record', fn: () => deleteUser(userId) },
    { name: 'purge_cdn_cache', fn: () => purgeCDNForUser(userId) },
    { name: 'notify_downstream', fn: () => notifyDownstreamServices(userId) },
  ];

  for (const step of steps) {
    const startTime = Date.now();
    try {
      await step.fn();
      await logDeletionStep(requestId, userId, step.name, 'success', Date.now() - startTime);
    } catch (error) {
      await logDeletionStep(requestId, userId, step.name, 'failed', Date.now() - startTime, {
        error: error.message,
        stack: error.stack,
      });
      // Continue with remaining steps — partial deletion is better than none
      // Failed steps are flagged for manual review
    }
  }
}

async function logDeletionStep(
  requestId: string,
  userId: string,
  step: string,
  outcome: 'success' | 'failed',
  durationMs: number,
  details?: Record<string, unknown>
): Promise<void> {
  const logEntry = {
    request_id: requestId,
    user_id: userId,
    step,
    outcome,
    duration_ms: durationMs,
    timestamp: new Date().toISOString(),
    details,
  };

  // Write to compliance log (separate from audit log — different retention)
  await complianceDb.run(
    `INSERT INTO deletion_log (request_id, user_id, step, outcome, duration_ms, timestamp, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [requestId, userId, step, outcome, durationMs, logEntry.timestamp, JSON.stringify(details)]
  );
}
```

## Consent Management Logging

```typescript
// src/compliance/consent.ts
interface ConsentRecord {
  consent_id: string;
  user_id: string;
  purpose: string;           // 'analytics', 'marketing', 'ai_training', 'third_party_sharing'
  granted: boolean;
  timestamp: string;
  ip_address: string;
  user_agent: string;
  version: string;           // Consent policy version
  method: 'banner' | 'settings' | 'signup' | 'email_verification';
}

export async function recordConsent(
  userId: string,
  purpose: string,
  granted: boolean,
  req: Request,
  policyVersion: string
): Promise<void> {
  const record: ConsentRecord = {
    consent_id: uuidv7(),
    user_id: userId,
    purpose,
    granted,
    timestamp: new Date().toISOString(),
    ip_address: req.ip,
    user_agent: req.headers['user-agent'],
    version: policyVersion,
    method: req.body.method || 'settings',
  };

  await db.run(
    `INSERT INTO consent_log (consent_id, user_id, purpose, granted, timestamp,
     ip_address, user_agent, policy_version, method)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.consent_id, userId, purpose, granted, record.timestamp,
     record.ip_address, record.user_agent, policyVersion, record.method]
  );

  // Audit the consent change
  await audit.log({
    actor: { user_id: userId, session_id: req.session.id, ip_address: req.ip, user_agent: req.headers['user-agent'] },
    action: `consent.${granted ? 'grant' : 'revoke'}`,
    resource: { type: 'consent', id: record.consent_id, project_id: null },
    outcome: 'success',
    metadata: { purpose, version: policyVersion },
  });
}
```

## Data Access Logging for CCPA "Right to Know"

When a user requests to know what data MiniOp holds about them, log every query made to fulfill the request.

```typescript
// src/compliance/data-access-report.ts
export async function generateDataAccessReport(userId: string): Promise<DataAccessReport> {
  const reportId = `dar_${uuidv7()}`;
  const sections: DataAccessSection[] = [];

  const queries = [
    { name: 'profile', fn: () => getUserProfile(userId) },
    { name: 'uploads', fn: () => getUserUploads(userId) },
    { name: 'clips', fn: () => getUserClips(userId) },
    { name: 'transcriptions', fn: () => getUserTranscriptions(userId) },
    { name: 'billing', fn: () => getUserBillingHistory(userId) },
    { name: 'consent_history', fn: () => getConsentHistory(userId) },
    { name: 'sessions', fn: () => getUserSessions(userId) },
  ];

  for (const query of queries) {
    const start = Date.now();
    const data = await query.fn();
    sections.push({
      category: query.name,
      record_count: Array.isArray(data) ? data.length : 1,
      data,
      queried_at: new Date().toISOString(),
      query_duration_ms: Date.now() - start,
    });
  }

  const report: DataAccessReport = {
    report_id: reportId,
    user_id: userId,
    generated_at: new Date().toISOString(),
    sections,
    total_records: sections.reduce((sum, s) => sum + s.record_count, 0),
  };

  // Log the report generation
  await logProcessing('PA-001', userId, 'collect', {
    report_id: reportId,
    section_count: sections.length,
    total_records: report.total_records,
  });

  return report;
}
```

## Free Tier Compliance Storage

On the free tier, compliance logs live in the same SQLite database as the application but in separate tables:

```sql
-- Compliance-specific tables for free tier
CREATE TABLE dsr_log (
    request_id      TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    request_type    TEXT NOT NULL,
    status          TEXT NOT NULL,
    requested_at    TEXT NOT NULL,
    verified_at     TEXT,
    completed_at    TEXT,
    fulfiller_id    TEXT,
    artifacts       TEXT,  -- JSON array
    metadata        TEXT   -- JSON
);

CREATE TABLE consent_log (
    consent_id      TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    purpose         TEXT NOT NULL,
    granted         INTEGER NOT NULL,  -- boolean
    timestamp       TEXT NOT NULL,
    ip_address      TEXT,
    user_agent      TEXT,
    policy_version  TEXT NOT NULL,
    method          TEXT NOT NULL
);

CREATE INDEX idx_consent_user ON consent_log(user_id, purpose, timestamp DESC);
CREATE INDEX idx_dsr_user ON dsr_log(user_id, status);
```

## Production Compliance Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌───────────────┐
│  Application    │────▶│ Redis Stream │────▶│ Compliance    │
│  (DSR/Consent/  │     │ compliance:  │     │ Consumer      │
│   Deletion)     │     │ events       │     │               │
└─────────────────┘     └──────────────┘     └───────┬───────┘
                                                      │
                                         ┌────────────┼────────────┐
                                         ▼            ▼            ▼
                                   ┌──────────┐ ┌──────────┐ ┌──────────┐
                                   │PostgreSQL│ │ S3 Audit │ │ PagerDuty│
                                   │(primary) │ │ Bucket   │ │ (alerts) │
                                   └──────────┘ └──────────┘ └──────────┘
```

Production uses PostgreSQL for compliance data (with row-level security) and S3 with versioning and Object Lock for immutable audit trails.

```sql
-- PostgreSQL with row-level security
ALTER TABLE dsr_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY compliance_team_only ON dsr_log
    USING (current_setting('app.role') IN ('compliance', 'admin'));

-- S3 bucket policy for immutable compliance logs
-- aws s3api put-object-lock-configuration --bucket minio-compliance-logs \
--   --object-lock-configuration '{ "ObjectLockEnabled": true, "Rule": { "DefaultRetention": { "Mode": "COMPLIANCE", "Years": 7 } } }'
```

## Compliance Reporting

Generate monthly compliance reports:

```sql
-- DSR fulfillment metrics
SELECT
    request_type,
    status,
    COUNT(*) AS count,
    AVG(JULIANDAY(completed_at) - JULIANDAY(requested_at)) AS avg_days_to_complete
FROM dsr_log
WHERE requested_at >= date('now', 'start of month')
GROUP BY request_type, status;
```

## Summary

Compliance logging in MiniOp covers GDPR data subject requests, CCPA right-to-know, consent management, and data deletion pipelines. Every compliance operation produces immutable, auditable records. The free tier stores compliance data in dedicated SQLite tables; production uses PostgreSQL with row-level security and S3 Object Lock for tamper-proof retention. Automated reporting tracks DSR fulfillment times and consent changes.
