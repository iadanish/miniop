"""Virality scoring algorithm for clip candidates."""

import re
from pydantic import BaseModel


class ClipScore(BaseModel):
    clip_id: str
    start: float
    end: float
    duration: float
    text: str
    hook_score: float
    retention_score: float
    quotability_score: float
    visual_score: float
    final_score: float
    platform_scores: dict[str, float]
    suggestions: list[str]


HOOK_PATTERNS = {
    "question": r"^(do you|have you|what if|why do|how do|can you|did you|is it)",
    "controversy": r"(unpopular opinion|hot take|the truth is|nobody talks about|everyone is wrong)",
    "urgency": r"(right now|today|before it's too late|stop doing|you need to|must watch)",
    "number": r"^\d+\s",
    "story": r"(let me tell you|so i was|i once|story time|this happened)",
    "challenge": r"(try this|challenge|dare you|bet you can't|prove me wrong)",
    "emotional": r"(i can't believe|shocking|amazing|incredible|unbelievable|insane)",
}

RETENTION_PATTERNS = {
    "cliffhanger": r"(but|however|then|suddenly|until|and that's|wait until)",
    "open_loop": r"\?$",
    "callback": r"(remember|like i said|as i mentioned|going back to)",
}

QUOTE_INDICATORS = [
    "the truth is",
    "here's the thing",
    "let me be clear",
    "at the end of the day",
    "the best advice",
    "what i learned",
    "the secret",
    "nobody tells you",
]


def score_hook(text: str) -> tuple[float, str]:
    """Score the opening hook strength.

    Returns:
        Tuple of (score, hook_type).
    """
    first_100 = text[:100].lower()

    for hook_type, pattern in HOOK_PATTERNS.items():
        if re.search(pattern, first_100, re.IGNORECASE):
            score = 0.8
            word_count = len(first_100.split())
            if word_count <= 8:
                score += 0.15
            elif word_count > 25:
                score -= 0.1
            return min(1.0, max(0.0, score)), hook_type

    return 0.3, "none"


def score_retention(text: str) -> float:
    """Score retention architecture."""
    score = 0.5
    sentences = re.split(r"[.!?]+", text)
    sentences = [s.strip() for s in sentences if s.strip()]

    if not sentences:
        return 0.3

    last_sentence = sentences[-1].lower()

    for pattern_type, pattern in RETENTION_PATTERNS.items():
        if re.search(pattern, last_sentence, re.IGNORECASE):
            score += 0.15

    if len(sentences) >= 3:
        lengths = [len(s.split()) for s in sentences]
        variance = sum((l - sum(lengths) / len(lengths)) ** 2 for l in lengths) / len(lengths)
        if variance > 5:
            score += 0.1

    if "?" in text:
        score += 0.05

    return min(1.0, max(0.0, score))


def score_quotability(text: str) -> float:
    """Score how quotable the content is."""
    score = 0.3
    text_lower = text.lower()

    for indicator in QUOTE_INDICATORS:
        if indicator in text_lower:
            score += 0.1

    sentences = re.split(r"[.!?]+", text)
    for sentence in sentences:
        words = sentence.strip().split()
        if 5 <= len(words) <= 15:
            score += 0.05

    return min(1.0, max(0.0, score))


PLATFORM_PROFILES = {
    "tiktok": {"preferred_duration": (15, 45), "hook_weight": 1.5, "face_required": True},
    "shorts": {"preferred_duration": (30, 60), "hook_weight": 1.2, "face_required": False},
    "reels": {"preferred_duration": (15, 60), "hook_weight": 1.3, "face_required": True},
    "linkedin": {"preferred_duration": (30, 90), "hook_weight": 1.0, "face_required": True},
}


def calculate_platform_scores(
    duration: float,
    hook_score: float,
    retention_score: float,
    quotability_score: float,
) -> dict[str, float]:
    """Calculate platform-specific scores."""
    scores = {}

    for platform, profile in PLATFORM_PROFILES.items():
        min_d, max_d = profile["preferred_duration"]
        if min_d <= duration <= max_d:
            duration_bonus = 1.0
        elif min_d - 10 <= duration <= max_d + 10:
            duration_bonus = 0.8
        else:
            duration_bonus = 0.5

        base = (hook_score * profile["hook_weight"] + retention_score + quotability_score) / 3
        scores[platform] = min(1.0, base * duration_bonus)

    return scores


def score_clip(
    clip_id: str,
    start: float,
    end: float,
    text: str,
    visual_score: float = 0.5,
) -> ClipScore:
    """Calculate comprehensive virality score for a clip candidate.

    Args:
        clip_id: Unique clip identifier.
        start: Start time in seconds.
        end: End time in seconds.
        text: Transcript text for this clip.
        visual_score: Visual quality score (0-1).

    Returns:
        ClipScore with all metrics.
    """
    duration = end - start

    hook, hook_type = score_hook(text)
    retention = score_retention(text)
    quotability = score_quotability(text)

    final = (
        hook * 0.35
        + retention * 0.40
        + quotability * 0.25
    )

    final = final * 0.65 + visual_score * 0.35

    if 30 <= duration <= 60:
        final *= 1.1
    elif duration < 15 or duration > 90:
        final *= 0.8

    final = min(1.0, max(0.0, final))

    platform_scores = calculate_platform_scores(duration, hook, retention, quotability)

    suggestions = []
    if hook < 0.5:
        suggestions.append("Strengthen the opening hook — start with a question or bold statement")
    if retention < 0.5:
        suggestions.append("Add cliffhangers or callbacks to improve retention")
    if quotability < 0.4:
        suggestions.append("Include more quotable phrases or memorable one-liners")

    return ClipScore(
        clip_id=clip_id,
        start=start,
        end=end,
        duration=duration,
        text=text,
        hook_score=hook,
        retention_score=retention,
        quotability_score=quotability,
        visual_score=visual_score,
        final_score=final,
        platform_scores=platform_scores,
        suggestions=suggestions,
    )
