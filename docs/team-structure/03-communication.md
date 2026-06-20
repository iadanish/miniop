# MiniOp Communication

## Overview

This document defines communication practices for MiniOp — how teams share information, make decisions, handle incidents, and maintain alignment. It covers Slack structure, meeting cadences, documentation standards, RFC processes, and async-first workflows that scale from a 3-person startup to a 40-person organization.

---

## Phase 1: Free Tier Communication (3-8 people)

### Slack Workspace Structure

```
#minio-general          — Company-wide announcements
#minio-standup          — Daily async standups
#minio-dev              — Technical discussions, debugging
#minio-incidents        — Production alerts and incident response
#minio-prs              — GitHub PR notifications (bot integration)
#minio-deploys          — Deployment notifications (bot integration)
#minio-random           — Non-work chat
```

**Bot integrations for free tier:**

```yaml
# Slack apps to install
- GitHub:
    channels:
      - "#minio-prs": [pull_request, pull_request_review]
      - "#minio-deploys": [deployment_status, push]
      - "#minio-dev": [issues, issue_comment]
      
- Sentry:
    channels:
      - "#minio-incidents": [error_alerts]
      
- Vercel:
    channels:
      - "#minio-deploys": [deployment_events]
```

### Async Standup Format

Post in `#minio-standup` by 10:00 AM local time:

```markdown
## Standup — @alice — 2026-01-15

**Yesterday:**
- Merged clip preview player (#234)
- Fixed transcription timeout on large files (#241)

**Today:**
- Working on batch upload feature (#245)
- Review PR #239 from @bob

**Blockers:**
- Need API key for new Whisper model — @eng-lead can you approve?
```

### Decision-Making — Lightweight ADRs

For technical decisions that affect multiple people, write an ADR (Architecture Decision Record):

```markdown
# ADR-007: Switch from BullMQ to SQS for video processing

## Status
Accepted — 2026-01-15

## Context
We process ~500 videos/day. BullMQ on Redis works but we're hitting memory limits
on our Railway Redis instance. Scaling Redis vertically is expensive.

## Decision
Switch to AWS SQS for video processing queue. Keep Redis for caching and sessions.

## Consequences
+ Nearly unlimited queue depth
+ Built-in dead letter queue
+ Cheaper at scale
- Need to rewrite queue producer/consumer
- Slightly higher per-message latency (~50ms vs ~5ms)
- AWS dependency increases

## Implementation
1. Create SQS queue + DLQ in Terraform
2. Implement new producer in `services/video-worker/src/queue/sqs.ts`
3. Implement new consumer with `@aws-sdk/client-sqs`
4. Run both queues in parallel for 1 week
5. Cut over and remove BullMQ code
```

Store ADRs in the repo:
```
/docs/adr/
├── 001-use-postgresql.md
├── 002-monorepo-structure.md
├── 003-whisper-for-transcription.md
├── 004-next-js-frontend.md
├── 005-bullmq-for-queues.md
├── 006-railway-deployment.md
└── 007-sqs-for-video-processing.md
```

### Meeting Cadence — Free Tier

```yaml
meetings:
  daily_standup:
    format: async (Slack)
    time: "10:00 AM post"
    
  weekly_planning:
    format: sync (Google Meet / Zoom)
    time: "Monday 11:00 AM"
    duration: 45 min
    agenda:
      - Review last week's PRs (5 min)
      - Demo completed features (10 min)
      - Plan this week's priorities (20 min)
      - Blockers and questions (10 min)
    output: "#minio-general summary post"
    
  friday_retro:
    format: sync
    time: "Friday 4:00 PM"
    duration: 30 min
    format_exercise: "Start / Stop / Continue"
    
  ad_hoc:
    format: sync (huddle in Slack)
    trigger: "Any 2+ people need to discuss for >5 min"
    rule: "Summarize outcome in relevant channel"
```

### Incident Communication — Free Tier

```markdown
## Incident Response Flow

1. **Detection**: Sentry alert or user report in #minio-incidents
2. **Acknowledge**: React with 👀, post "Investigating"
3. **Communicate**: Update every 15 min in #minio-incidents
4. **Resolve**: Post resolution and root cause
5. **Retrospect**: 15-min sync within 48 hours

## Template
🔴 **INCIDENT: [Brief description]**
- **Severity**: P1/P2/P3
- **Impact**: [What's broken, who's affected]
- **Status**: Investigating / Identified / Monitoring / Resolved
- **Updates**: 
  - [10:15] Identified: Database connection pool exhausted
  - [10:30] Mitigating: Restarted API pods, increased pool size
  - [10:45] Monitoring: Latency returning to normal
- **Root cause**: [Post-resolution]
- **Action items**: [Prevention steps]
```

