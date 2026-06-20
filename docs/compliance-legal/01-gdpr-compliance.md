# GDPR Compliance Guide for MiniOp

## Overview

MiniOp processes video content uploaded by users, extracts metadata, generates AI-powered clips, and stores resulting media assets. Under the General Data Protection Regulation (EU 2016/679), this processing involves personal data at multiple stages. This document provides actionable compliance guidance for both the free-tier self-hosted deployment and scaled production environments.

## Data Processing Activities

### Categories of Personal Data Processed

| Data Category | Source | Legal Basis | Retention |
|---|---|---|---|
| User account data (email, name, hashed password) | Registration | Contract (Art. 6(1)(b)) | Account lifetime + 30 days |
| Uploaded video content | User upload | Contract (Art. 6(1)(b)) | 90 days post-processing or user deletion |
| Generated clip metadata | AI processing | Legitimate interest (Art. 6(1)(f)) | Account lifetime |
| Usage analytics (page views, feature usage) | Service logs | Legitimate interest (Art. 6(1)(f)) | 12 months |
| IP addresses and device fingerprints | Request headers | Legitimate interest (Art. 6(1)(f)) | 90 days |
| Payment data | Stripe integration | Contract (Art. 6(1)(b)) | As required by tax law |

### Data Flow Architecture

```
User Upload → Transcoding Pipeline → AI Processing → Storage → Delivery
     |              |                    |              |          |
  [PII: file]   [temp PII]        [derived PII]    [PII: URL]  [PII: IP]
     ↓              ↓                    ↓              ↓          ↓
  S3 bucket    ephemeral disk     vector DB         S3/CDN     access logs
```

## Implementation: Data Subject Rights

### Right to Access (Article 15)

Implement an endpoint that returns all personal data for a requesting user:

```python
# app/api/gdpr.py
from fastapi import APIRouter, Depends, HTTPException
from app.models import User, Video, Clip, AuditLog
from app.auth import get_current_user
from app.export import generate_data_package

router = APIRouter(prefix="/api/v1/gdpr")

@router.get("/data-export")
async def export_user_data(current_user: User = Depends(get_current_user)):
    """GDPR Article 15 - Right of Access. Returns all personal data as JSON."""
    data = {
        "account": {
            "email": current_user.email,
            "name": current_user.name,
            "created_at": current_user.created_at.isoformat(),
            "plan": current_user.subscription_tier,
        },
        "videos": [
            {
                "id": v.id,
                "filename": v.original_filename,
                "uploaded_at": v.created_at.isoformat(),
                "duration_seconds": v.duration,
                "status": v.status,
            }
            for v in await Video.filter(user_id=current_user.id)
        ],
        "clips": [
            {
                "id": c.id,
                "video_id": c.video_id,
                "title": c.title,
                "score": c.virality_score,
                "created_at": c.created_at.isoformat(),
            }
            for c in await Clip.filter(user_id=current_user.id)
        ],
        "audit_log": [
            {
                "action": log.action,
                "timestamp": log.created_at.isoformat(),
                "ip_address": log.ip_address,
            }
            for log in await AuditLog.filter(user_id=current_user.id)
        ],
    }
    return data
```

### Right to Erasure (Article 17)

Implement a cascade deletion that removes all user data within 72 hours:

```python
# app/services/erasure.py
from datetime import datetime, timedelta
from app.models import User, Video, Clip
from app.storage import delete_s3_objects
from app.db import get_db

async def process_erasure_request(user_id: str) -> dict:
    """GDPR Article 17 - Right to Erasure. Deletes all user data."""
    db = await get_db()
    
    async with db.transaction():
        # 1. Delete all clip files from storage
        clips = await Clip.filter(user_id=user_id)
        clip_keys = [c.storage_key for c in clips if c.storage_key]
        
        # 2. Delete all original video files from storage
        videos = await Video.filter(user_id=user_id)
        video_keys = [v.storage_key for v in videos if v.storage_key]
        
        # 3. Remove from object storage
        all_keys = clip_keys + video_keys
        if all_keys:
            await delete_s3_objects(all_keys)
        
        # 4. Delete database records (cascade handles related tables)
        await Clip.filter(user_id=user_id).delete()
        await Video.filter(user_id=user_id).delete()
        
        # 5. Anonymize the user record instead of hard delete
        # (preserves referential integrity for audit logs)
        user = await User.get(id=user_id)
        user.email = f"erased-{user.id}@anonymized.minio"
        user.name = "Erased User"
        user.is_erased = True
        user.erased_at = datetime.utcnow()
        await user.save()
    
    return {
        "status": "completed",
        "files_deleted": len(all_keys),
        "completed_at": datetime.utcnow().isoformat(),
    }
```

