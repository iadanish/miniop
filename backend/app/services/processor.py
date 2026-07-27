"""Main video processing pipeline."""

import os
import tempfile
import uuid
from typing import Optional, Callable, Awaitable

from .ffmpeg import extract_audio, get_video_duration, extract_clip
from .mimo_asr import transcribe_audio
from .mimo_analyzer import analyze_transcript, generate_captions
from .scorer import score_clip


class ProcessingError(Exception):
    pass


async def process_video_full(
    video_path: str,
    api_key: str,
    video_id: str,
    user_id: str,
    on_progress: Optional[Callable[[str, float], Awaitable[None]]] = None,
) -> dict:
    """Run the full processing pipeline on a video.

    Steps:
        1. Get video duration
        2. Extract audio
        3. Transcribe with MiMo-ASR
        4. Analyze with MiMo-Pro
        5. Generate clip candidates
        6. Score clips
        7. Generate captions
        8. Return results

    Args:
        video_path: Path to downloaded video file.
        api_key: User's MiMo API key.
        video_id: Supabase video ID.
        user_id: Supabase user ID.
        on_progress: Optional callback(step: str, progress: float).

    Returns:
        Dict with transcription, analysis, and scored clips.
    """
    results = {}

    async def progress(step: str, pct: float):
        if on_progress:
            await on_progress(step, pct)

    try:
        await progress("duration", 0.05)
        duration = await get_video_duration(video_path)
        results["duration"] = duration

        await progress("audio", 0.1)
        audio_path = tempfile.mktemp(suffix=".wav")
        await extract_audio(video_path, audio_path)

        await progress("transcribe", 0.2)
        asr_result = await transcribe_audio(audio_path, api_key)
        results["transcription"] = {
            "language": asr_result.language,
            "duration_seconds": asr_result.duration_seconds,
            "segments": [seg.model_dump() for seg in asr_result.segments],
            "full_text": asr_result.full_text,
        }

        os.unlink(audio_path)

        await progress("analyze", 0.5)
        analysis = await analyze_transcript(asr_result.full_text, api_key)
        results["analysis"] = {
            "hook_score": analysis.hook_score,
            "retention_score": analysis.retention_score,
            "quotability_score": analysis.quotability_score,
            "virality_score": analysis.virality_score,
            "hook_type": analysis.hook_type,
            "suggestions": analysis.suggestions,
            "summary": analysis.summary,
        }

        await progress("clips", 0.7)
        clips = generate_clip_candidates(asr_result.segments, duration)
        results["candidates"] = clips

        await progress("score", 0.8)
        scored_clips = []
        for i, clip in enumerate(clips):
            scored = score_clip(
                clip_id=f"{video_id}_{i}",
                start=clip["start"],
                end=clip["end"],
                text=clip["text"],
            )
            scored_clips.append(scored.model_dump())

        scored_clips.sort(key=lambda c: c["final_score"], reverse=True)
        results["clips"] = scored_clips[:20]

        await progress("captions", 0.9)
        top_clips = scored_clips[:5]
        for clip in top_clips:
            clip_segments = [
                s for s in asr_result.segments
                if s.start >= clip["start"] and s.end <= clip["end"]
            ]
            if clip_segments:
                captions = await generate_captions(
                    [s.model_dump() for s in clip_segments],
                    api_key,
                )
                clip["captions"] = captions

        await progress("done", 1.0)

        return results

    except Exception as e:
        raise ProcessingError(f"Pipeline failed: {str(e)}") from e


def generate_clip_candidates(
    segments: list,
    total_duration: float,
    min_duration: float = 15.0,
    max_duration: float = 90.0,
    target_duration: float = 45.0,
) -> list[dict]:
    """Generate clip candidates from transcript segments.

    Groups consecutive segments into windows aligned to sentence boundaries.

    Args:
        segments: List of ASR segments with start, end, text.
        total_duration: Total video duration.
        min_duration: Minimum clip duration.
        max_duration: Maximum clip duration.
        target_duration: Target clip duration.

    Returns:
        List of clip candidates with start, end, text.
    """
    candidates = []

    if not segments:
        return candidates

    for i in range(len(segments)):
        accumulated_text = ""
        start_time = segments[i].start

        for j in range(i, len(segments)):
            seg = segments[j]
            accumulated_text += " " + seg.text
            current_duration = seg.end - start_time

            if current_duration > max_duration:
                break

            if current_duration >= min_duration:
                text = accumulated_text.strip()

                is_sentence_end = any(
                    text.rstrip().endswith(p) for p in [".", "!", "?", "!", '"']
                )
                is_long_enough = current_duration >= target_duration * 0.8

                if is_sentence_end or is_long_enough or current_duration >= target_duration:
                    candidates.append({
                        "start": start_time,
                        "end": seg.end,
                        "duration": current_duration,
                        "text": text,
                    })

    seen = set()
    unique_candidates = []
    for c in candidates:
        key = (round(c["start"], 1), round(c["end"], 1))
        if key not in seen:
            seen.add(key)
            unique_candidates.append(c)

    return unique_candidates