### Documentation Standards — Free Tier

```markdown
## Required Documentation

### README.md (every repo)
- What this service does (2 sentences)
- Quick start (clone → install → run)
- Environment variables (table)
- API endpoints (if applicable)
- Architecture diagram (ASCII or Mermaid)

### API Documentation
- OpenAPI spec at /docs/api/openapi.yml
- Auto-generated Swagger UI at /api/docs
- Example requests in README

### Runbooks (critical paths only)
- /docs/runbooks/video-processing.md
- /docs/runbooks/database-incident.md
- /docs/runbooks/deployment-rollback.md
```

---

## Phase 2: Scaled Production Communication (15-40 people)

### Slack Workspace Structure — Scaled

```
# Company-wide
#general                    — Announcements, all-company
#random                     — Non-work
#incidents                  — Production incident coordination
#deployments                — Deployment notifications
#architecture               — Architecture discussions and RFCs

# Team channels
#platform-team              — Platform team discussions
#ml-team                    — Clip Intelligence team
#frontend-team              — Creator Experience team
#pipeline-team              — Video Pipeline team
#qa-team                    — Quality Assurance

# Cross-team
#platform-ml-sync           — Platform ↔ ML coordination
#platform-pipeline-sync     — Platform ↔ Pipeline coordination
#frontend-api-sync          — Frontend ↔ API coordination

# Project channels
#proj-batch-processing      — Batch processing feature
#proj-auto-captions         — Auto-captions feature
#proj-mobile-app            — Mobile app project

# Social
#pets                       — Pet photos
#food                       — Food discussions
#gaming                     — Gaming sessions
```

### Slack Configuration — Scaled

```yaml
# slack-config.yml
workspace_settings:
  default_channels:
    - "#general"
    - "#random"
    - "#incidents"
    
  onboarding_channels:
    - "#general"
    - "#random"
    - "[team-channel]"
    - "#incidents"
    
  notification_rules:
    "#incidents":
      mentions: "all"
      priority: true
    "#deployments":
      mentions: "none"  # Read-only, bot posts only
    "#architecture":
      mentions: "channel"
      
  thread_policy:
    "#general": "encouraged"
    "#incidents": "required"
    "#dev-*": "required"
    
  archive_policy:
    inactive_days: 90
    archive_warning_days: 7
```

### RFC Process — Scaled

For decisions affecting multiple teams or significant architecture changes:

```markdown
# RFC: Event-Driven Architecture for Video Processing

## Metadata
- **RFC Number**: RFC-023
- **Author**: @quinn (Video Pipeline Lead)
- **Created**: 2026-01-15
- **Status**: In Review
- **Reviewers**: @alice (Platform), @frank (ML), @laura (Frontend)
- **Discussion**: #architecture thread

## Summary
Transition video processing from synchronous request-response to event-driven
architecture using AWS EventBridge and SNS/SQS.

## Motivation
Current synchronous processing blocks API responses for up to 30 seconds on
large videos. Users report timeouts. We need decoupled processing to:
1. Accept uploads instantly
2. Process asynchronously
3. Notify users on completion

## Detailed Design

### Event Flow
```
Upload API → S3 → EventBridge → 
  ├── Transcription Service → EventBridge →
  │   └── Clip Scorer → EventBridge →
  │       └── Notification Service → WebSocket → User
  └── Thumbnail Generator → EventBridge → S3
```

### Event Schema
```typescript
interface VideoUploadedEvent {
  type: 'video.uploaded';
  data: {
    videoId: string;
    userId: string;
    s3Key: string;
    duration: number;
    format: string;
  };
  metadata: {
    timestamp: string;
    source: 'upload-api';
    version: '1.0';
  };
}
```

### Implementation Plan
1. Define event schemas in `@miniop/events` package
2. Create EventBridge bus and rules in Terraform
3. Implement publisher in Upload API
4. Implement consumers in each service
5. Add WebSocket notification service
6. Run parallel with sync path for 2 weeks
7. Cut over and remove sync code

## Alternatives Considered
1. **AWS Step Functions**: More complex, harder to debug
2. **Kafka**: Overkill for current volume, operational overhead
3. **Redis Streams**: Already hitting Redis memory limits

## Open Questions
- Should we use EventBridge Pipes for transformations?
- Dead letter queue strategy — retry count and backoff?

## Review Timeline
- Week 1: Comments and questions
- Week 2: Revised draft
- Week 3: Final approval
```

**RFC workflow:**

```bash
# Create RFC
git checkout -b rfc/event-driven-video-processing
# Write RFC document
# Create PR with "RFC" label
# Tag reviewers
# Discussion happens in PR comments + Slack #architecture
# After approval, merge and implement
```