### Right to Rectification (Article 16)

```python
@router.put("/data-rectification")
async def rectify_user_data(
    updates: dict,
    current_user: User = Depends(get_current_user),
):
    """GDPR Article 16 - Right to Rectification."""
    allowed_fields = {"name", "email"}
    invalid = set(updates.keys()) - allowed_fields
    if invalid:
        raise HTTPException(400, f"Cannot rectify fields: {invalid}")
    
    for field, value in updates.items():
        setattr(current_user, field, value)
    await current_user.save()
    
    await AuditLog.create(
        user_id=current_user.id,
        action="data_rectification",
        details={"fields": list(updates.keys())},
    )
    return {"status": "updated"}
```

## Data Protection Impact Assessment (DPIA)

MiniOp requires a DPIA under Article 35 because it performs systematic monitoring through analytics and processes video content at scale using AI.

### DPIA Template for MiniOp

```yaml
# dpia-minio.yaml
assessment:
  name: "MiniOp Video Processing DPIA"
  version: "1.0"
  date: "2026-01-15"
  assessor: "Data Protection Officer"

processing_description: >
  MiniOp accepts video uploads, transcodes them into multiple formats,
  runs AI models to identify high-engagement segments, and generates
  short-form clips. Processing includes speech-to-text transcription,
  scene detection, and sentiment analysis.

necessity_and_proportionality:
  purpose: "Automated video editing to reduce manual effort for content creators"
  data_minimization:
    - Videos are processed and deleted within 90 days
    - Transcriptions are stored as text, not audio
    - Face detection uses bounding boxes, not facial recognition embeddings
  storage_limitation:
    - Original files: 90 days
    - Generated clips: until user deletion
    - Analytics: 12 months rolling

risks:
  - description: "Unauthorized access to uploaded video content"
    likelihood: "medium"
    severity: "high"
    mitigation: "AES-256 encryption at rest, TLS 1.3 in transit, RBAC access controls"
  - description: "AI model retaining training data from user uploads"
    likelihood: "low"
    severity: "critical"
    mitigation: "Models run in isolated containers with no persistent state. No user data used for training."
  - description: "Cross-border data transfer outside EEA"
    likelihood: "high"
    severity: "medium"
    mitigation: "Standard Contractual Clauses (SCCs) with AWS, data residency configuration per tenant"

consultation:
  dpo_approved: true
  supervisory_authority_required: false
  next_review: "2026-07-15"
```

## Technical Measures

### Encryption Configuration

```yaml
# docker-compose.yml (relevant environment variables)
services:
  api:
    environment:
      # AES-256 encryption for data at rest
      ENCRYPTION_KEY: ${MINIO_ENCRYPTION_KEY}
      ENCRYPTION_ALGORITHM: "AES-256-GCM"
      # TLS 1.3 enforced
      FORCE_HTTPS: "true"
      TLS_MIN_VERSION: "1.3"
      # S3 server-side encryption
      S3_SSE_ALGORITHM: "aws:kms"
      S3_SSE_KMS_KEY_ID: ${AWS_KMS_KEY_ID}
```

### Consent Management

```javascript
// frontend/src/components/CookieConsent.jsx
import { useState, useEffect } from 'react';

const CONSENT_CATEGORIES = {
  necessary: { required: true, description: 'Essential for service operation' },
  analytics: { required: false, description: 'Usage analytics and performance metrics' },
  marketing: { required: false, description: 'Email campaigns and promotional content' },
};

export function CookieConsent() {
  const [consent, setConsent] = useState(null);

  useEffect(() => {
    const saved = localStorage.getItem('gdpr_consent');
    if (saved) setConsent(JSON.parse(saved));
  }, []);

  const saveConsent = (choices) => {
    const record = {
      ...choices,
      timestamp: new Date().toISOString(),
      version: '1.0',
      ip_hash: 'server-side-hashed', // Do NOT store raw IP in consent record
    };
    localStorage.setItem('gdpr_consent', JSON.stringify(record));
    
    // Send to server for audit trail
    fetch('/api/v1/gdpr/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    
    setConsent(record);
    
    // Activate/deactivate tracking scripts based on consent
    if (choices.analytics) window._paq?.push(['optUserIn']);
    else window._paq?.push(['optUserOut']);
  };

  if (consent) return null;

  return (
    <div className="cookie-banner">
      <p>We use cookies. Manage your preferences below.</p>
      {Object.entries(CONSENT_CATEGORIES).map(([key, cat]) => (
        <label key={key}>
          <input type="checkbox" defaultChecked={cat.required} disabled={cat.required} />
          {cat.description}
        </label>
      ))}
      <button onClick={() => saveConsent({ necessary: true, analytics: false, marketing: false })}>
        Reject Optional
      </button>
      <button onClick={() => saveConsent({ necessary: true, analytics: true, marketing: true })}>
        Accept All
      </button>
    </div>
  );
}
```

