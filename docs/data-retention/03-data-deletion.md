# MiniOp Data Deletion Procedures

## Overview

Data deletion in MiniOp covers three scenarios: user-initiated deletion (GDPR Article 17 Right to Erasure), retention-policy automatic deletion, and administrative deletion for policy violations. Each scenario follows a different path through the system but converges on the same physical deletion pipeline. This document covers implementation details for both free-tier single-node and production multi-region deployments.

## Deletion Scenarios

| Scenario | Trigger | SLA | Scope |
|----------|---------|-----|-------|
| **User Account Deletion** | User clicks "Delete Account" in settings | 30 days (with grace period) | All user data across all classes |
| **Project Deletion** | User deletes a specific project | Immediate soft-delete, 7-day hard-delete | Source media, clips, metadata for that project |
| **GDPR Erasure Request** | User submits formal erasure request via API or support | 72 hours (legal requirement) | All personal data, including backups |
| **Retention Policy** | Automated daily job | Next scheduled run | Records exceeding retention period |
| **Admin Violation Deletion** | Admin action for TOS violation | Immediate | All data for the offending account |

## Free Tier Deletion Implementation

### Project Deletion

When a user deletes a project, the system performs a soft delete immediately and schedules a hard delete after 7 days:

```python
# services/deletion.py
import os
import psycopg2
from datetime import datetime, timedelta, timezone
from pathlib import Path

MEDIA_ROOT = Path("/var/minio-op/media")
DATABASE_URL = os.environ["DATABASE_URL"]

def soft_delete_project(user_id: str, project_id: str):
    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn.cursor() as cur:
            # Verify ownership
            cur.execute(
                "SELECT id FROM projects WHERE id = %s AND user_id = %s AND deleted_at IS NULL",
                (project_id, user_id)
            )
            if not cur.fetchone():
                raise ValueError("Project not found or already deleted")

            # Soft delete the project
            cur.execute(
                "UPDATE projects SET deleted_at = NOW() WHERE id = %s",
                (project_id,)
            )
            # Soft delete associated media
            cur.execute(
                "UPDATE source_media SET deleted_at = NOW() WHERE project_id = %s AND deleted_at IS NULL",
                (project_id,)
            )
            cur.execute(
                "UPDATE derived_clips SET deleted_at = NOW() WHERE project_id = %s AND deleted_at IS NULL",
                (project_id,)
            )
            # Schedule hard delete
            hard_delete_at = datetime.now(timezone.utc) + timedelta(days=7)
            cur.execute(
                "INSERT INTO deletion_queue (entity_type, entity_id, scheduled_at) VALUES (%s, %s, %s)",
                ("project", project_id, hard_delete_at)
            )
            conn.commit()
    finally:
        conn.close()

def hard_delete_project(project_id: str):
    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn.cursor() as cur:
            # Collect all file paths before deleting records
            cur.execute(
                "SELECT storage_path FROM source_media WHERE project_id = %s AND storage_path IS NOT NULL",
                (project_id,)
            )
            source_paths = [row[0] for row in cur.fetchall()]

            cur.execute(
                "SELECT storage_path FROM derived_clips WHERE project_id = %s AND storage_path IS NOT NULL",
                (project_id,)
            )
            clip_paths = [row[0] for row in cur.fetchall()]

            # Delete files from disk
            for path in source_paths + clip_paths:
                full_path = MEDIA_ROOT / path
                if full_path.exists():
                    full_path.unlink()

            # Delete database records
            cur.execute("DELETE FROM derived_clips WHERE project_id = %s", (project_id,))
            cur.execute("DELETE FROM source_media WHERE project_id = %s", (project_id,))
            cur.execute("DELETE FROM transcript_segments WHERE project_id = %s", (project_id,))
            cur.execute("DELETE FROM scene_analysis WHERE project_id = %s", (project_id,))
            cur.execute("DELETE FROM projects WHERE id = %s", (project_id,))

            # Remove from deletion queue
            cur.execute(
                "DELETE FROM deletion_queue WHERE entity_type = %s AND entity_id = %s",
                ("project", project_id)
            )
            conn.commit()
    finally:
        conn.close()
```

