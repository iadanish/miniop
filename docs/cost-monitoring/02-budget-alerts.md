# Budget Alerts

Unchecked cloud spending is the fastest way to kill an open-source project's sustainability. A single misconfigured batch job or a user uploading 500 videos can rack up thousands in API bills before anyone notices. This document covers how to implement budget alerts for MiniOp — from simple local scripts to production-grade multi-channel alerting with automatic cost controls.

## Free Tier: Script-Based Monitoring

For small deployments, a Python script that checks costs against thresholds and sends notifications is sufficient.

### Core Alert Engine

```python
# minio/alerts/engine.py
import sqlite3
import json
import smtplib
import requests
from email.mime.text import MIMEText
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum

class AlertSeverity(Enum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"

@dataclass
class BudgetRule:
    name: str
    scope: str            # 'global', 'user', 'service'
    scope_id: str | None  # user_id or service name, None for global
    period: str           # 'daily', 'weekly', 'monthly'
    thresholds: dict      # {"warning": 10.0, "critical": 50.0}
    enabled: bool = True

class AlertEngine:
    def __init__(self, db_path: str = "minio_costs.db"):
        self.db_path = db_path
        self.rules: list[BudgetRule] = []
        self._load_rules()

    def _load_rules(self):
        """Load rules from config file."""
        try:
            with open("budget_rules.json") as f:
                data = json.load(f)
            self.rules = [BudgetRule(**r) for r in data["rules"]]
        except FileNotFoundError:
            # Default rules for free tier
            self.rules = [
                BudgetRule("global_daily", "global", None, "daily",
                           {"warning": 5.0, "critical": 10.0}),
                BudgetRule("global_monthly", "global", None, "monthly",
                           {"warning": 50.0, "critical": 100.0}),
            ]
            self._save_rules()

    def _save_rules(self):
        with open("budget_rules.json", "w") as f:
            json.dump({"rules": [r.__dict__ for r in self.rules]}, f, indent=2)

    def _get_period_start(self, period: str) -> str:
        now = datetime.utcnow()
        if period == "daily":
            return now.strftime("%Y-%m-%d")
        elif period == "weekly":
            start = now - timedelta(days=now.weekday())
            return start.strftime("%Y-%m-%d")
        elif period == "monthly":
            return now.strftime("%Y-%m-01")
        raise ValueError(f"Unknown period: {period}")

    def _query_cost(self, rule: BudgetRule) -> float:
        period_start = self._get_period_start(rule.period)
        conn = sqlite3.connect(self.db_path)
        try:
            if rule.scope == "global":
                row = conn.execute(
                    "SELECT COALESCE(SUM(total_cost), 0) FROM cost_events WHERE timestamp >= ?",
                    (period_start,)
                ).fetchone()
            elif rule.scope == "user":
                row = conn.execute(
                    "SELECT COALESCE(SUM(total_cost), 0) FROM cost_events WHERE user_id = ? AND timestamp >= ?",
                    (rule.scope_id, period_start)
                ).fetchone()
            elif rule.scope == "service":
                row = conn.execute(
                    "SELECT COALESCE(SUM(total_cost), 0) FROM cost_events WHERE service = ? AND timestamp >= ?",
                    (rule.scope_id, period_start)
                ).fetchone()
            else:
                return 0.0
            return row[0]
        finally:
            conn.close()

    def evaluate(self) -> list[dict]:
        """Evaluate all rules and return triggered alerts."""
        alerts = []
        for rule in self.rules:
            if not rule.enabled:
                continue
            current_cost = self._query_cost(rule)
            for severity_name, threshold in sorted(rule.thresholds.items(), key=lambda x: x[1]):
                if current_cost >= threshold:
                    alerts.append({
                        "rule": rule.name,
                        "scope": rule.scope,
                        "scope_id": rule.scope_id,
                        "period": rule.period,
                        "severity": severity_name,
                        "current_cost": round(current_cost, 4),
                        "threshold": threshold,
                        "utilization": round(current_cost / threshold * 100, 1),
                        "timestamp": datetime.utcnow().isoformat(),
                    })
        return alerts
```

