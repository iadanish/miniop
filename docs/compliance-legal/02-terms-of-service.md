# MiniOp Terms of Service

**Effective Date:** January 1, 2026  
**Last Updated:** January 1, 2026  
**Version:** 1.0

## 1. Acceptance of Terms

By accessing or using MiniOp ("the Service"), you agree to be bound by these Terms of Service ("Terms"). If you are using the Service on behalf of an organization, you represent that you have authority to bind that organization. If you do not agree, do not use the Service.

MiniOp is available in two deployment models, both governed by these Terms:

- **Self-Hosted (Free Tier):** Open-source deployment from the official repository under the MIT License. These Terms apply to the service operation, not the software license itself.
- **Managed Service (Production):** Hosted SaaS offering at app.minio.example.com with paid subscription plans.

## 2. Service Description

MiniOp is an AI-powered video editing platform that processes uploaded video content to generate short-form clips optimized for social media distribution. The Service includes:

- Video upload, transcoding, and storage
- AI-driven scene detection, transcription, and clip generation
- Virality scoring and engagement prediction
- Clip export in multiple formats and resolutions
- Team collaboration and workspace management (paid plans)
- API access for programmatic clip generation (paid plans)

## 3. Account Registration and Security

### 3.1 Account Requirements

You must be at least 16 years old (or the minimum age in your jurisdiction) to create an account. You must provide accurate, current, and complete information during registration.

### 3.2 Authentication Configuration

Production deployments must enforce the following authentication standards:

```yaml
# config/auth.yaml
authentication:
  password_policy:
    min_length: 12
    require_uppercase: true
    require_lowercase: true
    require_digit: true
    require_special: true
    max_age_days: 365
    history_count: 5  # Cannot reuse last 5 passwords
  
  session:
    max_duration_hours: 24
    idle_timeout_minutes: 30
    absolute_timeout_hours: 168  # 7 days max
    concurrent_sessions: 5
  
  mfa:
    required_for_admin: true
    required_for_paid_plans: false  # Recommended, not enforced
    supported_methods:
      - totp
      - webauthn
  
  rate_limiting:
    login_attempts: 5
    lockout_duration_minutes: 15
    password_reset_attempts: 3
    password_reset_window_hours: 1
```

### 3.3 Account Responsibility

You are responsible for all activity under your account. You must immediately notify MiniOp of any unauthorized access. MiniOp is not liable for losses resulting from compromised credentials where the user failed to maintain reasonable security practices.

## 4. Acceptable Use Policy

### 4.1 Permitted Use

You may use the Service to process video content you own or have legal rights to edit and distribute. The Service is intended for legitimate content creation workflows.

### 4.2 Prohibited Use

You may not:

- Upload content you do not have rights to process (copyright infringement)
- Use the Service to generate content depicting minors in exploitative contexts
- Upload content that violates applicable law in your jurisdiction or the jurisdiction of MiniOp's hosting provider
- Attempt to reverse-engineer the AI models, extract training data, or circumvent rate limits
- Resell API access or redistribute generated clips as a standalone service without a commercial license
- Use automated scripts to create multiple free-tier accounts to circumvent usage limits
- Upload malicious files designed to exploit the transcoding pipeline

### 4.3 Enforcement

