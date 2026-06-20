# MiniOp Feedback Collection

## Overview

MiniOp's feedback collection system captures user sentiment, bug reports, feature requests, and behavioral signals across the entire product lifecycle. It operates at two levels: in-app feedback widgets for explicit feedback, and event pipelines for implicit behavioral feedback. The system adapts based on tier — free users get lightweight prompts, scaled production deployments get full feedback infrastructure with aggregation, triage, and integration into product workflows.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Feedback Widget │     │  Event Pipeline   │     │  API Endpoints  │
│  (In-App UI)     │────▶│  (Kafka/Redis)    │────▶│  (REST/GraphQL) │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                              │        │
                    ┌─────────┘        └─────────┐
              ┌─────▼─────┐              ┌──────▼──────┐
              │  Feedback  │              │  Analytics   │
              │  Store     │              │  & Triage    │
              │ (Postgres) │              │  (OLAP)      │
              └───────────┘              └─────────────┘
```

## Feedback Types

MiniOp collects four categories of feedback:

| Category | Method | Trigger | Storage |
|----------|--------|---------|---------|
| NPS/CSAT | In-app prompt | Periodic / post-action | `feedback_surveys` |
| Bug Report | Widget / API | User-initiated | `feedback_tickets` |
| Feature Request | Widget / API | User-initiated | `feature_requests` |
| Behavioral | Event pipeline | Automatic | `user_events` (OLAP) |

## Free Tier Implementation

### Feedback Widget

The feedback widget is a lightweight React component rendered as a floating action button. It expands into a form with contextual fields:

```tsx
// frontend/src/components/Feedback/FeedbackWidget.tsx
import React, { useState } from 'react';

interface FeedbackPayload {
  type: 'bug' | 'feature' | 'general';
  message: string;
  rating?: number;
  page: string;
  user_agent: string;
  screenshot?: string;  // base64
}