### Budget Rules Configuration

```json
// budget_rules.json
{
  "rules": [
    {
      "name": "global_daily",
      "scope": "global",
      "scope_id": null,
      "period": "daily",
      "thresholds": {"warning": 5.0, "critical": 10.0},
      "enabled": true
    },
    {
      "name": "global_monthly",
      "scope": "global",
      "scope_id": null,
      "period": "monthly",
      "thresholds": {"warning": 50.0, "critical": 150.0},
      "enabled": true
    },
    {
      "name": "openai_daily",
      "scope": "service",
      "scope_id": "openai_whisper",
      "period": "daily",
      "thresholds": {"warning": 3.0, "critical": 8.0},
      "enabled": true
    },
    {
      "name": "openai_gpt4v_daily",
      "scope": "service",
      "scope_id": "openai_gpt4v",
      "period": "daily",
      "thresholds": {"warning": 5.0, "critical": 15.0},
      "enabled": true
    },
    {
      "name": "cloudflare_stream_daily",
      "scope": "service",
      "scope_id": "cloudflare_stream",
      "period": "daily",
      "thresholds": {"warning": 2.0, "critical": 5.0},
      "enabled": true
    },
    {
      "name": "per_user_daily",
      "scope": "user",
      "scope_id": "*",
      "period": "daily",
      "thresholds": {"warning": 1.0, "critical": 3.0},
      "enabled": true
    }
  ]
}
```

### Notification Channels

```python
# minio/alerts/notifiers.py
import smtplib
import requests
import json
from email.mime.text import MIMEText

class Notifier:
    def send(self, alert: dict):
        raise NotImplementedError

class ConsoleNotifier(Notifier):
    def send(self, alert: dict):
        icon = {"info": "ℹ", "warning": "⚠", "critical": "🚨"}.get(alert["severity"], "?")
        print(f"{icon} [{alert['severity'].upper()}] {alert['rule']}: "
              f"${alert['current_cost']:.2f} / ${alert['threshold']:.2f} "
              f"({alert['utilization']}% utilized)")

class WebhookNotifier(Notifier):
    def __init__(self, webhook_url: str):
        self.url = webhook_url

    def send(self, alert: dict):
        requests.post(self.url, json={
            "text": f"MiniOp Budget Alert [{alert['severity'].upper()}]: "
                    f"Rule '{alert['rule']}' at ${alert['current_cost']:.2f} "
                    f"({alert['utilization']}% of ${alert['threshold']:.2f} limit)"
        }, timeout=10)

class EmailNotifier(Notifier):
    def __init__(self, smtp_host: str, smtp_port: int, username: str, password: str, to: str):
        self.smtp_host = smtp_host
        self.smtp_port = smtp_port
        self.username = username
        self.password = password
        self.to = to

    def send(self, alert: dict):
        body = f"""MiniOp Budget Alert

Rule: {alert['rule']}
Severity: {alert['severity'].upper()}
Current Cost: ${alert['current_cost']:.4f}
Threshold: ${alert['threshold']:.2f}
Utilization: {alert['utilization']}%
Period: {alert['period']}
Scope: {alert['scope']} ({alert.get('scope_id', 'all')})
Time: {alert['timestamp']}
"""
        msg = MIMEText(body)
        msg["Subject"] = f"[MiniOp] Budget {alert['severity'].upper()}: {alert['rule']}"
        msg["From"] = self.username
        msg["To"] = self.to

        with smtplib.SMTP(self.smtp_host, self.smtp_port) as server:
            server.starttls()
            server.login(self.username, self.password)
            server.send_message(msg)

class SlackNotifier(Notifier):
    def __init__(self, webhook_url: str):
        self.url = webhook_url

    def send(self, alert: dict):
        color = {"warning": "#ff9900", "critical": "#ff0000"}.get(alert["severity"], "#36a64f")
        requests.post(self.url, json={
            "attachments": [{
                "color": color,
                "title": f"MiniOp Budget Alert — {alert['severity'].upper()}",
                "fields": [
                    {"title": "Rule", "value": alert["rule"], "short": True},
                    {"title": "Cost", "value": f"${alert['current_cost']:.4f}", "short": True},
                    {"title": "Threshold", "value": f"${alert['threshold']:.2f}", "short": True},
                    {"title": "Utilization", "value": f"{alert['utilization']}%", "short": True},
                ],
                "footer": f"Scope: {alert['scope']} | Period: {alert['period']}",
                "ts": int(datetime.utcnow().timestamp())
            }]
        }, timeout=10)
```

