"""Video processing API routes."""

import asyncio
import tempfile
import os

from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel

from ..services.processor import process_video_full, ProcessingError
from ..services.ffmpeg import get_video_duration

router = APIRouter(prefix="/api/v1", tags=["processing"])


class ProcessRequest(BaseModel):
    video_id: str
    user_id: str
    storage_key: str
    api_key: str


class ProcessResponse(BaseModel):
    status: str
    video_id: str
    message: str


async def download_video_from_r2(storage_key: str) -> str:
    """Download video from R2 to temp file."""
    import boto3
    from ..config import settings

    s3 = boto3.client(
        "s3",
        endpoint_url=f"https://{settings.r2_account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key,
    )

    ext = os.path.splitext(storage_key)[1] or ".mp4"
    tmp = tempfile.mktemp(suffix=ext)

    s3.download_file(settings.r2_bucket_name, storage_key, tmp)
    return tmp


async def run_processing_job(
    video_id: str,
    user_id: str,
    storage_key: str,
    api_key: str,
):
    """Background task to process a video."""
    import httpx
    from ..config import settings

    video_path = None
    try:
        # Update job status to running
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{settings.supabase_url}/rest/v1/rpc/update_job_status",
                json={"p_video_id": video_id, "p_status": "running"},
                headers={
                    "apikey": settings.supabase_service_role_key,
                    "Authorization": f"Bearer {settings.supabase_service_role_key}",
                },
            )

        # Download video from R2
        video_path = await download_video_from_r2(storage_key)

        # Run the full pipeline
        results = await process_video_full(
            video_path=video_path,
            api_key=api_key,
            video_id=video_id,
            user_id=user_id,
        )

        # Store results in Supabase
        await store_results(video_id, user_id, results)

    except Exception as e:
        # Update job status to failed
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{settings.supabase_url}/rest/v1/rpc/update_job_status",
                json={"p_video_id": video_id, "p_status": "failed", "p_error": str(e)},
                headers={
                    "apikey": settings.supabase_service_role_key,
                    "Authorization": f"Bearer {settings.supabase_service_role_key}",
                },
            )
    finally:
        if video_path and os.path.exists(video_path):
            os.unlink(video_path)


async def store_results(video_id: str, user_id: str, results: dict):
    """Store processing results in Supabase."""
    import httpx
    from ..config import settings

    headers = {
        "apikey": settings.supabase_service_role_key,
        "Authorization": f"Bearer {settings.supabase_service_role_key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }

    # Store transcription
    transcription_data = {
        "video_id": video_id,
        "user_id": user_id,
        "language": results["transcription"]["language"],
        "duration_seconds": results["transcription"]["duration_seconds"],
        "segments": results["transcription"]["segments"],
        "full_text": results["transcription"]["full_text"],
    }

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{settings.supabase_url}/rest/v1/transcriptions",
            json=transcription_data,
            headers=headers,
        )
        transcription_id = resp.json().get("id") if resp.status_code == 201 else None

    # Update video with analysis and transcription
    video_update = {
        "status": "done",
        "duration_seconds": int(results["duration"]),
        "analysis": results["analysis"],
    }
    if transcription_id:
        video_update["transcription_id"] = transcription_id

    async with httpx.AsyncClient() as client:
        await client.patch(
            f"{settings.supabase_url}/rest/v1/videos?id=eq.{video_id}",
            json=video_update,
            headers=headers,
        )

    # Store clips
    clips_data = []
    for clip in results.get("clips", []):
        clips_data.append({
            "video_id": video_id,
            "user_id": user_id,
            "title": f"Clip at {int(clip['start'] // 60)}:{int(clip['start'] % 60):02d}",
            "start_time": clip["start"],
            "end_time": clip["end"],
            "virality_score": clip["final_score"],
            "hook_score": clip["hook_score"],
            "retention_score": clip["retention_score"],
            "quotability_score": clip["quotability_score"],
            "platform_scores": clip["platform_scores"],
            "suggestions": clip.get("suggestions", []),
            "status": "done",
        })

    if clips_data:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{settings.supabase_url}/rest/v1/clips",
                json=clips_data,
                headers=headers,
            )

    # Update job status to completed
    async with httpx.AsyncClient() as client:
        await client.post(
            f"{settings.supabase_url}/rest/v1/rpc/update_job_status",
            json={"p_video_id": video_id, "p_status": "completed"},
            headers=headers,
        )


@router.post("/process", response_model=ProcessResponse)
async def start_processing(request: ProcessRequest, background_tasks: BackgroundTasks):
    """Start video processing pipeline."""
    background_tasks.add_task(
        run_processing_job,
        video_id=request.video_id,
        user_id=request.user_id,
        storage_key=request.storage_key,
        api_key=request.api_key,
    )

    return ProcessResponse(
        status="queued",
        video_id=request.video_id,
        message="Processing started",
    )
