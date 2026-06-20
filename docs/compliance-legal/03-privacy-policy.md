# MiniOp Privacy Policy

**Effective Date:** January 1, 2026  
**Last Updated:** January 1, 2026  
**Version:** 1.0

## 1. Introduction

This Privacy Policy describes how MiniOp ("we", "us", "our") collects, uses, stores, and protects personal data when you use our video processing platform. This policy applies to both the managed SaaS service (app.minio.example.com) and self-hosted deployments where MiniOp acts as the data processor.

If you are a resident of the European Economic Area (EEA), United Kingdom, or California, additional rights apply as described in Sections 9, 10, and 11.

## 2. Data We Collect

### 2.1 Data You Provide

| Data | When Collected | Required? | Storage Location |
|---|---|---|---|
| Email address | Account registration | Yes | Primary database (encrypted at rest) |
| Name | Account registration | Yes | Primary database |
| Password (hashed, bcrypt) | Account registration | Yes | Primary database |
| Payment card details | Subscription purchase | Paid plans only | Stripe (we never store raw card data) |
| Video files | Upload | Yes (core functionality) | S3-compatible object storage |
| Clip titles, descriptions | User input | Optional | Primary database |
| Team member emails | Workspace invitations | Optional | Primary database |

### 2.2 Data Collected Automatically

```python
# app/telemetry/collector.py
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

@dataclass
class ServiceTelemetry:
    """What we automatically collect. This schema is the source of truth."""
    
    # Request metadata
    ip_address: str              # Stored hashed after 90 days
    user_agent: str              # Stored for 90 days
    request_id: str              # UUID, stored for 30 days
    
    # Usage events
    event_type: str              # "upload", "process", "export", "api_call"
    event_timestamp: datetime
    feature_used: str            # e.g., "auto_clip", "transcription", "export_mp4"
    processing_duration_ms: int  # Performance monitoring
    file_size_bytes: Optional[int]
    
    # Device/session
    session_id: str              # UUID, expires after 24h inactivity
    browser_locale: str          # e.g., "en-US"
    screen_resolution: Optional[str]  # If provided by client
    
    # We do NOT collect:
    # - Keystrokes or input beyond explicit form submissions
    # - Browsing history outside MiniOp
    # - Contact lists or address books
    # - Location data beyond country-level (derived from IP)
```

### 2.3 Data from Third Parties

- **Stripe:** Payment status, subscription tier, billing address (country only)
- **OAuth providers (Google, GitHub):** Email, name, profile photo URL (if you sign in via SSO)
- **No data purchased from data brokers**

## 3. How We Use Your Data

### 3.1 Purpose-Limited Processing

```yaml
# Processing purposes and legal bases
purposes:
  service_provision:
    description: "Process videos, generate clips, deliver results"
    legal_basis: "Contract performance (Art. 6(1)(b) GDPR)"
    data_used: ["videos", "clips", "account_data", "usage_events"]
    retention: "Duration of account + 30 days"
  
  payment_processing:
    description: "Charge subscription fees, process refunds"
    legal_basis: "Contract performance (Art. 6(1)(b) GDPR)"
    data_used: ["email", "payment_token", "billing_address"]
    retention: "7 years (tax compliance)"
  
  abuse_prevention:
    description: "Detect fraud, enforce rate limits, prevent ToS violations"
    legal_basis: "Legitimate interest (Art. 6(1)(f) GDPR)"
    data_used: ["ip_address", "user_agent", "usage_patterns"]
    retention: "12 months"
  
  service_improvement:
    description: "Aggregate analytics for feature development"
    legal_basis: "Legitimate interest (Art. 6(1)(f) GDPR)"
    data_used: ["anonymized_usage_events"]
    retention: "24 months (anonymized)"
  
  marketing_communications:
    description: "Product updates, feature announcements"
    legal_basis: "Consent (Art. 6(1)(a) GDPR)"
    data_used: ["email"]
    retention: "Until consent withdrawn"
    opt_out: "Unsubscribe link in every email + Settings > Notifications"
```

### 3.2 AI Processing Disclosure

MiniOp uses AI models to analyze your video content. Here is exactly what happens:

```python
# app/processing/pipeline.py
"""
Transparent disclosure of AI processing stages.
Each stage processes user content for a specific purpose.
No stage retains data beyond its output.
"""

AI_PROCESSING_STAGES = [
    {
        "stage": "speech_to_text",
        "model": "Whisper (OpenAI)",
        "input": "audio track extracted from video",
        "output": "text transcript with timestamps",
        "data_retained": "transcript only (audio discarded after processing)",
        "model_training": False,
    },
    {
        "stage": "scene_detection",
        "model": "YOLOv8 + custom classifier",
        "input": "video frames (sampled at 1fps)",
        "output": "scene boundary timestamps",
        "data_retained": "timestamps only (frames discarded)",
        "model_training": False,
    },
    {
        "stage": "sentiment_analysis",
        "model": "DistilBERT fine-tuned",
        "input": "text transcript",
        "output": "sentiment scores per segment",
        "data_retained": "scores only (not input text)",
        "model_training": False,
    },
    {
        "stage": "virality_scoring",
        "model": "proprietary regression model",
        "input": "scene metadata + transcript + audio features",
        "output": "score 0-100 per potential clip",
        "data_retained": "score + feature vector (not source content)",
        "model_training": False,
    },
    {
        "stage": "clip_assembly",
        "model": "deterministic (no ML)",
        "input": "scene boundaries + scores + user preferences",
        "output": "trimmed video clips",
        "data_retained": "output clips stored per retention policy",
        "model_training": False,
    },
]
```

**Critical commitment:** None of your uploaded content is used to train AI models. This is enforced at the infrastructure level (see Terms of Service, Section 5.3).

## 4. Data Storage and Security

### 4.1 Infrastructure

```yaml
# Production infrastructure (managed service)
infrastructure:
  compute:
    provider: "AWS"
    region_primary: "eu-west-1 (Ireland)"
    region_secondary: "us-east-1 (Virginia)"
    isolation: "dedicated namespaces per tenant on Enterprise plans"
  
  storage:
    object_storage: "S3"
    encryption_at_rest: "AES-256 (AWS KMS managed keys)"
    encryption_in_transit: "TLS 1.3"
    bucket_policy: "private, no public access"
  
  database:
    engine: "PostgreSQL 16"
    encryption: "AES-256 (RDS managed)"
    backup_frequency: "daily"
    backup_retention: "30 days"
    backup_encryption: "AES-256"
  
  secrets:
    management: "AWS Secrets Manager"
    rotation: "automatic, 90-day cycle"
    access: "IAM role-based, least privilege"
```

### 4.2 Self-Hosted Security Recommendations

For self-hosted deployments, the following security configuration is recommended:

```yaml
# docker-compose.security.yaml
services:
  api:
    environment:
      - DATABASE_URL=postgresql://minio:${DB_PASSWORD}@db:5432/minio
      - S3_ENDPOINT=https://your-s3-compatible-storage
      - S3_BUCKET=minio-videos
      - ENCRYPTION_KEY=${AES_256_KEY}
      - TLS_CERT_PATH=/certs/fullchain.pem
      - TLS_KEY_PATH=/certs/privkey.pem
    read_only: true
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:size=2G  # Ephemeral storage for transcoding (auto-wiped)
  
  db:
    environment:
      - POSTGRES_PASSWORD=${DB_PASSWORD}
    volumes:
      - db_data:/var/lib/postgresql/data
    command: >
      postgres
        -c ssl=on
        -c ssl_cert_file=/certs/db-cert.pem
        -c ssl_key_file=/certs/db-key.pem
        -c log_connections=on
        -c log_disconnections=on

volumes:
  db_data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /encrypted-volume/postgres  # Use LUKS or similar full-disk encryption
```

## 5. Data Sharing and Disclosure

### 5.1 We Share Data With

| Recipient | Purpose | Data Shared | Safeguard |
|---|---|---|---|
| Stripe | Payment processing | Email, payment amount, currency | DPA signed, PCI DSS compliant |
| AWS | Infrastructure hosting | All data (encrypted) | DPA signed, SCCs in place |
| OpenAI API | Transcription (Whisper) | Audio segments only | DPA signed, no training on data |
| SendGrid | Transactional emails | Email address, name | DPA signed |
| Sentry | Error tracking | Stack traces, anonymized user ID | DPA signed, PII scrubbing enabled |

### 5.2 We Do NOT Share Data With

- Data brokers or advertising networks
- Social media platforms (unless you explicitly export clips)
- Law enforcement without valid legal process
- Any party for purposes unrelated to Service provision

