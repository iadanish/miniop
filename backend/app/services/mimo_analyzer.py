"""MiMo-V2.5-Pro content analysis service."""

import httpx
from pydantic import BaseModel


class AnalysisResult(BaseModel):
    hook_score: float
    retention_score: float
    quotability_score: float
    virality_score: float
    hook_type: str
    suggestions: list[str]
    summary: str


MIMO_CHAT_URL = "https://api.xiaomimimo.com/v1/chat/completions"

ANALYSIS_PROMPT = """You are a viral content analyst for short-form video. Analyze this transcript and return a JSON object with:

1. hook_score (0-1): How strong is the opening hook? Does it grab attention immediately?
2. retention_score (0-1): Does the content maintain interest throughout? Are there cliffhangers, callbacks, or pacing that keeps viewers?
3. quotability_score (0-1): Are there memorable, shareable quotes or phrases?
4. virality_score (0-1): Overall viral potential combining all factors.
5. hook_type: One of "question", "controversy", "urgency", "number", "story", "challenge", "emotional", or "none"
6. suggestions: Array of 2-3 specific improvements to make clips more viral.
7. summary: One-sentence summary of the video's main message.

Return ONLY valid JSON, no markdown.

Transcript:
{transcript}"""


async def analyze_transcript(
    transcript: str,
    api_key: str,
    model: str = "mimo-v2.5-pro",
) -> AnalysisResult:
    """Analyze transcript content using MiMo-V2.5-Pro.

    Args:
        transcript: Full transcript text.
        api_key: User's MiMo API key.
        model: Model to use (mimo-v2.5-pro or mimo-v2.5-pro-ultraspeed).

    Returns:
        AnalysisResult with scores and suggestions.
    """
    prompt = ANALYSIS_PROMPT.format(transcript=transcript[:8000])

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            MIMO_CHAT_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.3,
                "max_tokens": 1000,
            },
        )

        response.raise_for_status()
        data = response.json()

    content = data["choices"][0]["message"]["content"]

    import json

    try:
        result = json.loads(content)
    except json.JSONDecodeError:
        result = {
            "hook_score": 0.5,
            "retention_score": 0.5,
            "quotability_score": 0.5,
            "virality_score": 0.5,
            "hook_type": "none",
            "suggestions": ["Unable to parse analysis"],
            "summary": "Analysis parse failed",
        }

    return AnalysisResult(
        hook_score=min(1.0, max(0.0, result.get("hook_score", 0.5))),
        retention_score=min(1.0, max(0.0, result.get("retention_score", 0.5))),
        quotability_score=min(1.0, max(0.0, result.get("quotability_score", 0.5))),
        virality_score=min(1.0, max(0.0, result.get("virality_score", 0.5))),
        hook_type=result.get("hook_type", "none"),
        suggestions=result.get("suggestions", []),
        summary=result.get("summary", ""),
    )


async def generate_captions(
    transcript_segments: list[dict],
    api_key: str,
    model: str = "mimo-v2.5-pro",
    style: str = "engaging",
) -> list[dict]:
    """Generate engaging captions from transcript segments.

    Args:
        transcript_segments: List of {start, end, text} dicts.
        api_key: User's MiMo API key.
        model: Model to use.
        style: Caption style (engaging, professional, funny).

    Returns:
        List of {start, end, caption} dicts.
    """
    segments_text = "\n".join(
        f"[{s['start']:.1f}s - {s['end']:.1f}s] {s['text']}"
        for s in transcript_segments[:50]
    )

    prompt = f"""Rewrite these video transcript segments into engaging {style} captions for short-form video.
Keep captions concise (max 15 words per line), punchy, and readable.
Return a JSON array of objects with "start", "end", and "caption" keys.

{segments_text}

Return ONLY valid JSON array, no markdown."""

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            MIMO_CHAT_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.5,
                "max_tokens": 3000,
            },
        )

        response.raise_for_status()
        data = response.json()

    content = data["choices"][0]["message"]["content"]

    import json

    try:
        captions = json.loads(content)
    except json.JSONDecodeError:
        captions = [
            {"start": s["start"], "end": s["end"], "caption": s["text"]}
            for s in transcript_segments
        ]

    return captions