### Alert Runner Script

```python
# minio/alerts/runner.py
#!/usr/bin/env python3
"""Run this via cron every 5 minutes: */5 * * * * python -m minio.alerts.runner"""
import time
from minio.alerts.engine import AlertEngine
from minio.alerts.notifiers import ConsoleNotifier, SlackNotifier, EmailNotifier

# Configure notifiers
notifiers = [ConsoleNotifier()]

import os
if slack_url := os.environ.get("MINIO_SLACK_WEBHOOK"):
    notifiers.append(SlackNotifier(slack_url))

if os.environ.get("MINIO_EMAIL_SMTP_HOST"):
    notifiers.append(EmailNotifier(
        smtp_host=os.environ["MINIO_EMAIL_SMTP_HOST"],
        smtp_port=int(os.environ.get("MINIO_EMAIL_SMTP_PORT", "587")),
        username=os.environ["MINIO_EMAIL_USERNAME"],
        password=os.environ["MINIO_EMAIL_PASSWORD"],
        to=os.environ["MINIO_EMAIL_TO"],
    ))

engine = AlertEngine()
alerts = engine.evaluate()

# Deduplicate: don't re-fire alerts already sent (store in a simple state file)
STATE_FILE = ".alert_state.json"
try:
    with open(STATE_FILE) as f:
        sent_state = json.load(f)
except FileNotFoundError:
    sent_state = {}

new_alerts = []
for alert in alerts:
    key = f"{alert['rule']}:{alert['severity']}"
    last_sent = sent_state.get(key, 0)
    # Re-alert at most once per hour for warning, every 15 min for critical
    cooldown = 3600 if alert["severity"] == "warning" else 900
    if time.time() - last_sent > cooldown:
        new_alerts.append(alert)
        sent_state[key] = time.time()

for alert in new_alerts:
    for notifier in notifiers:
        try:
            notifier.send(alert)
        except Exception as e:
            print(f"Notifier failed: {e}")

with open(STATE_FILE, "w") as f:
    json.dump(sent_state, f)
```

## Production: Real-Time Alerting with Redis + Workers

At scale, replace cron-based polling with event-driven alerting.

### Redis-Based Alert State