### Meeting Cadence — Scaled

```yaml
meetings:
  # Team-level (each team runs their own)
  daily_standup:
    format: async (Slack) + optional 10-min sync
    time: "10:00 AM local"
    
  team_planning:
    format: sync
    frequency: weekly
    duration: 60 min
    attendees: team members only
    
  team_retro:
    format: sync
    frequency: bi-weekly
    duration: 45 min
    format_exercise: "4Ls (Liked, Learned, Lacked, Longed For)"
    
  # Cross-team
  leads_sync:
    format: sync
    frequency: weekly (Monday)
    duration: 30 min
    attendees: all team leads + PM
    agenda:
      - Team health check (5 min)
      - Cross-team dependencies (15 min)
      - Upcoming decisions (10 min)
    
  architecture_review:
    format: sync
    frequency: as needed (driven by RFCs)
    duration: 60 min
    attendees: relevant leads + engineers
    output: decision recorded in RFC
    
  all_hands:
    format: sync (recorded)
    frequency: monthly
    duration: 60 min
    agenda:
      - Company update (15 min)
      - Product roadmap (15 min)
      - Engineering highlights (15 min)
      - Q&A (15 min)
    
  # Cross-team coordination
  cross_team_sync:
    format: sync
    frequency: bi-weekly
    duration: 30 min
    purpose: "Align on shared interfaces and dependencies"
    pairs:
      - "Platform ↔ ML: Wednesday 2 PM"
      - "Platform ↔ Pipeline: Wednesday 3 PM"
      - "Frontend ↔ API: Thursday 2 PM"
```

### Async Communication Standards

```yaml
# async-standards.yml
response_sla:
  slack_dm:
    expected: "4 hours (business hours)"
    urgent: "Use @mention + thread in #incidents"
    
  slack_channel:
    expected: "Same business day"
    threads: "Required for discussions >2 messages"
    
  email:
    expected: "24 hours"
    usage: "External communication, formal decisions only"
    
  github_pr:
    first_review: "4 hours (business hours)"
    follow_up: "2 hours"
    
  github_issue:
    triage: "Within 1 business day"
    response: "Within 2 business days"

thread_etiquette:
  - "Reply in thread, not new message"
  - "Use emoji reactions instead of '+1' messages"
  - "Summarize long threads before requesting action"
  - "Tag specific people, don't use @channel unless critical"
  
status_updates:
  - "Use Slack status for OOO, focus time, meetings"
  - "Post in #general for OOO >1 day"
  - "Update calendar for recurring unavailability"
```

### Documentation Standards — Scaled

```yaml
# documentation-standards.yml
required_docs:
  per_service:
    - README.md:
        contents:
          - "Service description (2-3 sentences)"
          - "Architecture diagram (Mermaid)"
          - "Quick start guide"
          - "Environment variables table"
          - "API endpoints (if applicable)"
          - "Runbooks link"
    - CHANGELOG.md:
        format: "Keep a Changelog"
        automation: "release-please"
    - docs/runbooks/:
        required:
          - "deployment.md"
          - "incident-response.md"
          - "rollback.md"
        optional:
          - "scaling.md"
          - "cost-optimization.md"
          
  per_team:
    - docs/team-playbook.md:
        contents:
          - "Team charter and mission"
          - "On-call rotation"
          - "Decision-making process"
          - "Cross-team interfaces"
          
  cross_team:
    - /docs/architecture/:
        - "system-overview.md"
        - "service-map.md"
        - "data-flow.md"
        - "security-model.md"
    - /docs/adr/:
        format: "ADR template"
        review: "Architecture review board"

api_documentation:
  format: "OpenAPI 3.1"
  location: "services/<name>/openapi.yml"
  generation: "Auto-generated from TypeScript types"
  hosting: "https://api-docs.miniop.com"
  versioning: "Match API version"
  
runbook_template:
  sections:
    - "Alert description"
    - "Impact assessment"
    - "Debugging steps"
    - "Mitigation procedures"
    - "Root cause analysis template"
    - "Prevention checklist"
```

### Incident Communication — Scaled

