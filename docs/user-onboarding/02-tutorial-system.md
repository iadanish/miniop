# MiniOp Tutorial System

## Overview

MiniOp's tutorial system provides contextual, interactive guidance that teaches users how to generate clips, customize outputs, and optimize their workflow. Unlike static documentation, the tutorial system reacts to user actions in real-time and adapts based on experience level and tier.

The system has three components: the `TutorialEngine` (backend logic), the `TutorialOverlay` (frontend UI), and the `TutorialContent` store (markdown-based content with embedded triggers).

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  TutorialContent │     │  TutorialEngine   │     │ TutorialOverlay │
│  (Markdown+YAML) │────▶│  (State + Rules)  │────▶│   (React/UI)    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                              │        │
                    ┌─────────┘        └─────────┐
              ┌─────▼─────┐              ┌──────▼──────┐
              │  User      │              │  Analytics   │
              │  Progress  │              │  Events      │
              └───────────┘              └─────────────┘
```

## Tutorial Content Structure

Each tutorial is a YAML manifest with embedded markdown steps. This format allows non-developers to author and update tutorials without code changes:

```yaml
# tutorials/generate-first-clip.yaml
id: generate-first-clip
title: "Generate Your First Clip"
description: "Learn how to upload a video and create short clips"
trigger:
  event: "first_upload_complete"
  conditions:
    onboarding_step: "first_upload"
    tier: ["free", "pro", "enterprise"]
estimated_duration_seconds: 180
steps:
  - id: select-moments
    title: "Select Highlight Moments"
    type: "interactive"
    target_element: "[data-tutorial='moment-detection']"
    position: "right"
    content: |
      MiniOp automatically detected **highlight moments** in your video.
      These are segments with high engagement potential based on speech
      patterns, visual changes, and topic transitions.

      Click on a moment to preview it.
    validation:
      action: "click"
      selector: "[data-tutorial='moment-card']"
      timeout_seconds: 60

  - id: adjust-clip
    title: "Adjust Clip Boundaries"
    type: "interactive"
    target_element: "[data-tutorial='clip-timeline']"
    position: "top"
    content: |
      Drag the handles to adjust start and end points.
      The AI suggests optimal cut points, but you have full control.

      **Tip**: Aim for 30-60 seconds for TikTok/Reels, 60-90 for YouTube Shorts.
    validation:
      action: "drag"
      selector: "[data-tutorial='timeline-handle']"
      timeout_seconds: 90

  - id: add-captions
    title: "Enable Auto-Captions"
    type: "interactive"
    target_element: "[data-tutorial='caption-toggle']"
    position: "left"
    content: |
      Turn on auto-captions to boost engagement. Videos with captions
      get **40% more watch time** on average.

      You can customize the style after generation.
    validation:
      action: "toggle"
      selector: "[data-tutorial='caption-enabled']"
      timeout_seconds: 30

  - id: export
    title: "Export Your Clip"
    type: "interactive"
    target_element: "[data-tutorial='export-button']"
    position: "bottom"
    content: |
      Export your clip in the format optimized for your target platform.
      Free tier: 720p with watermark. Pro: 1080p, no watermark.
    validation:
      action: "click"
      selector: "[data-tutorial='export-confirm']"
      timeout_seconds: 30
```

## Free Tier Tutorial Implementation

### Tutorial Engine

The `TutorialEngine` manages tutorial state and progression. For free tier, it runs as an in-process module:

```python
# services/tutorials/engine.py
from dataclasses import dataclass, field
from typing import Optional
import yaml
from pathlib import Path

@dataclass
class TutorialStep:
    id: str
    title: str
    type: str  # "interactive", "info", "video"
    target_element: str
    position: str
    content: str
    validation: dict
    completed: bool = False

@dataclass
class Tutorial:
    id: str
    title: str
    steps: list[TutorialStep]
    current_step_index: int = 0
    completed: bool = False

class TutorialEngine:
    def __init__(self, content_dir: str = "tutorials/"):
        self.content_dir = Path(content_dir)
        self._tutorials: dict[str, dict] = {}
        self._load_tutorials()

    def _load_tutorials(self):
        for yaml_file in self.content_dir.glob("*.yaml"):
            with open(yaml_file) as f:
                tutorial = yaml.safe_load(f)
                self._tutorials[tutorial["id"]] = tutorial

    def get_tutorial(self, tutorial_id: str) -> Optional[dict]:
        return self._tutorials.get(tutorial_id)

    def get_triggered_tutorials(self, event: str, user_context: dict) -> list[dict]:
        """Return tutorials whose trigger conditions match the event and context."""
        triggered = []
        for tutorial in self._tutorials.values():
            trigger = tutorial.get("trigger", {})
            if trigger.get("event") != event:
                continue
            conditions = trigger.get("conditions", {})
            if self._conditions_match(conditions, user_context):
                triggered.append(tutorial)
        return triggered

    def _conditions_match(self, conditions: dict, context: dict) -> bool:
        for key, expected in conditions.items():
            actual = context.get(key)
            if isinstance(expected, list):
                if actual not in expected:
                    return False
            elif actual != expected:
                return False
        return True
