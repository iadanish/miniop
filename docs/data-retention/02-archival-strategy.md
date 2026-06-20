# MiniOp Archival Strategy

## Overview

MiniOp's archival strategy moves data from hot storage to cheaper, colder tiers as it ages. This reduces cost while preserving data for compliance, analytics, and potential user re-engagement. The strategy differs significantly between free tier (single-node, local disk) and production (multi-region object storage with tiered classes).

## Storage Tier Architecture

| Tier | Storage Class | Latency | Cost (per GB/mo) | Use Case |
|------|---------------|---------|------------------|----------|
| **Hot** | S3 Standard / Local SSD | < 100ms | $0.023 | Active projects, recent uploads |
| **Warm** | S3 Standard-IA | < 500ms | $0.0125 | Completed projects, 30-90 days old |
| **Cold** | S3 Glacier Instant Retrieval | < minutes | $0.004 | Archived projects, 90-365 days old |
| **Deep Cold** | S3 Glacier Deep Archive | 12-48 hours | $0.00099 | Legal holds, long-term compliance |

Free tier uses only Hot (local SSD) with a manual export option for archival.

## Free Tier Archival

Free-tier users have 10 GB of storage. When approaching the limit, MiniOp offers a "Download & Archive" feature that bundles project data into a ZIP file the user downloads locally.

### Export Script

```python
# services/archive_export.py
import zipfile
import json
from pathlib import Path
from datetime import datetime, timezone

MEDIA_ROOT = Path("/var/minio-op/media")

def export_project(project_id: str, output_dir: Path) -> Path:
    conn = get_db_connection()
    try:
        # Gather all media files for the project
        source_files = fetch_source_media(conn, project_id)
        clip_files = fetch_derived_clips(conn, project_id)
        metadata = fetch_project_metadata(conn, project_id)

        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        zip_name = f"minioop-export-{project_id}-{timestamp}.zip"
        zip_path = output_dir / zip_name

        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            # Add source media
            for f in source_files:
                file_path = MEDIA_ROOT / f["storage_path"]
                if file_path.exists():
                    zf.write(file_path, f"source/{file_path.name}")

            # Add derived clips
            for f in clip_files:
                file_path = MEDIA_ROOT / f["storage_path"]
                if file_path.exists():
                    zf.write(file_path, f"clips/{file_path.name}")

            # Add metadata as JSON
            zf.writestr("metadata/project.json", json.dumps(metadata, indent=2))
            zf.writestr("metadata/clips.json", json.dumps(clip_files, indent=2))
            zf.writestr("metadata/transcript.json", json.dumps(
                fetch_transcript(conn, project_id), indent=2
            ))

        return zip_path
    finally:
        conn.close()
```

### CLI Export Command

Free-tier self-hosted users can export via the CLI:

```bash
minioop archive export --project-id proj_abc123 --output ~/archives/
```

After export, the user can optionally delete the project from MiniOp to free up storage:

```bash
minioop archive export --project-id proj_abc123 --output ~/archives/ --delete-after-export
```

## Production Tiered Archival

Production archival uses S3 lifecycle transitions to move objects between storage classes automatically. The application layer tags each object with metadata at upload time, and lifecycle rules use these tags to determine transition timing.

### Upload Tagging

When a file is uploaded, the API server tags it with the project ID and creation timestamp:

```python
# services/storage.py
import boto3
from datetime import datetime, timezone

s3 = boto3.client("s3")
BUCKET = "minioop-production-media"

def upload_source_media(user_id: str, project_id: str, file_key: str, data: bytes):
    s3.put_object(
        Bucket=BUCKET,
        Key=f"source-media/{user_id}/{project_id}/{file_key}",
        Body=data,
        Tagging=f"user_id={user_id}&project_id={project_id}&data_class=source_media",
        Metadata={
            "user-id": user_id,
            "project-id": project_id,
            "uploaded-at": datetime.now(timezone.utc).isoformat(),
        },
        ServerSideEncryption="aws:kms",
        StorageClass="STANDARD",
    )
```

### Lifecycle Transition Rules

The lifecycle configuration transitions objects through tiers based on age:

```json
{
  "Rules": [
    {
      "ID": "source-media-tiering",
      "Filter": { "Prefix": "source-media/" },
      "Status": "Enabled",
      "Transitions": [
        { "Days": 30, "StorageClass": "STANDARD_IA" },
        { "Days": 90, "StorageClass": "GLACIER_IR" },
        { "Days": 365, "StorageClass": "DEEP_ARCHIVE" }
      ],
      "NoncurrentVersionTransitions": [
        { "NoncurrentDays": 7, "StorageClass": "STANDARD_IA" }
      ]
    },
    {
      "ID": "derived-clips-tiering",
      "Filter": { "Prefix": "derived-clips/" },
      "Status": "Enabled",
      "Transitions": [
        { "Days": 30, "StorageClass": "STANDARD_IA" },
        { "Days": 90, "StorageClass": "GLACIER_IR" }
      ]
    },
    {
      "ID": "temp-uploads-no-archive",
      "Filter": { "Prefix": "temp-uploads/" },
      "Status": "Enabled",
      "Expiration": { "Days": 1 }
    }
  ]
}
```

Apply to multiple buckets if using region-specific storage:

```bash
for BUCKET in minioop-media-us-east minioop-media-eu-west minioop-media-ap-south; do
  aws s3api put-bucket-lifecycle-configuration \
    --bucket "$BUCKET" \
    --lifecycle-configuration file://s3-lifecycle.json
done
```

### Archive Metadata Database

Track the archival state of each object in PostgreSQL so the application knows where to fetch from:

```sql
CREATE TABLE archive_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    object_key TEXT NOT NULL UNIQUE,
    bucket TEXT NOT NULL,
    current_storage_class TEXT NOT NULL DEFAULT 'STANDARD',
    last_transition_at TIMESTAMPTZ,
    source_created_at TIMESTAMPTZ NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id),
    project_id UUID NOT NULL REFERENCES projects(id),
    data_class TEXT NOT NULL,
    legal_hold BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_archive_registry_class ON archive_registry(current_storage_class);
CREATE INDEX idx_archive_registry_user ON archive_registry(user_id, project_id);
```

Update the registry when S3 sends transition events via EventBridge:

```python
# workers/archive_sync/handlers.py
def handle_storage_class_transition(event: dict):
    bucket = event["detail"]["bucket"]["name"]
    key = event["detail"]["object"]["key"]
    new_class = event["detail"]["object"]["storage-class"]

    conn = get_db_connection()
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE archive_registry SET current_storage_class = %s, last_transition_at = NOW() "
            "WHERE object_key = %s AND bucket = %s",
            (new_class, key, bucket)
        )
    conn.commit()
    conn.close()
```

## Restoring Archived Data

When a user accesses a project that contains cold or deep-archive objects, MiniOp initiates a restore request. For Glacier IR, retrieval is synchronous (milliseconds). For Glacier Deep Archive, retrieval takes 12-48 hours, so the user sees a "Preparing your project..." status.

```python
# services/archive_restore.py
import boto3
from botocore.exceptions import ClientError

s3 = boto3.client("s3")

RESTORE_TIER = {
    "GLACIER_IR": "Standard",
    "DEEP_ARCHIVE": "Standard",
}

def request_restore(bucket: str, key: str, storage_class: str) -> dict:
    try:
        response = s3.restore_object(
            Bucket=bucket,
            Key=key,
            RestoreRequest={
                "Days": 7,
                "GlacierJobParameters": {
                    "Tier": RESTORE_TIER.get(storage_class, "Standard")
                }
            }
        )
        return {"status": "restore_initiated", "response": response}
    except ClientError as e:
        if e.response["Error"]["Code"] == "RestoreAlreadyInProgress":
            return {"status": "already_restoring"}
        raise

def check_restore_status(bucket: str, key: str) -> str:
    response = s3.head_object(Bucket=bucket, Key=key)
    restore = response.get("Restore", "")
    if 'ongoing-request="true"' in restore:
        return "in_progress"
    elif 'ongoing-request="false"' in restore:
        return "completed"
    return "not_restoring"
```

### API Endpoint for Restore