```python
# minio/alerts/realtime.py
import redis
import json
import time
from minio.alerts.engine import AlertEngine, BudgetRule

class RealtimeAlertProcessor:
    def __init__(self, redis_url: str = "redis://localhost:6379"):
        self.redis = redis.from_url(redis_url)
        self.engine = AlertEngine()
        self.stream = "minio:cost_events"
        self.alert_cooldowns = "minio:alert_cooldowns"

    def _check_cooldown(self, alert_key: str, cooldown_seconds: int) -> bool:
        """Returns True if alert should fire (not in cooldown)."""
        last = self.redis.get(f"{self.alert_cooldowns}:{alert_key}")
        if last and time.time() - float(last) < cooldown_seconds:
            return False
        self.redis.set(f"{self.alert_cooldowns}:{alert_key}", time.time(), ex=cooldown_seconds * 2)
        return True

    def process_stream(self):
        """Consume cost events and evaluate alerts in real-time."""
        last_id = "0"
        while True:
            entries = self.redis.xread({self.stream: last_id}, count=50, block=5000)
            if not entries:
                continue

            for stream_name, messages in entries:
                for msg_id, data in messages:
                    last_id = msg_id
                    event = json.loads(data["payload"])

                    # Increment running counters in Redis for fast threshold checks
                    self._increment_counters(event)

                    # Check all relevant rules
                    self._evaluate_for_event(event)

    def _increment_counters(self, event: dict):
        now = time.time()
        day_key = time.strftime("%Y-%m-%d", time.gmtime())
        month_key = time.strftime("%Y-%m", time.gmtime())

        pipe = self.redis.pipeline()

        # Global counters
        pipe.incrbyfloat(f"minio:cost:global:daily:{day_key}", event["total_cost"])
        pipe.expire(f"minio:cost:global:daily:{day_key}", 86400 * 2)
        pipe.incrbyfloat(f"minio:cost:global:monthly:{month_key}", event["total_cost"])
        pipe.expire(f"minio:cost:global:monthly:{month_key}", 86400 * 32)

        # Service counters
        service = event["service"]
        pipe.incrbyfloat(f"minio:cost:service:{service}:daily:{day_key}", event["total_cost"])
        pipe.expire(f"minio:cost:service:{service}:daily:{day_key}", 86400 * 2)

        # User counters
        if event.get("user_id"):
            uid = event["user_id"]
            pipe.incrbyfloat(f"minio:cost:user:{uid}:daily:{day_key}", event["total_cost"])
            pipe.expire(f"minio:cost:user:{uid}:daily:{day_key}", 86400 * 2)

        pipe.execute()

    def _evaluate_for_event(self, event: dict):
        day_key = time.strftime("%Y-%m-%d", time.gmtime())
        month_key = time.strftime("%Y-%m", time.gmtime())

        for rule in self.engine.rules:
            if not rule.enabled:
                continue

            # Get current cost from Redis counter
            if rule.scope == "global" and rule.period == "daily":
                current = float(self.redis.get(f"minio:cost:global:daily:{day_key}") or 0)
            elif rule.scope == "global" and rule.period == "monthly":
                current = float(self.redis.get(f"minio:cost:global:monthly:{month_key}") or 0)
            elif rule.scope == "service" and rule.period == "daily":
                current = float(self.redis.get(f"minio:cost:service:{rule.scope_id}:daily:{day_key}") or 0)
            elif rule.scope == "user" and rule.period == "daily":
                uid = event.get("user_id")
                if not uid:
                    continue
                current = float(self.redis.get(f"minio:cost:user:{uid}:daily:{day_key}") or 0)
            else:
                continue

            for severity, threshold in rule.thresholds.items():
                if current >= threshold:
                    alert_key = f"{rule.name}:{severity}"
                    cooldown = 900 if severity == "critical" else 3600
                    if self._check_cooldown(alert_key, cooldown):
                        self._fire_alert(rule, severity, current, threshold)

    def _fire_alert(self, rule: BudgetRule, severity: str, current: float, threshold: float):
        alert = {
            "rule": rule.name, "scope": rule.scope, "scope_id": rule.scope_id,
            "period": rule.period, "severity": severity,
            "current_cost": round(current, 4), "threshold": threshold,
            "utilization": round(current / threshold * 100, 1),
        }
        # Publish to alert channel for notification workers
        self.redis.publish("minio:alerts", json.dumps(alert))
        self.redis.xadd("minio:alert_history", {"alert": json.dumps(alert)}, maxlen=10000)
```

## Automatic Cost Controls (Circuit Breakers)

Alerts alone aren't enough — implement automatic spending caps that reject requests when budgets are exhausted.