### 5.3 Legal Disclosure

We may disclose data when required by valid legal process (subpoena, court order, warrant). Our policy:

```python
# app/legal/disclosure.py
async def handle_legal_request(request: dict) -> dict:
    """Process law enforcement data requests."""
    
    # 1. Verify the request is from a legitimate authority
    if not await verify_legal_authority(request["issuing_authority"]):
        return {"status": "rejected", "reason": "unverifiable_authority"}
    
    # 2. Verify the request is properly scoped
    if not request.get("specific_user_ids"):
        return {"status": "rejected", "reason": "overbroad_request"}
    
    # 3. Notify the affected user(s) unless gagged by court order
    if not request.get("non_disclosure_order"):
        await notify_user_of_legal_request(
            user_ids=request["specific_user_ids"],
            request_type=request["type"],
            issuing_authority=request["issuing_authority"],
        )
    
    # 4. Provide only the minimum data required
    scope = request["data_categories"]
    data = await collect_minimal_data(request["specific_user_ids"], scope)
    
    # 5. Log for transparency report
    await log_disclosure(request["request_id"], scope, len(data))
    
    return {"status": "complied", "records_provided": len(data)}
```

## 6. Data Retention

### 6.1 Automated Retention Policies

```python
# app/services/retention.py
from datetime import datetime, timedelta

RETENTION_POLICIES = {
    "uploaded_videos": {
        "retention_days": 90,
        "post_expiry_action": "delete_from_storage",
        "exception": "active_legal_hold",
    },
    "generated_clips": {
        "retention_days": "account_lifetime",
        "post_expiry_action": "delete_on_account_deletion",
        "exception": "user_marked_export",
    },
    "transcripts": {
        "retention_days": 90,
        "post_expiry_action": "delete",
        "exception": "user_saved",
    },
    "audit_logs": {
        "retention_days": 365,
        "post_expiry_action": "anonymize",
        "exception": "active_investigation",
    },
    "ip_addresses": {
        "retention_days": 90,
        "post_expiry_action": "hash_irreversibly",
        "exception": "abuse_investigation",
    },
    "analytics_events": {
        "retention_days": 730,
        "post_expiry_action": "delete",
        "exception": "none",
    },
    "payment_records": {
        "retention_days": 2555,  # 7 years
        "post_expiry_action": "delete",
        "exception": "tax_audit",
    },
}

async def run_retention_cleanup():
    """Scheduled job: runs daily at 03:00 UTC."""
    for resource, policy in RETENTION_POLICIES.items():
        cutoff = datetime.utcnow() - timedelta(days=policy["retention_days"])
        deleted = await apply_retention(resource, cutoff, policy)
        await log_retention_action(resource, deleted)
```

### 6.2 Deletion Verification

After data deletion, MiniOp generates a verifiable deletion certificate:

```python
async def generate_deletion_certificate(user_id: str, deleted_items: list) -> dict:
    """Cryptographic proof of deletion for compliance audits."""
    import hashlib
    
    cert = {
        "user_id_hash": hashlib.sha256(user_id.encode()).hexdigest(),
        "deleted_at": datetime.utcnow().isoformat(),
        "items": [
            {
                "type": item["type"],
                "count": item["count"],
                "storage_locations": item["locations"],
                "verification_hash": hashlib.sha256(
                    f"{item['type']}:{item['count']}:{item['locations']}".encode()
                ).hexdigest(),
            }
            for item in deleted_items
        ],
    }
    
    cert["certificate_hash"] = hashlib.sha256(
        str(cert).encode()
    ).hexdigest()
    
    return cert
```

## 7. Cookies and Tracking

### 7.1 Cookie Inventory

```yaml
cookies:
  necessary:
    - name: "session_id"
      purpose: "Authentication session"
      duration: "24 hours"
      http_only: true
      secure: true
      same_site: "strict"
    
    - name: "csrf_token"
      purpose: "Cross-site request forgery protection"
      duration: "session"
      http_only: false
      secure: true
      same_site: "strict"
  
  functional:
    - name: "user_preferences"
      purpose: "UI preferences (theme, language, layout)"
      duration: "1 year"
      http_only: false
      secure: true
  
  analytics:
    - name: "_paq_id"
      purpose: "Matomo analytics (self-hosted, no third-party)"
      duration: "13 months"
      http_only: false
      secure: true
      requires_consent: true
    
    - name: "_paq_ses"
      purpose: "Matomo session tracking"
      duration: "30 minutes"
      http_only: false
      secure: true
      requires_consent: true
```