```python
# api/routes/projects.py
from fastapi import APIRouter, HTTPException

router = APIRouter()

@router.post("/projects/{project_id}/restore")
async def restore_project(project_id: str, user: User = Depends(get_current_user)):
    archived_objects = get_archived_objects(user.id, project_id)
    if not archived_objects:
        return {"status": "nothing_to_restore"}

    pending = []
    for obj in archived_objects:
        if obj["current_storage_class"] in ("GLACIER_IR", "DEEP_ARCHIVE"):
            result = request_restore(obj["bucket"], obj["object_key"], obj["current_storage_class"])
            pending.append({"key": obj["object_key"], "status": result["status"]})

    if any(p["status"] == "restore_initiated" for p in pending):
        return {"status": "restore_initiated", "objects": pending, "estimated_time": estimate_restore_time(pending)}

    return {"status": "all_available", "objects": pending}
```

## Multi-Region Archive Replication

For production deployments serving multiple regions, archive data to the region closest to the user to minimize restore latency:

```python
REGION_BUCKET_MAP = {
    "us-east": "minioop-archive-us-east",
    "eu-west": "minioop-archive-eu-west",
    "ap-south": "minioop-archive-ap-south",
}

def get_archive_bucket(user_region: str) -> str:
    return REGION_BUCKET_MAP.get(user_region, REGION_BUCKET_MAP["us-east"])
```

Cross-region replication is configured at the S3 level:

```bash
aws s3api put-bucket-replication \
  --bucket minioop-archive-us-east \
  --replication-configuration '{
    "Role": "arn:aws:iam::ACCOUNT:role/minioop-replication",
    "Rules": [{
      "Status": "Enabled",
      "Prefix": "",
      "Destination": {
        "Bucket": "arn:aws:s3:::minioop-archive-eu-west",
        "StorageClass": "GLACIER_IR"
      }
    }]
  }'
```

## Cost Monitoring

Track archival costs per user and per storage class:

```sql
CREATE VIEW storage_costs AS
SELECT
    u.id AS user_id,
    u.email,
    ar.current_storage_class,
    COUNT(*) AS object_count,
    SUM(pg_column_size(ar)) / 1048576.0 AS registry_size_mb,
    CASE ar.current_storage_class
        WHEN 'STANDARD' THEN COUNT(*) * 0.023
        WHEN 'STANDARD_IA' THEN COUNT(*) * 0.0125
        WHEN 'GLACIER_IR' THEN COUNT(*) * 0.004
        WHEN 'DEEP_ARCHIVE' THEN COUNT(*) * 0.00099
    END AS estimated_monthly_cost
FROM archive_registry ar
JOIN users u ON u.id = ar.user_id
GROUP BY u.id, u.email, ar.current_storage_class;
```

## Archive Integrity Checks

Run weekly integrity verification to detect corruption or missing objects:

```python
@app.task(queue="maintenance")
def verify_archive_integrity(batch_size: int = 1000):
    conn = get_db_connection()
    cursor = conn.cursor(name="archive_cursor")  # server-side cursor for large datasets
    cursor.execute("SELECT id, object_key, bucket FROM archive_registry WHERE legal_hold = FALSE")

    s3 = boto3.client("s3")
    missing = []
    corrupted = []

    for record in iter_cursor(cursor, batch_size):
        try:
            response = s3.head_object(Bucket=record["bucket"], Key=record["object_key"])
            stored_etag = get_stored_etag(conn, record["id"])
            if stored_etag and response["ETag"] != stored_etag:
                corrupted.append(record)
        except ClientError as e:
            if e.response["Error"]["Code"] == "404":
                missing.append(record)

    if missing or corrupted:
        alert_archive_integrity_issue(missing, corrupted)

    cursor.close()
    conn.close()
    return {"missing": len(missing), "corrupted": len(corrupted)}
```

## Archival Policy Changes

When adjusting tier transition timings:

1. Update the S3 lifecycle configuration.
2. Run `aws s3api put-bucket-lifecycle-configuration` to apply.
3. Existing objects will transition at the next lifecycle evaluation (up to 24 hours).
4. If shortening the hot-tier window, manually transition objects that now exceed the new threshold:

```bash
# Transition objects older than 30 days that are still in STANDARD
aws s3 ls s3://minioop-production-media/source-media/ --recursive | \
  awk '{print $1, $2, $4}' | \
  while read date time key; do
    age=$(( ($(date +%s) - $(date -d "$date" +%s)) / 86400 ))
    if [ "$age" -gt 30 ]; then
      aws s3 cp "s3://minioop-production-media/$key" "s3://minioop-production-media/$key" \
        --storage-class STANDARD_IA
    fi
  done
```