```python
# minio/middleware/cost_guard.py
from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
import redis
import time

class CostGuardMiddleware(BaseHTTPMiddleware):
    """Rejects video processing requests when budget is exhausted."""

    def __init__(self, app, redis_url: str = "redis://localhost:6379"):
        super().__init__(app)
        self.redis = redis.from_url(redis_url)

    async def dispatch(self, request: Request, call_next):
        if request.url.path not in ("/api/v1/videos", "/api/v1/process"):
            return await call_next(request)

        # Check global daily cap
        day_key = time.strftime("%Y-%m-%d", time.gmtime())
        global_daily = float(self.redis.get(f"minio:cost:global:daily:{day_key}") or 0)
        hard_limit = float(self.redis.get("minio:budget:global_daily_hard") or 20.0)

        if global_daily >= hard_limit:
            raise HTTPException(
                status_code=429,
                detail={
                    "error": "daily_budget_exhausted",
                    "message": f"Daily budget of ${hard_limit:.2f} reached. Current: ${global_daily:.2f}. Resets at midnight UTC.",
                    "retry_after_seconds": self._seconds_until_midnight()
                }
            )

        # Check per-user daily cap
        user_id = request.state.user_id if hasattr(request.state, "user_id") else None
        if user_id:
            user_daily = float(self.redis.get(f"minio:cost:user:{user_id}:daily:{day_key}") or 0)
            user_limit = float(self.redis.get("minio:budget:per_user_daily_hard") or 5.0)

            if user_daily >= user_limit:
                raise HTTPException(
                    status_code=429,
                    detail={
                        "error": "user_budget_exhausted",
                        "message": f"Your daily limit of ${user_limit:.2f} reached.",
                        "retry_after_seconds": self._seconds_until_midnight()
                    }
                )

        response = await call_next(request)
        return response

    @staticmethod
    def _seconds_until_midnight() -> int:
        import datetime
        now = datetime.datetime.utcnow()
        midnight = (now + datetime.timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        return int((midnight - now).total_seconds())
```

### Setting Hard Limits via API

```python
# minio/api/admin.py
from fastapi import APIRouter, Depends
import redis

router = APIRouter(prefix="/admin/budgets", tags=["admin"])

@router.put("/limits")
async def set_budget_limits(
    global_daily_hard: float = None,
    global_monthly_hard: float = None,
    per_user_daily_hard: float = None,
):
    r = redis.from_url("redis://localhost:6379")
    updates = {}
    if global_daily_hard is not None:
        r.set("minio:budget:global_daily_hard", global_daily_hard)
        updates["global_daily_hard"] = global_daily_hard
    if global_monthly_hard is not None:
        r.set("minio:budget:global_monthly_hard", global_monthly_hard)
        updates["global_monthly_hard"] = global_monthly_hard
    if per_user_daily_hard is not None:
        r.set("minio:budget:per_user_daily_hard", per_user_daily_hard)
        updates["per_user_daily_hard"] = per_user_daily_hard
    return {"updated": updates}

@router.get("/limits")
async def get_budget_limits():
    r = redis.from_url("redis://localhost:6379")
    return {
        "global_daily_hard": float(r.get("minio:budget:global_daily_hard") or 20.0),
        "global_monthly_hard": float(r.get("minio:budget:global_monthly_hard") or 500.0),
        "per_user_daily_hard": float(r.get("minio:budget:per_user_daily_hard") or 5.0),
    }
```

## AWS CloudWatch + SNS Integration

If you're running on AWS, integrate directly with CloudWatch for billing alerts.

```bash
# Create a CloudWatch alarm for estimated charges
aws cloudwatch put-metric-alarm \
  --alarm-name "MiniOp-DailyCost-Warning" \
  --alarm-description "MiniOp daily AWS costs exceeded $10" \
  --metric-name EstimatedCharges \
  --namespace AWS/Billing \
  --statistic Maximum \
  --period 21600 \
  --threshold 10 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 1 \
  --alarm-actions arn:aws:sns:us-east-1:123456789:minio-alerts \
  --dimensions Name=Currency,Value=USD

# SNS topic for notifications
aws sns create-topic --name minio-alerts
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:123456789:minio-alerts \
  --protocol email \
  --notification-endpoint ops@yourcompany.com
```

## Free Tier vs Production Summary

| Aspect | Free Tier | Production |
|--------|-----------|------------|
| Evaluation | Cron (every 5 min) | Real-time via Redis Streams |
| State | JSON file on disk | Redis keys with TTL |
| Notifications | Console + email | Slack + PagerDuty + SMS |
| Cost controls | None (alert only) | Circuit breaker middleware |
| Rules config | JSON file | Database + admin API |
| Alert history | None | Redis stream (10K cap) |
| Provider alerts | Manual | CloudWatch + GCP Billing |
| Cooldown | File-based dedup | Redis TTL-based |