### 7.2 Do Not Track

MiniOp respects the DNT header. When `DNT: 1` is present, analytics cookies are not set regardless of consent status.

## 8. Your Rights

### 8.1 Universal Rights (All Users)

- **Access:** Request a copy of all personal data we hold (Section 8.3)
- **Deletion:** Request permanent deletion of your account and data
- **Portability:** Export your data in JSON and MP4 formats
- **Correction:** Update your account information at any time
- **Withdraw consent:** Opt out of marketing communications

### 8.2 Exercising Your Rights

```python
# app/api/privacy.py
from fastapi import APIRouter, Depends
from app.auth import get_current_user
from app.models import User

router = APIRouter(prefix="/api/v1/privacy")

@router.post("/rights-request")
async def submit_rights_request(
    request_type: str,  # "access", "delete", "portability", "correct"
    details: str = "",
    current_user: User = Depends(get_current_user),
):
    """Unified endpoint for exercising privacy rights."""
    
    VALID_REQUESTS = {"access", "delete", "portability", "correct"}
    if request_type not in VALID_REQUESTS:
        return {"error": f"Invalid request type. Must be one of: {VALID_REQUESTS}"}
    
    # Create a tracked request
    request = await PrivacyRequest.create(
        user_id=current_user.id,
        type=request_type,
        details=details,
        status="pending",
        deadline=datetime.utcnow() + timedelta(days=30),  # GDPR: 30 days
    )
    
    # Auto-fulfill where possible
    if request_type == "portability":
        export = await generate_full_export(current_user.id)
        await send_export_link(current_user.email, export)
        request.status = "completed"
        await request.save()
    
    return {
        "request_id": request.id,
        "type": request_type,
        "status": request.status,
        "estimated_completion": request.deadline.isoformat(),
    }
```

## 9. EEA/UK Residents: GDPR Rights

Under GDPR and UK GDPR, you have additional rights:

- **Right to restrict processing** (Art. 18): Request that we limit how we use your data
- **Right to object** (Art. 21): Object to processing based on legitimate interest
- **Right not to be subject to automated decision-making** (Art. 22): MiniOp's virality scoring is automated but does not produce legal or similarly significant effects. You may request human review of any automated output.
- **Right to lodge a complaint** with your local supervisory authority

**Data Controller:** MiniOp Inc., Delaware, USA  
**Data Protection Officer:** dpo@minio.example.com  
**EU Representative:** [EU representative details if applicable under Art. 27]

**Legal bases for processing:** See Section 3.1 above for a complete mapping of purposes to legal bases.

**International transfers:** Data is transferred to the US under Standard Contractual Clauses (SCCs) approved by the European Commission. Copy available at legal@minio.example.com upon request.

## 10. California Residents: CCPA/CPRA Rights

Under the California Consumer Privacy Act (as amended by CPRA):

- **Right to Know:** What personal information we collect, use, and disclose
- **Right to Delete:** Request deletion of personal information
- **Right to Correct:** Request correction of inaccurate personal information
- **Right to Opt-Out:** We do not sell personal information. No opt-out mechanism needed.
- **Right to Non-Discrimination:** We do not discriminate against users who exercise their rights

**Categories of PI collected:** Identifiers (email, name), commercial information (subscription tier), internet activity (usage logs), audio/video content (uploads).

**To exercise rights:** Use the in-app privacy center at Settings > Privacy, or email privacy@minio.example.com. We verify identity before processing requests.

## 11. Children's Privacy

MiniOp is not directed at children under 16 (or 13 in the US). We do not knowingly collect data from children. If we discover we have collected a child's data, we will delete it within 48 hours. Contact safety@minio.example.com to report.

## 12. Changes to This Policy

We will notify you of material changes 30 days before they take effect via email and an in-app banner. The "Last Updated" date at the top reflects the most recent revision. Previous versions are available at minio.example.com/privacy/archive.

## 13. Contact

| Inquiry | Contact |
|---|---|
| Privacy questions | privacy@minio.example.com |
| Data subject requests | dpo@minio.example.com |
| Security issues | security@minio.example.com |
| General support | support@minio.example.com |
| Mailing address | MiniOp Inc., [Registered Address], Delaware, USA |