```yaml
# incident-communication.yml
severity_levels:
  p1:
    name: "Critical"
    description: "Service completely down, all users affected"
    response_time: "5 minutes"
    update_frequency: "Every 15 minutes"
    channels: ["#incidents", "PagerDuty", "Statuspage"]
    escalation: "VP Engineering after 30 min"
    
  p2:
    name: "Major"
    description: "Significant feature degraded, many users affected"
    response_time: "15 minutes"
    update_frequency: "Every 30 minutes"
    channels: ["#incidents", "PagerDuty"]
    escalation: "Team lead after 1 hour"
    
  p3:
    name: "Minor"
    description: "Non-critical feature issue, few users affected"
    response_time: "1 hour"
    update_frequency: "Every 2 hours"
    channels: ["#incidents"]
    escalation: "Team lead after 4 hours"

incident_channel_template: |
  🔴 **INCIDENT: [Title]**
  **Severity**: P1/P2/P3
  **Incident Commander**: @[name]
  **Status**: Investigating / Identified / Monitoring / Resolved
  
  **Impact**:
  - What's broken:
  - Who's affected:
  - Since when:
  
  **Timeline**:
  - [HH:MM] Incident detected
  - [HH:MM] IC assigned, investigating
  
  **Action Items**:
  - [ ] [Action 1]
  - [ ] [Action 2]

postmortem_template: |
  # Postmortem: [Incident Title]
  
  **Date**: YYYY-MM-DD
  **Duration**: X hours Y minutes
  **Severity**: P1/P2/P3
  **Incident Commander**: @[name]
  **Author**: @[name]
  
  ## Summary
  [2-3 sentence description]
  
  ## Impact
  - Users affected: X
  - Revenue impact: $X
  - Data loss: Yes/No
  
  ## Root Cause
  [Technical explanation]
  
  ## Timeline
  | Time | Event |
  |------|-------|
  | HH:MM | [Event] |
  
  ## What Went Well
  - [Item]
  
  ## What Went Wrong
  - [Item]
  
  ## Action Items
  | Action | Owner | Due | Status |
  |--------|-------|-----|--------|
  | [Action] | @[name] | YYYY-MM-DD | Open |
  
  ## Lessons Learned
  [Key takeaway]
```

### External Communication

```yaml
# external-communication.yml
channels:
  status_page:
    provider: "Instatus / Statuspage"
    url: "https://status.miniop.com"
    updates:
      - "Automated from PagerDuty incidents"
      - "Manual updates for maintenance"
    subscribers: "All users, auto-subscribe on signup"
    
  blog:
    url: "https://blog.miniop.com"
    frequency: "2-4 posts/month"
    content_types:
      - "Product updates"
      - "Engineering deep-dives"
      - "Open source announcements"
    review: "PM + eng lead approval"
    
  twitter:
    handle: "@miniop"
    frequency: "3-5 posts/week"
    content_types:
      - "Product tips"
      - "User spotlights"
      - "Engineering insights"
    review: "Growth lead manages"
    
  github:
    discussions: "Enabled for community Q&A"
    issues: "Bug reports and feature requests"
    releases: "Auto-generated from CHANGELOG"
    security_advisories: "Private reporting via SECURITY.md"
    
  email:
    product_updates: "Monthly newsletter"
    incident_notifications: "Auto-send for P1/P2"
    security_alerts: "Immediate for vulnerabilities"
```

### Communication Tools Integration

```yaml
# tools-integration.yml
slack:
  integrations:
    github:
      channels:
        "#deployments": ["deployment_status"]
        "#pr-reviews": ["pull_request", "pull_request_review"]
        "#issues": ["issues", "issue_comment"]
    
    pagerduty:
      channels:
        "#incidents": ["incident.triggered", "incident.resolved"]
    
    vercel:
      channels:
        "#deployments": ["deployment"]
    
    linear:
      channels:
        "#project-updates": ["issue_created", "issue_updated"]
    
    figma:
      channels:
        "#design": ["file_update"]
    
  workflows:
    incident_declaration:
      trigger: "React with 🔴 on any message"
      action: "Create incident thread, page on-call"
    
    pr_review_request:
      trigger: "PR opened with 'review-requested' label"
      action: "Post to #pr-reviews with reviewer assignment"
    
    deploy_success:
      trigger: "Vercel deployment success"
      action: "Post to #deployments with preview URL"
```

---

## Appendix: Communication Health Metrics

```yaml
# Track these monthly
metrics:
  response_times:
    slack_dm: "Avg time to first response"
    pr_review: "Avg time to first review"
    incident_ack: "Avg time to acknowledge"
    
  meeting_efficiency:
    attendance_rate: "> 90%"
    action_item_completion: "> 80%"
    meeting_nps: "Quarterly survey"
    
  documentation_freshness:
    readme_updates: "Updated within 30 days of last change"
    runbook_accuracy: "Tested quarterly"
    adr_completion: "All decisions >$500 impact documented"
    
  async_health:
    thread_usage: "% of discussions in threads"
    reaction_vs_reply: "Reactions / replies ratio"
    channel_noise: "Messages per channel per day"
```
