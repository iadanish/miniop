"""MiMo-V2.5-ASR transcription service."""

import httpx
import os
from pydantic import BaseModel


class ASRSegment(BaseModel):
    id: int
    start: float
    end: float
    text: str
    no_speech_prob: float = 0.0


class ASRResult(BaseModel):
    language: str
    duration_seconds: float
    segments: list[ASRSegment]
    full_text: str


MIMO_ASR_URL = "https://api.xiaomimimo.com/v1/audio/transcriptions"


async def transcribe_audio(
    audio_path: str,
    api_key: str,
    language: str = "en",
) -> ASRResult:
    """Transcribe audio file using MiMo-V2.5-ASR API.

    Args:
        audio_path: Path to audio file (WAV, 16kHz mono recommended).
        api_key: User's MiMo API key.
        language: Language code (default: en).

    Returns:
        ASRResult with segments and full text.
    """
    async with httpx.AsyncClient(timeout=300.0) as client:
        with open(audio_path, "rb") as f:
            response = await client.post(
                MIMO_ASR_URL,
                headers={"Authorization": f"Bearer {api_key}"},
                files={"file": (os.path.basename(audio_path), f, "audio/wav")},
                data={"language": language, "response_format": "verbose_json"},
            )

        response.raise_for_status()
        data = response.json()

    segments = [
        ASRSegment(
            id=i,
            start=seg.get("start", 0.0),
            end=seg.get("end", 0.0),
            text=seg.get("text", ""),
            no_speech_prob=seg.get("no_speech_prob", 0.0),
        )
        for i, seg in enumerate(data.get("segments", []))
    ]

    full_text = " ".join(seg.text for seg in segments)
    duration = data.get("duration", segments[-1].end if segments else 0.0)

    return ASRResult(
        language=data.get("language", language),
        duration_seconds=duration,
        segments=segments,
        full_text=full_text,
    )