export const FeedbackWidget: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [feedbackType, setFeedbackType] = useState<FeedbackPayload['type']>('general');
  const [message, setMessage] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const captureContext = (): Partial<FeedbackPayload> => ({
    page: window.location.pathname,
    user_agent: navigator.userAgent,
  });

  const captureScreenshot = async (): Promise<string | undefined> => {
    try {
      const canvas = await import('html2canvas').then(m => m.default(document.body));
      return canvas.toDataURL('image/png').split(',')[1];
    } catch {
      return undefined;
    }
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    const screenshot = feedbackType === 'bug' ? await captureScreenshot() : undefined;

    const payload: FeedbackPayload = {
      type: feedbackType,
      message,
      rating: rating ?? undefined,
      ...captureContext(),
      screenshot,
    };

    await fetch('/api/v1/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    setIsSubmitting(false);
    setIsOpen(false);
    setMessage('');
    setRating(null);
  };

  return (
    <div className="feedback-widget">
      {!isOpen && (
        <button className="feedback-fab" onClick={() => setIsOpen(true)}>
          Feedback
        </button>
      )}
      {isOpen && (
        <div className="feedback-panel">
          <h3>Send Feedback</h3>
          <div className="feedback-type-selector">
            {(['bug', 'feature', 'general'] as const).map(type => (
              <button
                key={type}
                className={feedbackType === type ? 'active' : ''}
                onClick={() => setFeedbackType(type)}
              >
                {type === 'bug' ? 'Bug Report' : type === 'feature' ? 'Feature Request' : 'General'}
              </button>
            ))}
          </div>
          {feedbackType !== 'bug' && (
            <div className="rating-selector">
              {[1, 2, 3, 4, 5].map(score => (
                <button
                  key={score}
                  className={rating === score ? 'active' : ''}
                  onClick={() => setRating(score)}
                >
                  {score}
                </button>
              ))}
            </div>
          )}
          <textarea
            value={message}
            onChange={e => setMessage(e.target.value)}
            placeholder={
              feedbackType === 'bug'
                ? 'Describe the bug and steps to reproduce...'
                : feedbackType === 'feature'
                ? 'Describe the feature you\'d like...'
                : 'Tell us what you think...'
            }
            rows={5}
          />
          <div className="feedback-actions">
            <button onClick={() => setIsOpen(false)}>Cancel</button>
            <button onClick={handleSubmit} disabled={!message.trim() || isSubmitting}>
              {isSubmitting ? 'Sending...' : 'Send Feedback'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
```

### Backend Feedback API

The feedback endpoint stores submissions and triggers notifications:

```python
# services/feedback/api.py
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Optional
from datetime import datetime

router = APIRouter(prefix="/api/v1/feedback")

class FeedbackRequest(BaseModel):
    type: str  # "bug", "feature", "general"
    message: str
    rating: Optional[int] = None
    page: Optional[str] = None
    user_agent: Optional[str] = None
    screenshot: Optional[str] = None

class FeedbackResponse(BaseModel):
    id: str
    status: str
    created_at: datetime

@router.post("", response_model=FeedbackResponse)
async def submit_feedback(
    request: FeedbackRequest,
    user=Depends(get_current_user),
    db=Depends(get_db),
):
    feedback_id = await db.fetchval("""
        INSERT INTO feedback_tickets (user_id, type, message, rating, page, user_agent, screenshot_url, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', NOW())
        RETURNING id
    """, user.id, request.type, request.message, request.rating, request.page, request.user_agent, None)

    if request.screenshot:
        screenshot_url = await upload_screenshot(request.screenshot, feedback_id)
        await db.execute(
            "UPDATE feedback_tickets SET screenshot_url = $1 WHERE id = $2",
            screenshot_url, feedback_id
        )

    if request.type == "bug":
        await notify_team_slack(feedback_id, request.message, user.email)

    return FeedbackResponse(id=str(feedback_id), status="open", created_at=datetime.utcnow())
```

### Database Schema

```sql
CREATE TABLE feedback_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    type VARCHAR(20) NOT NULL CHECK (type IN ('bug', 'feature', 'general')),
    message TEXT NOT NULL,
    rating INT CHECK (rating BETWEEN 1 AND 5),
    page VARCHAR(500),
    user_agent TEXT,
    screenshot_url TEXT,
    status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'in_progress', 'resolved', 'closed')),
    priority VARCHAR(10) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    assigned_to UUID REFERENCES users(id),
    resolution_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_feedback_user ON feedback_tickets(user_id, created_at DESC);
CREATE INDEX idx_feedback_status ON feedback_tickets(status, priority);
CREATE INDEX idx_feedback_type ON feedback_tickets(type, created_at DESC);

CREATE TABLE feedback_surveys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    survey_type VARCHAR(20) NOT NULL CHECK (survey_type IN ('nps', 'csat', 'custom')),
    score INT NOT NULL,
    comment TEXT,
    context JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_surveys_type ON feedback_surveys(survey_type, created_at DESC);
```

## Scaled Production Implementation

### Event Pipeline with Kafka

In scaled production, all feedback events flow through Kafka for reliable processing and downstream integration:

```python
# services/feedback/events.py
from aiokafka import AIOKafkaProducer
import json
from datetime import datetime

class FeedbackEventProducer:
    def __init__(self, bootstrap_servers: str):
        self.producer = AIOKafkaProducer(
            bootstrap_servers=bootstrap_servers,
            value_serializer=lambda v: json.dumps(v).encode(),
        )

    async def start(self):
        await self.producer.start()

    async def stop(self):
        await self.producer.stop()

    async def emit_feedback_submitted(self, feedback: dict):
        await self.producer.send_and_wait("feedback.submitted", {
            "event_type": "feedback_submitted",
            "feedback_id": feedback["id"],
            "user_id": feedback["user_id"],
            "type": feedback["type"],
            "rating": feedback.get("rating"),
            "timestamp": datetime.utcnow().isoformat(),
        })

    async def emit_survey_response(self, survey: dict):
        await self.producer.send_and_wait("feedback.survey", {
            "event_type": "survey_response",
            "survey_id": survey["id"],
            "user_id": survey["user_id"],
            "survey_type": survey["survey_type"],
            "score": survey["score"],
            "timestamp": datetime.utcnow().isoformat(),
        })
```

### Kafka Consumer for Triage

A consumer processes incoming feedback and auto-triages based on content analysis:

```python
# services/feedback/triage.py
from aiokafka import AIOKafkaConsumer
import json
import re

class FeedbackTriageConsumer:
    def __init__(self, bootstrap_servers: str, db_pool, slack_client):
        self.consumer = AIOKafkaConsumer(
            "feedback.submitted",
            bootstrap_servers=bootstrap_servers,
            group_id="feedback-triage",
            value_deserializer=lambda v: json.loads(v),
        )
        self.db = db_pool
        self.slack = slack_client

    async def start(self):
        await self.consumer.start()
        async for msg in self.consumer:
            await self.process_feedback(msg.value)

    async def process_feedback(self, event: dict):
        feedback = await self.db.fetchrow(
            "SELECT * FROM feedback_tickets WHERE id = $1", event["feedback_id"]
        )
        if not feedback:
            return

        priority = self._assess_priority(feedback["message"], feedback["type"])
        await self.db.execute(
            "UPDATE feedback_tickets SET priority = $1, updated_at = NOW() WHERE id = $2",
            priority, feedback["id"]
        )

        if priority in ("high", "critical"):
            await self._escalate(feedback, priority)

    def _assess_priority(self, message: str, feedback_type: str) -> str:
        critical_keywords = ["crash", "data loss", "security", "payment", "billing"]
        high_keywords = ["broken", "not working", "error", "timeout", "slow"]

        lower_msg = message.lower()
        if any(kw in lower_msg for kw in critical_keywords):
            return "critical"
        if feedback_type == "bug" and any(kw in lower_msg for kw in high_keywords):
            return "high"
        if feedback_type == "feature":
            return "low"
        return "medium"

    async def _escalate(self, feedback: dict, priority: str):
        await self.slack.post_message(
            channel="#feedback-alerts",
            text=f":rotating_light: {priority.upper()} feedback from {feedback['user_id']}: {feedback['message'][:200]}"
        )
```

### NPS Survey System

Automated NPS surveys trigger based on user activity patterns:

```python
# services/feedback/nps.py
from datetime import datetime, timedelta

class NPSSurveyScheduler:
    def __init__(self, db_pool, email_client):
        self.db = db_pool
        self.email = email_client

    async def get_eligible_users(self) -> list[dict]:
        """Users who haven't been surveyed in 90 days and have >= 5 sessions."""
        return await self.db.fetch("""
            SELECT u.id, u.email, u.name
            FROM users u
            WHERE u.created_at <= NOW() - INTERVAL '14 days'
            AND NOT EXISTS (
                SELECT 1 FROM feedback_surveys fs
                WHERE fs.user_id = u.id
                AND fs.survey_type = 'nps'
                AND fs.created_at >= NOW() - INTERVAL '90 days'
            )
            AND (
                SELECT COUNT(*) FROM user_sessions us
                WHERE us.user_id = u.id
                AND us.created_at >= NOW() - INTERVAL '30 days'
            ) >= 5
            LIMIT 100
        """)

    async def send_nps_survey(self, user: dict):
        token = self._generate_survey_token(user["id"])
        survey_url = f"https://app.minioop.com/survey/nps?token={token}"
        await self.email.send(
            to=user["email"],
            template="nps-survey",
            context={"name": user["name"], "survey_url": survey_url}
        )

    async def record_response(self, user_id: str, score: int, comment: str = None):
        await self.db.execute("""
            INSERT INTO feedback_surveys (user_id, survey_type, score, comment, created_at)
            VALUES ($1, 'nps', $2, $3, NOW())
        """, user_id, score, comment)
```

### Analytics Queries

NPS calculation:

```sql
-- NPS score calculation
WITH nps_buckets AS (
    SELECT
        CASE
            WHEN score >= 9 THEN 'promoter'
            WHEN score >= 7 THEN 'passive'
            ELSE 'detractor'
        END as bucket,
        COUNT(*) as count
    FROM feedback_surveys
    WHERE survey_type = 'nps'
    AND created_at >= NOW() - INTERVAL '30 DAY'
    GROUP BY bucket
)
SELECT
    ROUND(
        (100.0 * MAX(CASE WHEN bucket = 'promoter' THEN count ELSE 0 END) -
         100.0 * MAX(CASE WHEN bucket = 'detractor' THEN count ELSE 0 END)) /
        SUM(count),
        1
    ) as nps_score
FROM nps_buckets;
```

Feedback volume and trends:

```sql
-- Weekly feedback trends
SELECT
    DATE_TRUNC('week', created_at) as week,
    type,
    COUNT(*) as count,
    AVG(rating) as avg_rating,
    COUNT(*) FILTER (WHERE status = 'resolved') as resolved,
    COUNT(*) FILTER (WHERE priority IN ('high', 'critical')) as high_priority
FROM feedback_tickets
WHERE created_at >= NOW() - INTERVAL '90 DAY'
GROUP BY week, type
ORDER BY week DESC, type;
```

### Integration with External Tools

Scaled production integrates feedback with project management tools:

```python
# services/feedback/integrations.py
import httpx

class JiraIntegration:
    def __init__(self, base_url: str, email: str, api_token: str):
        self.client = httpx.AsyncClient(
            base_url=base_url,
            auth=(email, api_token),
        )

    async def create_issue(self, feedback: dict) -> str:
        issue = await self.client.post("/rest/api/3/issue", json={
            "fields": {
                "project": {"key": "MINIOP"},
                "issuetype": {"name": "Bug" if feedback["type"] == "bug" else "Task"},
                "summary": f"[Feedback] {feedback['message'][:80]}",
                "description": {
                    "type": "doc",
                    "content": [{"type": "paragraph", "content": [
                        {"type": "text", "text": feedback["message"]}
                    ]}]
                },
                "labels": ["user-feedback", feedback["type"]],
                "priority": {"name": self._map_priority(feedback["priority"])},
            }
        })
        return issue.json()["key"]

    def _map_priority(self, priority: str) -> str:
        return {"critical": "Highest", "high": "High", "medium": "Medium", "low": "Low"}.get(priority, "Medium")


class LinearIntegration:
    def __init__(self, api_key: str):
        self.client = httpx.AsyncClient(
            base_url="https://api.linear.app/graphql",
            headers={"Authorization": api_key},
        )

    async def create_issue(self, feedback: dict, team_id: str) -> str:
        mutation = """
            mutation IssueCreate($input: IssueCreateInput!) {
                issueCreate(input: $input) { issue { id identifier url } }
            }
        """
        result = await self.client.post("", json={
            "query": mutation,
            "variables": {
                "input": {
                    "teamId": team_id,
                    "title": f"[Feedback] {feedback['message'][:80]}",
                    "description": feedback["message"],
                    "priority": self._map_priority(feedback["priority"]),
                    "labelIds": [],  # Add feedback label ID
                }
            }
        })
        return result.json()["data"]["issueCreate"]["issue"]["identifier"]
```

## Feedback Prompting Strategy

Feedback prompts are triggered at strategic moments, not randomly:

```python
# services/feedback/prompts.py
class FeedbackPromptTriggers:
    TRIGGERS = {
        "post_export": {
            "delay_seconds": 5,
            "type": "csat",
            "message": "How was your export experience?",
            "cooldown_days": 30,
        },
        "post_tutorial_complete": {
            "delay_seconds": 3,
            "type": "csat",
            "message": "Was this tutorial helpful?",
            "cooldown_days": 14,
        },
        "error_recovery": {
            "delay_seconds": 10,
            "type": "bug_report",
            "message": "Looks like something went wrong. Want to report it?",
            "cooldown_days": 7,
        },
        "milestone_reached": {
            "delay_seconds": 2,
            "type": "nps",
            "message": "You've generated 10 clips! How likely are you to recommend MiniOp?",
            "cooldown_days": 90,
        },
    }

    def should_prompt(self, user_id: str, trigger: str, db) -> bool:
        config = self.TRIGGERS.get(trigger)
        if not config:
            return False

        last_prompt = db.fetchval("""
            SELECT created_at FROM feedback_prompts
            WHERE user_id = $1 AND trigger = $2
            ORDER BY created_at DESC LIMIT 1
        """, user_id, trigger)

        if last_prompt:
            days_since = (datetime.utcnow() - last_prompt).days
            if days_since < config["cooldown_days"]:
                return False

        return True
```

## Configuration

```env
FEEDBACK_ENABLED=true
FEEDBACK_WIDGET_ENABLED=true
FEEDBACK_SCREENSHOT_ENABLED=true
FEEDBACK_KAFKA_SERVERS=kafka1:9092,kafka2:9092
FEEDBACK_SLACK_WEBHOOK=https://hooks.slack.com/services/xxx
FEEDBACK_JIRA_ENABLED=false
FEEDBACK_JIRA_BASE_URL=https://yourteam.atlassian.net
FEEDBACK_LINEAR_ENABLED=false
FEEDBACK_NPS_SURVEY_ENABLED=true
FEEDBACK_NPS_BATCH_SIZE=100
FEEDBACK_AUTO_TRIAGE_ENABLED=true
FEEDBACK_PROMPTS_ENABLED=true
```

## Testing

```bash
# Unit tests
pytest tests/feedback/test_api.py -v
pytest tests/feedback/test_triage.py -v

# Integration tests with Kafka
pytest tests/feedback/test_events.py -v --kafka

# Widget E2E tests
npx playwright test tests/e2e/feedback-widget.spec.ts

# Load test feedback endpoints
k6 run tests/load/feedback.js
```

## Feedback Dashboard

Query the feedback dashboard data:

```python
# services/feedback/dashboard.py
async def get_dashboard_stats(db, days: int = 30) -> dict:
    return {
        "total_feedback": await db.fetchval(
            "SELECT COUNT(*) FROM feedback_tickets WHERE created_at >= NOW() - INTERVAL '%s days'" % days
        ),
        "by_type": await db.fetch("""
            SELECT type, COUNT(*) as count FROM feedback_tickets
            WHERE created_at >= NOW() - INTERVAL '%s days' GROUP BY type
        """ % days),
        "avg_resolution_hours": await db.fetchval("""
            SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600)
            FROM feedback_tickets WHERE resolved_at IS NOT NULL
            AND created_at >= NOW() - INTERVAL '%s days'
        """ % days),
        "nps_score": await db.fetchval("""
            SELECT ROUND(
                (100.0 * COUNT(*) FILTER (WHERE score >= 9) -
                 100.0 * COUNT(*) FILTER (WHERE score <= 6)) / COUNT(*), 1
            )
            FROM feedback_surveys WHERE survey_type = 'nps'
            AND created_at >= NOW() - INTERVAL '%s days'
        """ % days),
        "open_tickets": await db.fetchval(
            "SELECT COUNT(*) FROM feedback_tickets WHERE status IN ('open', 'triaged')"
        ),
    }
```