### Account Deletion

Account deletion cascades across all user data:

```python
def soft_delete_account(user_id: str):
    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn.cursor() as cur:
            # Get all user projects
            cur.execute("SELECT id FROM projects WHERE user_id = %s AND deleted_at IS NULL", (user_id,))
            project_ids = [row[0] for row in cur.fetchall()]

            # Soft delete all projects
            for pid in project_ids:
                soft_delete_project(user_id, pid)

            # Anonymize user record (keep for referential integrity)
            cur.execute(
                "UPDATE users SET "
                "email = %s, "
                "name = 'Deleted User', "
                "avatar_url = NULL, "
                "api_key = NULL, "
                "deleted_at = NOW() "
                "WHERE id = %s",
                (f"deleted-{user_id}@minioop.local", user_id)
            )
            conn.commit()
    finally:
        conn.close()
```

### Deletion Queue Processor

A background job processes the deletion queue:

```python
# services/deletion_worker.py
import psycopg2
from datetime import datetime, timezone

def process_deletion_queue():
    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, entity_type, entity_id FROM deletion_queue WHERE scheduled_at <= NOW()"
            )
            pending = cur.fetchall()

        for queue_id, entity_type, entity_id in pending:
            try:
                if entity_type == "project":
                    hard_delete_project(entity_id)
                elif entity_type == "account":
                    hard_delete_account(entity_id)
                print(f"[deletion] Hard deleted {entity_type} {entity_id}")
            except Exception as e:
                print(f"[deletion] Failed to delete {entity_type} {entity_id}: {e}")
                mark_deletion_failed(conn, queue_id, str(e))
    finally:
        conn.close()
```

## GDPR Erasure Implementation

GDPR erasure requires complete removal within 72 hours, including from backups. This is the most aggressive deletion path.

### GDPR Deletion Request API

```python
# api/routes/gdpr.py
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

router = APIRouter()

class GDPREraseRequest(BaseModel):
    confirmation: str  # User must type "DELETE MY DATA" to confirm
    reason: str | None = None

@router.post("/gdpr/erase")
async def request_gdpr_erasure(
    request: GDPREraseRequest,
    user: User = Depends(get_current_user)
):
    if request.confirmation != "DELETE MY DATA":
        raise HTTPException(400, "Confirmation text does not match")

    # Create GDPR erasure ticket
    ticket_id = create_gdpr_ticket(user.id, request.reason)

    # Queue immediate processing
    process_gdpr_erasure.delay(user.id, ticket_id)

    # Log the request for compliance audit
    log_audit_event("gdpr_erasure_requested", user_id=user.id, ticket_id=ticket_id)

    return {
        "ticket_id": ticket_id,
        "status": "processing",
        "estimated_completion": "72 hours",
        "message": "Your erasure request has been queued. You will receive confirmation when complete."
    }
```

### GDPR Erasure Worker

```python
# workers/gdpr/tasks.py
from celery import Celery
import boto3
from datetime import datetime, timezone

app = Celery("gdpr", broker="redis://redis:6379/3")

@app.task(queue="gdpr", bind=True, max_retries=3)
def process_gdpr_erasure(self, user_id: str, ticket_id: str):
    conn = get_db_connection()
    try:
        update_ticket_status(ticket_id, "in_progress")

        # 1. Delete from hot storage
        delete_user_source_media(conn, user_id)
        delete_user_derived_clips(conn, user_id)
        delete_user_metadata(conn, user_id)

        # 2. Delete from object storage (all regions)
        s3_delete_all_user_objects(user_id)

        # 3. Anonymize user record
        anonymize_user_record(conn, user_id)

        # 4. Delete from search indices
        delete_user_from_search_index(user_id)

        # 5. Delete from vector embeddings database
        delete_user_embeddings(user_id)

        # 6. Remove API keys and sessions
        revoke_all_api_keys(conn, user_id)
        invalidate_all_sessions(conn, user_id)

        # 7. Mark for backup scrubbing
        schedule_backup_scrub(user_id, ticket_id)

        update_ticket_status(ticket_id, "completed")
        send_erasure_confirmation(user_id, ticket_id)

        log_audit_event("gdpr_erasure_completed", user_id=user_id, ticket_id=ticket_id)

    except Exception as e:
        update_ticket_status(ticket_id, "failed", error=str(e))
        self.retry(exc=e, countdown=300)
    finally:
        conn.close()
```