```

### Frontend Tutorial Overlay

The overlay is a React component that renders tutorial steps as positioned tooltips with interactive validation:

```tsx
// frontend/src/components/Tutorial/TutorialOverlay.tsx
import React, { useState, useEffect, useCallback } from 'react';
import { useTutorialEngine } from '../../hooks/useTutorialEngine';

interface TutorialStep {
  id: string;
  title: string;
  type: string;
  target_element: string;
  position: string;
  content: string;
  validation: {
    action: string;
    selector: string;
    timeout_seconds: number;
  };
}

export const TutorialOverlay: React.FC<{ tutorialId: string }> = ({ tutorialId }) => {
  const { tutorial, advanceStep, completeTutorial } = useTutorialEngine(tutorialId);
  const [currentStep, setCurrentStep] = useState<TutorialStep | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (tutorial && !tutorial.completed) {
      const step = tutorial.steps[tutorial.current_step_index];
      setCurrentStep(step);
      updatePosition(step.target_element, step.position);
    }
  }, [tutorial]);

  const updatePosition = useCallback((selector: string, placement: string) => {
    const element = document.querySelector(selector);
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const offset = 12;
    switch (placement) {
      case 'top':
        setPosition({ top: rect.top - offset, left: rect.left + rect.width / 2 });
        break;
      case 'bottom':
        setPosition({ top: rect.bottom + offset, left: rect.left + rect.width / 2 });
        break;
      case 'left':
        setPosition({ top: rect.top + rect.height / 2, left: rect.left - offset });
        break;
      case 'right':
        setPosition({ top: rect.top + rect.height / 2, left: rect.right + offset });
        break;
    }
  }, []);

  if (!currentStep) return null;

  return (
    <div className="tutorial-overlay">
      <div
        className="tutorial-tooltip"
        style={{ top: position.top, left: position.left }}
      >
        <div className="tutorial-header">
          <span className="tutorial-step-indicator">
            Step {tutorial!.current_step_index + 1} of {tutorial!.steps.length}
          </span>
          <h3>{currentStep.title}</h3>
        </div>
        <div
          className="tutorial-content"
          dangerouslySetInnerHTML={{ __html: currentStep.content }}
        />
        <div className="tutorial-actions">
          <button onClick={() => completeTutorial()}>Skip Tutorial</button>
        </div>
      </div>
      <div className="tutorial-highlight" data-target={currentStep.target_element} />
    </div>
  );
};
```

### Progress Tracking

Tutorial progress is stored per-user in PostgreSQL:

```sql
CREATE TABLE tutorial_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    tutorial_id VARCHAR(100) NOT NULL,
    current_step_index INT DEFAULT 0,
    completed BOOLEAN DEFAULT FALSE,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    time_spent_seconds INT DEFAULT 0,
    UNIQUE(user_id, tutorial_id)
);

CREATE INDEX idx_tutorial_progress_user ON tutorial_progress(user_id, completed);
```

## Scaled Production Implementation

### Distributed Tutorial Service

In production, the tutorial engine runs as a standalone service with Redis-backed state for fast step transitions:

```yaml
# deploy/tutorial-service.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tutorial-service
spec:
  replicas: 2
  selector:
    matchLabels:
      app: tutorial-service
  template:
    spec:
      containers:
        - name: tutorial
          image: minio/opencut-tutorial:latest
          env:
            - name: REDIS_URL
              value: "redis://redis-cluster:6379/3"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: tutorial-secrets
                  key: database-url
            - name: CONTENT_SYNC_INTERVAL
              value: "300"
          ports:
            - containerPort: 8082
```

### Content Sync from Git

Tutorial content is stored in a Git repository and synced to the service. This allows content updates without deployments:

```python
# services/tutorials/content_sync.py
import subprocess
from pathlib import Path

class TutorialContentSync:
    def __init__(self, repo_url: str, local_dir: str, branch: str = "main"):
        self.repo_url = repo_url
        self.local_dir = Path(local_dir)
        self.branch = branch

    def sync(self) -> bool:
        if (self.local_dir / ".git").exists():
            result = subprocess.run(
                ["git", "-C", str(self.local_dir), "pull", "origin", self.branch],
                capture_output=True, text=True
            )
        else:
            result = subprocess.run(
                ["git", "clone", "-b", self.branch, self.repo_url, str(self.local_dir)],
                capture_output=True, text=True
            )
        return result.returncode == 0

    def get_changed_tutorials(self, since_commit: str = "HEAD~1") -> list[str]:
        result = subprocess.run(
            ["git", "-C", str(self.local_dir), "diff", "--name-only", since_commit],
            capture_output=True, text=True
        )
        return [f for f in result.stdout.strip().split("\n") if f.endswith(".yaml")]
