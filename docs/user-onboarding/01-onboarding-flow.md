# MiniOp Onboarding Flow

## Overview

MiniOp's onboarding flow transforms new signups into active users who understand the core value proposition: turning long-form video into short, viral clips. The flow is implemented across the `UserOnboarding` service and the frontend `onboarding/` module. It adapts based on tier (free vs. scaled production) while maintaining a single codebase.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Auth Layer  │────▶│ OnboardingService │────▶│  User Profile   │
│ (OAuth/Email)│     │   (State Machine) │     │  (Preferences)  │
└─────────────┘     └──────────────────┘     └─────────────────┘
                           │        │
                    ┌──────┘        └──────┐
              ┌─────▼─────┐        ┌──────▼──────┐
              │  Tutorial  │        │  Analytics   │
              │  Trigger   │        │  Pipeline    │
              └───────────┘        └─────────────┘
```

The onboarding flow is a finite state machine with defined transitions. Each step is idempotent — if a user drops off and returns, they resume at the last incomplete step.

## Free Tier Implementation

### Step 1: Registration and Profile Setup

The entry point is `POST /api/v1/onboarding/start`. For free tier, this creates a user with default limits:

```json
// POST /api/v1/auth/register
{
  "email": "user@example.com",
  "password": "securepass123",
  "source": "organic"
}
```

After registration, the onboarding state machine initializes:

```python
# services/onboarding/states.py
from enum import Enum

class OnboardingStep(str, Enum):
    REGISTERED = "registered"
    PROFILE_COMPLETE = "profile_complete"
    FIRST_UPLOAD = "first_upload"
    FIRST_CLIP_GENERATED = "first_clip_generated"
    TUTORIAL_COMPLETED = "tutorial_completed"
    ACTIVE = "active"

class OnboardingStateMachine:
    def __init__(self, user_id: str, tier: str = "free"):
        self.user_id = user_id
        self.tier = tier
        self.current_step = OnboardingStep.REGISTERED

    def advance(self, target_step: OnboardingStep) -> bool:
        allowed_transitions = {
            OnboardingStep.REGISTERED: [OnboardingStep.PROFILE_COMPLETE],
            OnboardingStep.PROFILE_COMPLETE: [OnboardingStep.FIRST_UPLOAD],
            OnboardingStep.FIRST_UPLOAD: [OnboardingStep.FIRST_CLIP_GENERATED],
            OnboardingStep.FIRST_CLIP_GENERATED: [OnboardingStep.TUTORIAL_COMPLETED],
            OnboardingStep.TUTORIAL_COMPLETED: [OnboardingStep.ACTIVE],
        }
        if target_step in allowed_transitions.get(self.current_step, []):
            self.current_step = target_step
            self._persist()
            return True
        return False