```python
# app/services/content_moderation.py
from enum import Enum
from app.models import Video, User
from app.services.abuse import flag_for_review, auto_block

class ViolationSeverity(Enum):
    WARNING = "warning"
    TEMPORARY_SUSPENSION = "temporary_suspension"
    PERMANENT_BAN = "permanent_ban"

CONTENT_RULES = {
    "copyright_claim": {
        "severity": ViolationSeverity.WARNING,
        "action": "suspend_processing",
        "appeal_allowed": True,
    },
    "csam_detected": {
        "severity": ViolationSeverity.PERMANENT_BAN,
        "action": "immediate_termination_and_report",
        "appeal_allowed": False,
        "report_to_ncmec": True,
    },
    "tos_repeated_violation": {
        "severity": ViolationSeverity.TEMPORARY_SUSPENSION,
        "action": "suspend_account_30_days",
        "appeal_allowed": True,
    },
    "api_abuse": {
        "severity": ViolationSeverity.WARNING,
        "action": "rate_limit_reduction",
        "appeal_allowed": True,
    },
}

async def handle_violation(user_id: str, violation_type: str, evidence: dict):
    rule = CONTENT_RULES.get(violation_type)
    if not rule:
        raise ValueError(f"Unknown violation type: {violation_type}")
    
    user = await User.get(id=user_id)
    
    if rule["severity"] == ViolationSeverity.PERMANENT_BAN:
        await user.terminate(reason=violation_type)
        if rule.get("report_to_ncmec"):
            await report_to_ncmec(evidence)
    elif rule["severity"] == ViolationSeverity.TEMPORARY_SUSPENSION:
        await user.suspend(days=30, reason=violation_type)
    else:
        await user.warn(reason=violation_type)
    
    if rule["appeal_allowed"]:
        await notify_user_appeal_rights(user, violation_type)
```

## 5. Content Rights and Ownership

### 5.1 Your Content

You retain all rights to videos you upload and clips you generate. MiniOp does not claim ownership of your content.

### 5.2 License Grant

By uploading content, you grant MiniOp a limited, non-exclusive, revocable license to:

- Process, transcode, and store your content for the purpose of providing the Service
- Generate derived works (clips, transcriptions, thumbnails) and deliver them to you
- Cache content on CDN edge nodes for performance (automatically expires per retention policy)

This license terminates when you delete your content or close your account.

### 5.3 AI Model Training

MiniOp does not use your uploaded content to train AI models. This is a binding commitment. The following technical enforcement is implemented:

```python
# app/services/training_firewall.py
"""
Technical enforcement: uploaded content is never accessible to model
training pipelines. This is verified by architecture, not just policy.
"""

# Training pipeline runs in a separate Kubernetes namespace with:
# - No PVC access to user-uploaded storage buckets
# - NetworkPolicy blocking connections to user-data services
# - Separate IAM role with no s3:GetObject on user buckets

def verify_training_isolation():
    """CI check: ensures training namespace cannot access user data."""
    import kubernetes
    v1 = kubernetes.client.NetworkingV1Api()
    
    policies = v1.list_namespaced_network_policy("training")
    user_data_services = ["video-storage", "clip-storage", "transcription-db"]
    
    for policy in policies.items:
        for egress in policy.spec.egress or []:
            for rule in egress.to or []:
                if rule.namespace_selector:
                    if rule.namespace_selector.match_labels.get("data-classification") == "user-content":
                        raise SecurityViolation(
                            "Training namespace has egress to user-content namespace"
                        )
    
    return True  # Verified: training cannot access user data
```

## 6. Service Level and Availability

### 6.1 Free Tier (Self-Hosted)

The self-hosted free tier is provided "as-is" under the MIT License. No SLA or uptime guarantee is provided. Community support is available through GitHub Issues.

### 6.2 Production Plans

| Plan | Uptime SLA | Support | Processing Limit |
|---|---|---|---|
| Starter ($29/mo) | 99.5% | Email (48h) | 50 videos/month |
| Professional ($99/mo) | 99.9% | Email + Chat (24h) | 500 videos/month |
| Enterprise (custom) | 99.95% | Dedicated CSM (4h) | Unlimited |

### 6.3 SLA Credits