```

### A/B Testing Tutorials

Scaled production supports A/B testing different tutorial variants to optimize completion rates:

```python
# services/tutorials/experiments.py
import hashlib
import json

class TutorialExperiment:
    def __init__(self, redis_client):
        self.redis = redis_client

    def assign_variant(self, user_id: str, experiment_id: str, variants: list[str]) -> str:
        cache_key = f"tutorial_experiment:{experiment_id}:{user_id}"
        cached = self.redis.get(cache_key)
        if cached:
            return cached.decode()

        hash_val = int(hashlib.md5(f"{experiment_id}:{user_id}".encode()).hexdigest(), 16)
        variant = variants[hash_val % len(variants)]
        self.redis.setex(cache_key, 86400 * 30, variant)  # 30 day assignment
        return variant

    def get_tutorial_variant(self, user_id: str, base_tutorial_id: str) -> str:
        experiments = self._get_active_experiments(base_tutorial_id)
        variant = base_tutorial_id
        for exp in experiments:
            assigned = self.assign_variant(user_id, exp["id"], exp["variants"])
            if assigned != "control":
                variant = f"{base_tutorial_id}-{assigned}"
        return variant

    def _get_active_experiments(self, tutorial_id: str) -> list[dict]:
        data = self.redis.get(f"experiments:{tutorial_id}")
        return json.loads(data) if data else []
```

### Tutorial Analytics

Track tutorial effectiveness with detailed event logging:

```sql
-- Tutorial funnel analysis
SELECT
    t.tutorial_id,
    t.step_id,
    COUNT(*) as started,
    COUNT(*) FILTER (WHERE t.completed = TRUE) as completed,
    AVG(t.time_spent_seconds) as avg_time_seconds,
    COUNT(*) FILTER (WHERE t.abandoned = TRUE) as abandoned
FROM tutorial_step_events t
WHERE t.created_at >= NOW() - INTERVAL 7 DAY
GROUP BY t.tutorial_id, t.step_id, t.step_order
ORDER BY t.tutorial_id, t.step_order;
```

```python
# services/tutorials/analytics.py
async def log_tutorial_event(engine, user_id, tutorial_id, step_id, event_type, metadata=None):
    await engine.execute("""
        INSERT INTO tutorial_step_events (user_id, tutorial_id, step_id, event_type, metadata, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
    """, user_id, tutorial_id, step_id, event_type, json.dumps(metadata or {}))
```

## Tutorial Content Authoring

### Creating a New Tutorial

1. Create a YAML file in the `tutorials/` directory:

```bash
touch tutorials/my-new-tutorial.yaml
```

2. Follow the manifest structure:

```yaml
id: my-new-tutorial
title: "Tutorial Title"
description: "What the user will learn"
trigger:
  event: "event_name"
  conditions:
    tier: ["free", "pro"]
    experience_level: ["beginner"]
estimated_duration_seconds: 120
steps:
  - id: step-1
    title: "Step Title"
    type: "interactive"
    target_element: "[data-tutorial='element-id']"
    position: "right"
    content: "Markdown content with **bold** and *italic*."
    validation:
      action: "click"
      selector: "[data-tutorial='target']"
      timeout_seconds: 30
```

3. Test locally:

```bash
python -m tutorials.validate tutorials/my-new-tutorial.yaml
python -m tutorials.preview tutorials/my-new-tutorial.yaml --user=test-user
```

4. Submit via PR to the `tutorials-content` repository.

## Configuration

```env
TUTORIALS_ENABLED=true
TUTORIALS_CONTENT_DIR=./tutorials
TUTORIALS_CONTENT_REPO=https://github.com/minio/tutorials-content.git
TUTORIALS_SYNC_INTERVAL_SECONDS=300
TUTORIALS_REDIS_URL=redis://localhost:6379/3
TUTORIALS_ANALYTICS_ENABLED=true
TUTORIALS_AB_TESTING_ENABLED=false
TUTORIALS_AUTO_TRIGGER=true
TUTORIALS_SKIP_ON_REPEAT_VISIT=false
```

## Testing

```bash
# Unit tests
pytest tests/tutorials/test_engine.py -v

# Content validation
python -m tutorials.validate --all

# Integration tests
pytest tests/tutorials/test_overlay.py -v --headed  # Playwright tests

# Load test tutorial service
k6 run tests/load/tutorials.js
```

## Next Steps

Tutorial completion events feed into the feedback collection system (`03-feedback-collection.md`). When a user completes or abandons a tutorial, the system triggers a feedback prompt to capture their experience and identify improvement opportunities.
