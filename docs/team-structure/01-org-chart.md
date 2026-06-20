# MiniOp Organization Chart

## Overview

This document defines the organizational structure for MiniOp, an open-source AI-powered video clipping platform (Opus Clip clone). The structure scales from a lean founding team to a full production organization. Every role maps to specific services, repositories, and on-call responsibilities.

---

## Phase 1: Free Tier / Small Team (3-8 people)

At the free-tier stage, one person may own multiple roles. The goal is shipping features fast while keeping the architecture clean enough to hand off later.

### Founding Structure

```
CEO / Product Lead
├── Engineering Lead (also Backend Lead)
│   ├── Full-Stack Engineer #1 (Frontend + Infra)
│   ├── Full-Stack Engineer #2 (AI/ML + Backend)
│   └── Full-Stack Engineer #3 (Video Pipeline + DevOps)
├── Design Lead (also UX Research)
└── Growth Lead (also Community Manager)
```

### Role Definitions — Free Tier

#### Engineering Lead
- **Owns**: Architecture decisions, code review, sprint planning
- **Services**: API Gateway, Auth Service, Database migrations
- **Repos**: `minio-api`, `minio-infra`, `minio-shared-types`
- **On-call**: Primary for all production incidents

```yaml
# .github/CODEOWNERS — Free Tier
/services/api-gateway/      @eng-lead
/services/auth/              @eng-lead
/packages/shared-types/      @eng-lead
/infra/                      @eng-lead @eng-3
```

#### Full-Stack Engineer #1 — Frontend + Infra
- **Owns**: Web application, CI/CD pipeline, deployment automation
- **Services**: Next.js frontend, Vercel/Railway deployments, GitHub Actions
- **Repos**: `minio-web`, `minio-ci`
- **On-call**: Secondary, frontend incidents

#### Full-Stack Engineer #2 — AI/ML + Backend
- **Owns**: Clip selection model, transcription pipeline, scene detection
- **Services**: Whisper transcription, GPT-4 scene analysis, clip scoring
- **Repos**: `minio-ml`, `minio-api`
- **On-call**: Secondary, AI pipeline incidents

#### Full-Stack Engineer #3 — Video Pipeline + DevOps
- **Owns**: Video processing, storage, CDN delivery
- **Services**: FFmpeg workers, S3 storage, CloudFront CDN, Redis queues
- **Repos**: `minio-video-worker`, `minio-infra`
- **On-call**: Secondary, video pipeline incidents

### Ownership Matrix — Free Tier

| Domain | Primary | Secondary | Services |
|--------|---------|-----------|----------|
| API & Auth | Eng Lead | Eng #2 | Express.js, JWT, PostgreSQL |
| Frontend | Eng #1 | Eng Lead | Next.js, Tailwind, TanStack Query |
| AI/ML Pipeline | Eng #2 | Eng #1 | Whisper, GPT-4, scene detection |
| Video Processing | Eng #3 | Eng #2 | FFmpeg, S3, Redis Bull queues |
| Infrastructure | Eng #3 | Eng #1 | Docker, Railway, GitHub Actions |
| Database | Eng Lead | Eng #3 | PostgreSQL, Prisma, Redis |

### Standup Format — Free Tier

```markdown
## Daily Standup (15 min, async-first via Slack)

Each person posts in #minio-standup:
1. What I shipped yesterday (link to PR)
2. What I'm shipping today
3. Blockers (tag the person who can unblock)

Eng Lead runs a 10-min sync call Mon/Wed/Fri only.
```

---

## Phase 2: Scaled Production (15-40 people)

As MiniOp grows past 10K active users and processes thousands of videos daily, the org splits into specialized teams with clear ownership boundaries.

### Scaled Structure