```

### Step 2: Profile Collection

Collect minimal data for free tier — role and primary use case. This drives content recommendations later:

```json
// PUT /api/v1/onboarding/profile
{
  "role": "content_creator",
  "use_case": "youtube_shorts",
  "content_type": "talking_head",
  "experience_level": "beginner"
}
```

The backend stores this in the `user_profiles` table:

```sql
CREATE TABLE user_profiles (
    user_id UUID PRIMARY KEY REFERENCES users(id),
    role VARCHAR(50) NOT NULL,
    use_case VARCHAR(100),
    content_type VARCHAR(100),
    experience_level VARCHAR(20) DEFAULT 'beginner',
    onboarding_step VARCHAR(50) DEFAULT 'registered',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Step 3: First Upload Prompt

After profile completion, the frontend redirects to `/upload?onboarding=true`. Free tier limits are enforced immediately so users understand constraints upfront:

```python
# services/upload/limits.py
FREE_TIER_LIMITS = {
    "max_duration_seconds": 3600,       # 1 hour max input
    "max_file_size_mb": 500,
    "max_clips_per_video": 10,
    "max_concurrent_jobs": 1,
    "supported_formats": ["mp4", "mov", "webm"],
    "resolution_cap": "1080p",
}

SCALED_TIER_LIMITS = {
    "max_duration_seconds": 14400,      # 4 hours
    "max_file_size_mb": 5000,
    "max_clips_per_video": 50,
    "max_concurrent_jobs": 10,
    "supported_formats": ["mp4", "mov", "webm", "mkv", "avi"],
    "resolution_cap": "4k",
}
```

## Scaled Production Implementation

### Multi-Tenant Onboarding

In scaled deployments, onboarding runs as a dedicated microservice with its own database and Redis state cache. The service handles concurrent onboarding sessions and integrates with enterprise SSO:

```yaml
# deploy/onboarding-service.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: onboarding-service
spec:
  replicas: 3
  selector:
    matchLabels:
      app: onboarding-service
  template:
    spec:
      containers:
        - name: onboarding
          image: minio/opencut-onboarding:latest
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: onboarding-secrets
                  key: database-url
            - name: REDIS_URL
              value: "redis://redis-cluster:6379/2"
            - name: FEATURE_FLAGS_URL
              value: "http://feature-flags:8080"
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"
```

### Enterprise SSO Integration

Scaled production supports SAML and OIDC flows. The onboarding service delegates authentication but retains control of the onboarding state:

```python
# services/onboarding/sso.py
class SSOOnboardingAdapter:
    def __init__(self, provider: str):
        self.provider = provider

    def extract_profile_from_claims(self, claims: dict) -> dict:
        """Map SSO claims to MiniOp profile fields."""
        return {
            "email": claims.get("email"),
            "name": claims.get("name"),
            "role": self._infer_role(claims),
            "organization_id": claims.get("org_id"),
            "team_id": claims.get("team_id"),
        }

    def _infer_role(self, claims: dict) -> str:
        groups = claims.get("groups", [])
        if "video-editors" in groups:
            return "editor"
        if "content-managers" in groups:
            return "content_manager"
        return "viewer"
```

### Onboarding Analytics Pipeline

Scaled production tracks every onboarding event for funnel analysis:

```python
# services/onboarding/analytics.py
import httpx
from datetime import datetime

class OnboardingAnalytics:
    def __init__(self, analytics_url: str):
        self.client = httpx.AsyncClient(base_url=analytics_url)

    async def track_step(self, user_id: str, step: str, metadata: dict = None):
        await self.client.post("/events", json={
            "event": "onboarding_step",
            "user_id": user_id,
            "step": step,
            "timestamp": datetime.utcnow().isoformat(),
            "metadata": metadata or {},
        })

    async def track_dropoff(self, user_id: str, step: str, reason: str = None):
        await self.client.post("/events", json={
            "event": "onboarding_dropoff",
            "user_id": user_id,
            "step": step,
            "reason": reason,
            "timestamp": datetime.utcnow().isoformat(),
        })
```

Funnel metrics are queried from ClickHouse or a similar OLAP store:

```sql
SELECT
    step,
    COUNT(DISTINCT user_id) as users,
    COUNT(DISTINCT user_id) * 100.0 / FIRST_VALUE(COUNT(DISTINCT user_id)) OVER (ORDER BY step_order) as conversion_pct
FROM onboarding_events
WHERE created_at >= NOW() - INTERVAL 30 DAY
GROUP BY step, step_order
ORDER BY step_order;
```

## Onboarding Resumption

Users who drop off receive an email after 24 hours with a deep link back to their exact step. The link includes a signed token:

```python
# services/onboarding/resume.py
from itsdangerous import URLSafeTimedSerializer

def generate_resume_link(user_id: str, step: str, secret: str) -> str:
    serializer = URLSafeTimedSerializer(secret)
    token = serializer.dumps({"user_id": user_id, "step": step})
    return f"https://app.minioop.com/onboarding/resume?token={token}"

def verify_resume_token(token: str, secret: str, max_age: int = 604800) -> dict:
    serializer = URLSafeTimedSerializer(secret)
    return serializer.loads(token, max_age=max_age)  # 7 day expiry
```

## Configuration

Environment variables for the onboarding service:

```env
ONBOARDING_ENABLED=true
ONBOARDING_SKIP_FOR_SSO=false
ONBOARDING_PROFILE_REQUIRED=true
ONBOARDING_TUTORIAL_AUTO_TRIGGER=true
ONBOARDING_RESUME_EMAIL_DELAY_HOURS=24
ONBOARDING_ANALYTICS_ENABLED=true
ONBOARDING_MAX_STEPS=5
```

Feature flags for gradual rollout:

```python
# config/feature_flags.py
ONBOARDING_FLAGS = {
    "onboarding_v2_flow": False,          # New step sequence
    "onboarding_skip_profile": False,     # Allow skipping profile
    "onboarding_ai_suggestions": True,    # AI-powered use case suggestions
    "onboarding_team_invite": False,      # Team onboarding flow
}
```

## Testing the Onboarding Flow

Run the onboarding integration tests:

```bash
# Unit tests
pytest tests/onboarding/test_state_machine.py -v

# Integration test with full flow
pytest tests/onboarding/test_full_flow.py -v --env=test

# Load test (scaled production)
locust -f tests/load/onboarding_load.py --host=https://staging.minioop.com
```

Seed test data for development:

```bash
python scripts/seed_onboarding.py --users=100 --tier=mixed
```

## Next Steps

After onboarding completes, users enter the tutorial system (`02-tutorial-system.md`). The `OnboardingService` emits an `onboarding_complete` event that the tutorial service consumes to trigger contextual tutorials based on the user's profile and first upload.