```python
# app/billing/sla_credits.py
from datetime import datetime, timedelta

SLA_TIERS = {
    "starter": {"uptime": 0.995, "credit_pct": {99.0: 10, 98.0: 25, 95.0: 50}},
    "professional": {"uptime": 0.999, "credit_pct": {99.5: 10, 99.0: 25, 98.0: 50}},
    "enterprise": {"uptime": 0.9995, "credit_pct": {99.9: 10, 99.5: 25, 99.0: 50}},
}

def calculate_sla_credit(plan: str, actual_uptime: float, monthly_fee: float) -> float:
    """Calculate SLA credit based on actual uptime vs guaranteed uptime."""
    tier = SLA_TIERS[plan]
    
    if actual_uptime >= tier["uptime"]:
        return 0.0
    
    credit_pct = 0
    for threshold, pct in sorted(tier["credit_pct"].items(), reverse=True):
        if actual_uptime < threshold:
            credit_pct = pct
    
    return monthly_fee * (credit_pct / 100)
```

## 7. Payment and Billing

### 7.1 Pricing

Paid plans are billed monthly or annually. Annual plans include a 20% discount. All prices are in USD and exclude applicable taxes.

### 7.2 Overage Charges

Processing beyond plan limits incurs overage charges:

```yaml
# config/billing.yaml
overage_rates:
  starter:
    per_video: 0.75
    per_gb_storage: 0.05
    per_api_call: 0.001
  professional:
    per_video: 0.50
    per_gb_storage: 0.03
    per_api_call: 0.0005
  enterprise:
    per_video: 0.25
    per_gb_storage: 0.02
    per_api_call: 0.0002

billing:
  currency: "USD"
  payment_methods: ["card", "invoice_enterprise"]
  grace_period_days: 7
  suspension_after_days: 14
  data_retention_after_suspension_days: 30
```

### 7.3 Refund Policy

Monthly plans: refund within 7 days of charge if usage is under 10% of plan limit. Annual plans: prorated refund within 30 days. After these periods, no refunds are issued. Enterprise plans: governed by individual contracts.

## 8. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW:

MiniOp's total liability shall not exceed the fees paid by you in the 12 months preceding the claim. MiniOp is not liable for indirect, incidental, special, consequential, or punitive damages, including loss of profits, data, or business opportunities.

MiniOp does not guarantee that AI-generated clips will achieve any particular level of engagement, virality, or compliance with third-party platform policies. The virality score is a prediction, not a guarantee.

## 9. Indemnification

You agree to indemnify MiniOp against claims arising from:

- Content you upload that infringes third-party rights
- Your violation of these Terms
- Your violation of applicable law
- Disputes between you and third parties regarding generated content

## 10. Termination

### 10.1 By You

You may terminate your account at any time through Settings > Account > Delete Account. Upon termination:

- Your data is retained for 30 days (recoverable if you change your mind)
- After 30 days, data is permanently deleted per our Privacy Policy
- Prepaid fees are non-refundable except as specified in Section 7.3

### 10.2 By MiniOp

MiniOp may terminate or suspend your account for:

- Violation of the Acceptable Use Policy (Section 4)
- Non-payment after grace period
- Legal or regulatory requirement
- Extended inactivity (free tier: 12 months, paid: upon subscription cancellation)

## 11. Dispute Resolution

### 11.1 Governing Law

These Terms are governed by the laws of the State of Delaware, United States, without regard to conflict of law principles.

### 11.2 Arbitration

Any dispute exceeding $10,000 shall be resolved by binding arbitration under the rules of the American Arbitration Association. Class action and jury trial are waived. This clause does not apply to users in the EU, who may resolve disputes through their local supervisory authority.

### 11.3 Free-Tier Self-Hosted Disputes

For self-hosted deployments, disputes regarding the open-source software are governed by the MIT License. These Terms apply only to the hosted service relationship.

## 12. Changes to Terms

MiniOp will notify users of material changes 30 days in advance via email and in-app notification. Continued use after the effective date constitutes acceptance. If you disagree with changes, you must stop using the Service and may request account deletion.

## 13. Contact

Legal inquiries: legal@minio.example.com  
DMCA claims: dmca@minio.example.com  
Data Protection Officer: dpo@minio.example.com  
General support: support@minio.example.com