```
VP Engineering
├── Platform Team (4-6 engineers)
│   ├── Platform Lead
│   ├── Infrastructure Engineer x2
│   └── SRE / DevOps Engineer x2
├── Clip Intelligence Team (5-7 engineers)
│   ├── ML Lead
│   ├── ML Engineer x2 (models, training)
│   ├── Backend Engineer x2 (API, pipeline orchestration)
│   └── Data Engineer x1 (feature store, analytics)
├── Creator Experience Team (4-6 engineers)
│   ├── Frontend Lead
│   ├── Frontend Engineer x2
│   └── Full-Stack Engineer x2
├── Video Pipeline Team (4-6 engineers)
│   ├── Pipeline Lead
│   ├── Video Engineer x2 (encoding, streaming)
│   ├── Storage Engineer x1 (S3, CDN, archival)
│   └── Queue/Worker Engineer x1 (BullMQ, scaling)
├── Quality Assurance (2-3 engineers)
│   ├── QA Lead
│   └── Test Automation Engineer x2
└── Product & Design (3-4 people)
    ├── Product Manager
    ├── Product Designer
    └── UX Researcher
```

### Team Charters — Scaled

#### Platform Team
**Mission**: Reliable, observable, secure infrastructure.

```yaml
# platform-team.yml
responsibilities:
  - Kubernetes cluster management
  - CI/CD pipeline (GitHub Actions → ArgoCD)
  - Monitoring stack (Grafana, Prometheus, PagerDuty)
  - Security: WAF, secrets management, dependency scanning
  - Cost optimization (spot instances, reserved capacity)

services_owned:
  - k8s/* (cluster configs)
  - terraform/* (infrastructure as code)
  - monitoring/* (dashboards, alerts)
  - security/* (policies, scanning)

sla:
  uptime: 99.95%
  deploy_frequency: "multiple per day"
  incident_response: "< 5 min P1, < 30 min P2"
```

#### Clip Intelligence Team
**Mission**: Best-in-class AI clip selection and enhancement.

```yaml
# clip-intelligence-team.yml
responsibilities:
  - Transcription accuracy (Whisper fine-tuning)
  - Clip scoring model (engagement prediction)
  - Scene detection and boundary analysis
  - Auto-caption generation and styling
  - B-roll and highlight detection

services_owned:
  - services/transcription/*
  - services/clip-scorer/*
  - services/scene-detector/*
  - ml-models/* (training pipelines)
  - feature-store/* (ML features)

sla:
  transcription_latency: "< 30s per minute of video"
  clip_scoring_accuracy: "> 85% user acceptance"
  model_update_frequency: "weekly retraining"
```

#### Creator Experience Team
**Mission**: Fast, intuitive interface for video creators.

```yaml
# creator-experience-team.yml
responsibilities:
  - Upload flow and progress tracking
  - Clip preview and editing interface
  - Export and sharing functionality
  - Dashboard and analytics views
  - Mobile-responsive design

services_owned:
  - apps/web/*
  - packages/ui-components/*
  - packages/editor/*

sla:
  page_load: "< 2s (LCP)"
  time_to_interactive: "< 3s"
  error_rate: "< 0.1%"
```

#### Video Pipeline Team
**Mission**: Fast, reliable video processing at scale.

```yaml
# video-pipeline-team.yml
responsibilities:
  - Video ingestion and validation
  - Transcoding (multi-resolution, HLS)
  - Clip extraction and assembly
  - Storage lifecycle management
  - CDN configuration and cache invalidation

services_owned:
  - services/video-ingest/*
  - services/transcoder/*
  - services/clip-assembler/*
  - services/storage-manager/*
  - infra/cdn/*

sla:
  processing_time: "< 2x video duration"
  availability: 99.9%
  storage_durability: 99.999999999%
```

### Team Communication Cadence — Scaled

```yaml
# team-cadence.yml
ceremonies:
  daily_standup:
    format: async (Slack) + 10-min sync if needed
    time: "10:00 AM local per team"
    
  weekly_planning:
    format: sync (Zoom/Meet)
    duration: 60 min
    attendees: team members only
    
  sprint_review:
    format: sync + recorded
    duration: 90 min
    attendees: team + stakeholders
    
  cross_team_sync:
    format: sync
    frequency: bi-weekly
    duration: 30 min
    attendees: all leads + PM
    
  architecture_review:
    format: sync (RFC-driven)
    frequency: as needed
    duration: 60 min
    attendees: all leads + relevant engineers
```