## Breach Notification Procedure

Under Article 33, reportable breaches must be notified to the supervisory authority within 72 hours.

```python
# app/services/breach_handler.py
from datetime import datetime

BREACH_TEMPLATE = """
BREACH NOTIFICATION - Article 33 GDPR

Incident ID: {incident_id}
Detected: {detected_at}
Reported to DPO: {dpo_notified_at}
Nature of breach: {nature}
Categories affected: {categories}
Approximate data subjects: {subject_count}
Likely consequences: {consequences}
Measures taken: {measures}
Measures proposed: {proposed_measures}

DPO Contact: dpo@minio.example.com
"""

async def handle_breach(incident_id: str, details: dict):
    """72-hour notification workflow."""
    timeline = {
        "detected": datetime.utcnow(),
        "dpo_notified": None,
        "authority_notified": None,
        "subjects_notified": None,
    }
    
    # Step 1: Notify DPO within 1 hour
    await notify_dpo(incident_id, details)
    timeline["dpo_notified"] = datetime.utcnow()
    
    # Step 2: Assess severity
    if details["likely_harm"] in ("high", "critical"):
        # Article 33: notify supervisory authority within 72 hours
        await notify_authority(incident_id, BREACH_TEMPLATE.format(**details))
        timeline["authority_notified"] = datetime.utcnow()
        
        # Article 34: notify data subjects if high risk
        if details["likely_harm"] == "critical":
            await notify_affected_users(incident_id, details["affected_user_ids"])
            timeline["subjects_notified"] = datetime.utcnow()
    
    await log_breach_response(incident_id, timeline)
    return timeline
```

## Free-Tier vs Production Differences

| Requirement | Free Tier (Self-Hosted) | Production (SaaS) |
|---|---|---|
| DPO appointment | Not required (no systematic monitoring at scale) | Required if processing >5000 subjects/year |
| DPIA | Recommended | Mandatory |
| Records of processing (Art. 30) | Maintain manually | Automated via audit logs |
| Data transfer mechanisms | Self-hosted = no transfer | SCCs with cloud providers |
| Consent management | Cookie banner sufficient | Full consent management platform |
| Breach notification | Manual process | Automated alerting pipeline |

## Sub-Processor Agreements

For production deployments using third-party services, maintain a sub-processor list:

```yaml
# sub-processors.yaml
sub_processors:
  - name: "AWS S3"
    purpose: "Video and clip storage"
    location: "eu-west-1 (Ireland)"
    dpa_signed: true
    dpa_date: "2025-06-01"
  - name: "Stripe"
    purpose: "Payment processing"
    location: "EU (Frankfurt)"
    dpa_signed: true
    dpa_date: "2025-06-01"
  - name: "OpenAI API"
    purpose: "AI transcription (Whisper)"
    location: "US (with SCCs)"
    dpa_signed: true
    dpa_date: "2025-06-01"
    notes: "Data not used for model training per enterprise agreement"
```

## Checklist

- [ ] Data Processing Agreement signed with all sub-processors
- [ ] Cookie consent mechanism deployed and tested
- [ ] Data export endpoint functional and returning complete data
- [ ] Erasure endpoint tested with cascade deletion verification
- [ ] Breach notification procedure documented and DPO contact active
- [ ] Encryption at rest (AES-256) and in transit (TLS 1.3) verified
- [ ] Consent records stored with timestamp and version
- [ ] Data retention automated (TTL policies on S3, scheduled DB cleanup)
- [ ] Privacy by default: all new features ship with data minimization review
