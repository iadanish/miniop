"""FFmpeg operations for video/audio processing."""

import asyncio
import os
import tempfile


async def extract_audio(
    video_path: str,
    output_path: str | None = None,
    sample_rate: int = 16000,
) -> str:
    """Extract audio from video as 16kHz mono WAV.

    Args:
        video_path: Path to input video file.
        output_path: Optional output path. If None, generates temp file.
        sample_rate: Output sample rate (default 16000 for ASR).

    Returns:
        Path to extracted audio file.
    """
    if output_path is None:
        output_path = tempfile.mktemp(suffix=".wav")

    cmd = [
        "ffmpeg",
        "-y",
        "-i", video_path,
        "-vn",
        "-acodec", "pcm_s16le",
        "-ar", str(sample_rate),
        "-ac", "1",
        "-f", "wav",
        output_path,
    ]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg audio extraction failed: {stderr.decode()}")

    return output_path


async def get_video_duration(video_path: str) -> float:
    """Get video duration in seconds using ffprobe.

    Args:
        video_path: Path to video file.

    Returns:
        Duration in seconds.
    """
    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        video_path,
    ]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        raise RuntimeError(f"FFprobe failed: {stderr.decode()}")

    return float(stdout.decode().strip())


async def extract_clip(
    video_path: str,
    output_path: str,
    start_time: float,
    end_time: float,
    add_captions: bool = False,
    caption_file: str | None = None,
) -> str:
    """Extract a clip from video with optional caption burn-in.

    Args:
        video_path: Path to input video.
        output_path: Path for output clip.
        start_time: Start time in seconds.
        end_time: End time in seconds.
        add_captions: Whether to burn in subtitles.
        caption_file: Path to ASS/SRT subtitle file.

    Returns:
        Path to extracted clip.
    """
    duration = end_time - start_time

    cmd = [
        "ffmpeg",
        "-y",
        "-ss", str(start_time),
        "-i", video_path,
        "-t", str(duration),
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
    ]

    if add_captions and caption_file:
        cmd.extend(["-vf", f"subtitles={caption_file}"])

    cmd.append(output_path)

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg clip extraction failed: {stderr.decode()}")

    return output_path