### S3 Complete Object Deletion

GDPR requires deleting from all storage classes, including archived objects:

```python
def s3_delete_all_user_objects(user_id: str):
    s3 = boto3.client("s3")
    buckets = [
        "minioop-production-media",
        "minioop-production-meta",
        "minioop-production-temp",
    ]

    for bucket in buckets:
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket, Prefix=f"*/{user_id}/"):
            if "Contents" not in page:
                continue
            objects = [{"Key": obj["Key"]} for obj in page["Contents"]]
            if objects:
                # Delete in batches of 1000 (S3 limit)
                for i in range(0, len(objects), 1000):
                    s3.delete_objects(
                        Bucket=bucket,
                        Delete={"Objects": objects[i:i+1000], "Quiet": True}
                    )
```

### Backup Scrubbing

GDPR requires deletion from backups too. MiniOp marks deleted user IDs in a scrub list that the backup system processes on each backup rotation:

```python
# services/backup_scrub.py
SCRUB_LIST_KEY = "minioop:gdpr:scrub-list"

def schedule_backup_scrub(user_id: str, ticket_id: str):
    redis = get_redis_connection()
    redis.sadd(SCRUB_LIST_KEY, user_id)
    log_audit_event("backup_scrub_scheduled", user_id=user_id, ticket_id=ticket_id)

def scrub_backup(backup_file: str):
    redis = get_redis_connection()
    scrub_targets = redis.smembers(SCRUB_LIST_KEY)
    if not scrub_targets:
        return

    # For PostgreSQL logical backups (pg_dump format)
    # Filter out rows belonging to scrubbed users
    scrubbed_users = [uid.decode() for uid in scrub_targets]
    scrub_backup_file(backup_file, scrubbed_users)

def scrub_backup_file(backup_path: str, user_ids: list[str]):
    """Remove all rows belonging to scrubbed users from a SQL dump."""
    import re
    patterns = [re.compile(f"\\b{uid}\\b") for uid in user_ids]

    with open(backup_path, "r") as f:
        lines = f.readlines()

    with open(backup_path, "w") as f:
        for line in lines:
            if not any(p.search(line) for p in patterns):
                f.write(line)
```

## Production Deletion Pipeline

Production deletion runs through a Celery task pipeline with proper error handling and idempotency:

### Deletion Queue Schema

```sql
CREATE TABLE deletion_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type TEXT NOT NULL CHECK (entity_type IN ('project', 'account', 'gdpr')),
    entity_id UUID NOT NULL,
    user_id UUID NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    error_message TEXT,
    retry_count INT DEFAULT 0,
    max_retries INT DEFAULT 3,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

CREATE INDEX idx_deletion_queue_pending ON deletion_queue(scheduled_at) WHERE status = 'pending';
CREATE INDEX idx_deletion_queue_user ON deletion_queue(user_id);
```

### Idempotent Deletion

Deletion operations must be idempotent—running them twice must not fail or produce inconsistent state:

```python
def delete_user_source_media(conn, user_id: str):
    with conn.cursor() as cur:
        # Use RETURNING to get what we deleted (for file cleanup)
        cur.execute(
            "UPDATE source_media SET deleted_at = NOW(), storage_path = NULL "
            "WHERE user_id = %s AND deleted_at IS NULL "
            "RETURNING id, storage_path",
            (user_id,)
        )
        deleted = cur.fetchall()
        return deleted
```

## Deletion Verification

After deletion completes, verify the data is actually gone:

```python
@app.task(queue="verification")
def verify_deletion(user_id: str, ticket_id: str):
    conn = get_db_connection()
    try:
        # Check database
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM source_media WHERE user_id = %s AND deleted_at IS NULL", (user_id,))
            remaining_media = cur.fetchone()[0]

            cur.execute("SELECT COUNT(*) FROM projects WHERE user_id = %s AND deleted_at IS NULL", (user_id,))
            remaining_projects = cur.fetchone()[0]

        # Check object storage
        s3 = boto3.client("s3")
        remaining_objects = 0
        for bucket in ["minioop-production-media", "minioop-production-meta"]:
            paginator = s3.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=bucket, Prefix=f"*/{user_id}/"):
                remaining_objects += len(page.get("Contents", []))

        if remaining_media > 0 or remaining_projects > 0 or remaining_objects > 0:
            raise IncompleteDeletionError(
                f"Deletion incomplete: {remaining_media} media, "
                f"{remaining_projects} projects, {remaining_objects} objects remain"
            )

        update_ticket_status(ticket_id, "verified")
        log_audit_event("deletion_verified", user_id=user_id, ticket_id=ticket_id)

    finally:
        conn.close()
```

## Audit Logging for Deletions

All deletion actions are logged to an immutable audit table:

```sql
CREATE TABLE deletion_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID,
    user_id UUID NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id UUID,
    details JSONB,
    performed_by UUID NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- This table is append-only; no UPDATE or DELETE allowed
CREATE RULE deletion_audit_no_update AS ON UPDATE TO deletion_audit_log DO INSTEAD NOTHING;
CREATE RULE deletion_audit_no_delete AS ON DELETE TO deletion_audit_log DO INSTEAD NOTHING;
```

## User Notification

Users receive notifications at each stage of the deletion process:

```python
def send_deletion_notification(user_id: str, event: str, details: dict):
    templates = {
        "project_soft_deleted": {
            "subject": "Project scheduled for deletion",
            "body": "Your project '{project_name}' has been scheduled for deletion. "
                    "It will be permanently removed in 7 days. "
                    "You can restore it from the Trash folder before then."
        },
        "account_deletion_initiated": {
            "subject": "Account deletion in progress",
            "body": "Your account deletion request is being processed. "
                    "All your data will be permanently removed within 7 days."
        },
        "gdpr_erasure_completed": {
            "subject": "Data erasure completed",
            "body": "Your GDPR data erasure request (ticket {ticket_id}) has been completed. "
                    "All personal data has been removed from our systems."
        },
        "gdpr_erasure_failed": {
            "subject": "Data erasure requires attention",
            "body": "Your GDPR data erasure request (ticket {ticket_id}) encountered an issue. "
                    "Our team has been notified and will resolve this within 24 hours."
        },
    }

    template = templates[event]
    send_email(user_id, template["subject"], template["body"].format(**details))
```

## Emergency Deletion (Admin)

For policy violations requiring immediate deletion:

```bash
# Admin CLI command
minioop admin delete-user --user-id usr_abc123 --reason "TOS violation: spam" --immediate --confirm

# This bypasses the grace period and processes deletion synchronously
```

```python
@router.post("/admin/users/{user_id}/delete")
async def admin_delete_user(
    user_id: str,
    reason: str,
    admin: User = Depends(require_admin),
    immediate: bool = False
):
    if immediate:
        # Process synchronously
        process_gdpr_erasure(user_id, create_gdpr_ticket(user_id, reason))
    else:
        soft_delete_account(user_id)

    log_audit_event("admin_deletion", user_id=user_id, admin_id=admin.id, reason=reason)
    return {"status": "deleted" if immediate else "scheduled"}
```

## Compliance Reporting

Generate deletion compliance reports for auditors:

```sql
SELECT
    DATE_TRUNC('month', created_at) AS month,
    entity_type,
    COUNT(*) AS total_requests,
    COUNT(*) FILTER (WHERE status = 'completed') AS completed,
    COUNT(*) FILTER (WHERE status = 'failed') AS failed,
    AVG(EXTRACT(EPOCH FROM (processed_at - created_at)) / 3600) AS avg_hours_to_complete
FROM deletion_queue
WHERE entity_type = 'gdpr'
GROUP BY DATE_TRUNC('month', created_at), entity_type
ORDER BY month DESC;
```