### On-Call Rotation — Scaled

```yaml
# pagerduty-schedule.yml
teams:
  platform:
    primary: platform-eng-1
    secondary: platform-eng-2
    escalation: platform-lead
    services: [k8s, terraform, monitoring]
    
  clip_intelligence:
    primary: ml-eng-1
    secondary: ml-eng-2
    escalation: ml-lead
    services: [transcription, clip-scorer, scene-detector]
    
  creator_experience:
    primary: frontend-eng-1
    secondary: frontend-eng-2
    escalation: frontend-lead
    services: [web-app, editor]
    
  video_pipeline:
    primary: pipeline-eng-1
    secondary: pipeline-eng-2
    escalation: pipeline-lead
    services: [video-ingest, transcoder, storage]

rotation:
  shift_duration: 1 week
  handoff: "Monday 10:00 AM"
  postmortem_required: true
  compensation: "on-call stipend + time-in-lieu"
```

### Hiring Plan — Scaled Growth

```yaml
# hiring-plan.yml
quarter_1:
  - role: "ML Engineer (Clip Intelligence)"
    priority: critical
    requirements: ["PyTorch", "video ML", "model optimization"]
    
  - role: "Senior Frontend Engineer"
    priority: high
    requirements: ["React/Next.js", "video players", "real-time UI"]
    
quarter_2:
  - role: "SRE Engineer"
    priority: critical
    requirements: ["Kubernetes", "observability", "incident management"]
    
  - role: "Video Engineer"
    priority: high
    requirements: ["FFmpeg", "HLS/DASH", "codec optimization"]
    
quarter_3:
  - role: "Data Engineer"
    priority: medium
    requirements: ["feature stores", "ML pipelines", "analytics"]
    
  - role: "QA Automation Engineer"
    priority: medium
    requirements: ["Playwright", "visual regression", "load testing"]
```

---

## Transition Guide: Free Tier → Scaled

### When to Split Teams

Split when:
- Deploy frequency drops below 2x/week due to coordination overhead
- Incident response time exceeds 15 minutes consistently
- Any single person is a bottleneck for >2 other people
- Code review turnaround exceeds 24 hours

### How to Split

1. **Define ownership boundaries** in `CODEOWNERS` — no shared ownership
2. **Extract services** — move from monorepo modules to independent deployable units
3. **Establish SLAs** — each team commits to measurable targets
4. **Set up cross-team sync** — bi-weekly leads meeting, shared Slack channels
5. **Document handoffs** — API contracts, runbooks, escalation paths

```bash
# Example: Splitting video pipeline into its own deployable service
# Before (monorepo module)
/packages/video-worker/src/**

# After (independent service)
# New repo: minio-video-pipeline
# New CI: .github/workflows/pipeline-deploy.yml
# New on-call: PagerDuty schedule for video-pipeline team
```

---

## Appendix: Org Chart as Code

Maintain the org chart in version control so it stays current:

```yaml
# org-chart.yml (source of truth)
version: 2
last_updated: "2026-01-15"

teams:
  platform:
    lead: "@alice"
    members: ["@bob", "@charlie", "@diana", "@eve"]
    slack: "#platform-team"
    pagerduty: "platform-oncall"
    
  clip_intelligence:
    lead: "@frank"
    members: ["@grace", "@heidi", "@ivan", "@judy", "@karl"]
    slack: "#ml-team"
    pagerduty: "ml-oncall"
    
  creator_experience:
    lead: "@laura"
    members: ["@mallory", "@nancy", "@oscar", "@peggy"]
    slack: "#frontend-team"
    pagerduty: "frontend-oncall"
    
  video_pipeline:
    lead: "@quinn"
    members: ["@rachel", "@steve", "@trudy", "@uma"]
    slack: "#pipeline-team"
    pagerduty: "pipeline-oncall"
```

Generate visual charts from this YAML using any org-chart rendering tool. Keep the YAML as the single source of truth.
