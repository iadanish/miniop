# Virality Scoring Pipeline

## Overview

Virality scoring is the final ranking layer in MiniOp's AI pipeline. It takes the candidate clips produced by clip analysis and scene detection, and predicts which clips are most likely to perform well as short-form content on platforms like TikTok, YouTube Shorts, and Instagram Reels. The score combines content signals, visual signals, and platform-specific heuristics into a single 0-1 virality score.

This is not a magic number. It is a weighted aggregation of measurable signals that correlate with short-form content performance, trained on patterns observed in viral content.

## Score Architecture

```
Clip Candidates → Content Signals → Visual Signals → Platform Adjustments → Normalized Virality Score
```

The scoring pipeline operates in three tiers:
1. **Content Score** (0-1): What is being said and how
2. **Visual Score** (0-1): What is being shown and how it changes
3. **Platform Multiplier** (0.5-1.5): Adjustment for target platform characteristics

Final score: `virality = (content_score * 0.50 + visual_score * 0.35) * platform_multiplier`

## Content Signals

Content signals are derived from the transcript and represent the narrative quality of a clip.

### Hook Strength (First 3 Seconds)

The first 3 seconds of a short-form video determine whether a viewer scrolls past or stays. Analyze the opening text:

```python
import re

HOOK_PATTERNS = {
    "question": r"^(what|why|how|did you know|have you ever|can you)",
    "controversy": r"^(wrong|lie|myth|nobody talks about|unpopular opinion)",
    "urgency": r"(right now|just happened|breaking|just revealed)",
    "number": r"^(\d+|one|two|three|four|five|top \d+)",
    "story": r"(so i was|this happened|true story|let me tell you)",
    "challenge": r"(try this|watch this|i bet you|prove me wrong)",
    "emotional": r"(this changed everything|i can't believe|you won't believe)",
}

def hook_strength(first_text: str) -> float:
    text = first_text.lower().strip()
    if not text:
        return 0.0

    score = 0.0

    # Pattern matching
    for pattern_type, pattern in HOOK_PATTERNS.items():
        if re.search(pattern, text):
            score += 0.2

    # Length check: hooks should be short and punchy
    word_count = len(text.split())
    if word_count <= 8:
        score += 0.15
    elif word_count <= 15:
        score += 0.10
    elif word_count > 25:
        score -= 0.10

    # Question mark in first sentence
    if "?" in text[:100]:
        score += 0.15

    return min(max(score, 0.0), 1.0)
```

### Retention Architecture

Analyze the clip structure for retention-keeping patterns:

```python
def retention_score(text: str, segments: list[dict]) -> dict:
    sentences = re.split(r'[.!?]+', text)
    sentences = [s.strip() for s in sentences if len(s.strip()) > 3]

    if len(sentences) < 2:
        return {"score": 0.3, "pattern": "single_sentence"}

    # Cliffhanger detection: does the clip end mid-story?
    last_sentence = sentences[-1].lower()
    cliffhanger_words = {"but", "however", "then", "suddenly", "until", "and that's"}
    has_cliffhanger = any(last_sentence.startswith(w) for w in cliffhanger_words)
    ends_with_question = sentences[-1].rstrip().endswith("?")

    # Callback pattern: does the end reference the beginning?
    first_words = set(sentences[0].lower().split()[:5])
    last_words = set(sentences[-1].lower().split()[:5])
    callback = len(first_words & last_words) > 0

    # Pacing: variation in sentence length indicates good storytelling
    lengths = [len(s.split()) for s in sentences]
    avg_length = sum(lengths) / len(lengths)
    length_variance = sum((l - avg_length)**2 for l in lengths) / len(lengths)
    pacing_score = min(length_variance / 100, 1.0)

    # Build-up: does intensity increase?
    emotional_words = {"amazing", "terrible", "shocked", "incredible", "unbelievable",
                       "worst", "best", "insane", "crazy", "love", "hate", "never",
                       "always", "absolutely", "completely"}
    sentence_emotion = []
    for s in sentences:
        words = set(s.lower().split())
        sentence_emotion.append(len(words & emotional_words) / max(len(words), 1))

    # Check if emotion increases over time
    if len(sentence_emotion) >= 3:
        first_third = sum(sentence_emotion[:len(sentence_emotion)//3])
        last_third = sum(sentence_emotion[-(len(sentence_emotion)//3):])
        emotional_arc = last_third - first_third
    else:
        emotional_arc = 0

    score = (
        (0.25 if has_cliffhanger else 0.0)
        + (0.20 if ends_with_question else 0.0)
        + (0.15 if callback else 0.0)
        + pacing_score * 0.20
        + min(max(emotional_arc, 0), 1.0) * 0.20
    )

    pattern = "standard"
    if has_cliffhanger:
        pattern = "cliffhanger"
    elif ends_with_question:
        pattern = "open_loop"
    elif callback:
        pattern = "callback"

    return {"score": min(score, 1.0), "pattern": pattern}
```

### Quote Density

Self-contained, quotable phrases perform well because viewers screenshot and share them:

```python
def quote_density(text: str) -> float:
    sentences = re.split(r'[.!?]+', text)
    sentences = [s.strip() for s in sentences if len(s.strip()) > 5]

    if not sentences:
        return 0.0

    quotable = 0
    for s in sentences:
        words = s.split()

        # Ideal quote length: 5-15 words
        if 5 <= len(words) <= 15:
            quotable += 0.5

        # Contains strong opinion or statement
        opinion_markers = {"is", "are", "was", "never", "always", "must", "should"}
        if any(s.lower().startswith(m) for m in ["the truth is", "here's the thing", "the problem is"]):
            quotable += 0.3

        # Contains metaphor or comparison
        if " is the new " in s.lower() or " than " in s.lower():
            quotable += 0.2

    return min(quotable / len(sentences), 1.0)
```

## Visual Signals

Visual signals come from CLIP and FER outputs produced in the clip analysis stage.

```python
def visual_score(clip_data: dict) -> float:
    clip_relevance = clip_data.get("clip_relevance", {})
    emotion_data = clip_data.get("emotion_data", {})

    # Visual-text alignment (CLIP score)
    relevance = clip_relevance.get("avg_relevance", 0.0)

    # Visual dynamics (how much the video changes)
    dynamics = clip_relevance.get("visual_dynamics", 0.0)

    # Face detection rate (face-on-screen content performs better)
    face_timeline = emotion_data.get("timeline", [])
    if face_timeline:
        face_visible_ratio = len([f for f in face_timeline if f["confidence"] > 0.5]) / len(face_timeline)
    else:
        face_visible_ratio = 0.0

    # Emotional expressiveness
    emotion_intensity = emotion_data.get("emotional_intensity", 0.0)

    # Emotion variety (showing multiple emotions = more engaging)
    emotion_breakdown = emotion_data.get("emotion_breakdown", {})
    non_zero_emotions = sum(1 for v in emotion_breakdown.values() if v > 0.1)
    emotion_variety = min(non_zero_emotions / 4, 1.0)  # 4+ distinct emotions = max score

    score = (
        relevance * 0.25
        + min(dynamics * 3, 1.0) * 0.20
        + face_visible_ratio * 0.25
        + emotion_intensity * 0.20
        + emotion_variety * 0.10
    )

    return min(score, 1.0)
```

## Platform Multipliers

Different platforms reward different content characteristics. Apply a multiplier based on the target platform.

```python
PLATFORM_PROFILES = {
    "tiktok": {
        "preferred_duration": (15, 45),
        "hook_weight": 1.5,        # TikTok hooks are critical
        "question_bonus": 1.3,     # Questions drive comments
        "face_required": True,     # Face-on-camera is strongly preferred
        "music_compatible": True,
        "multiplier_range": (0.6, 1.5),
    },
    "youtube_shorts": {
        "preferred_duration": (30, 60),
        "hook_weight": 1.2,
        "question_bonus": 1.1,
        "face_required": False,
        "music_compatible": False,
        "multiplier_range": (0.7, 1.3),
    },
    "instagram_reels": {
        "preferred_duration": (15, 60),
        "hook_weight": 1.3,
        "question_bonus": 1.2,
        "face_required": True,
        "music_compatible": True,
        "multiplier_range": (0.65, 1.4),
    },
    "linkedin": {
        "preferred_duration": (30, 90),
        "hook_weight": 1.0,
        "question_bonus": 1.0,
        "face_required": True,
        "music_compatible": False,
        "multiplier_range": (0.8, 1.2),
    },
}

def platform_multiplier(
    clip: dict,
    platform: str = "tiktok",
) -> float:
    profile = PLATFORM_PROFILES[platform]
    multiplier = 1.0

    # Duration fit
    duration = clip["duration"]
    pref_min, pref_max = profile["preferred_duration"]
    if pref_min <= duration <= pref_max:
        multiplier *= 1.1
    elif duration < pref_min * 0.5 or duration > pref_max * 1.5:
        multiplier *= 0.7

    # Hook strength
    hook_score = clip.get("signals", {}).get("hook_strength", 0.0)
    multiplier *= (0.8 + hook_score * 0.4) * profile["hook_weight"]

    # Question presence
    if "?" in clip.get("text", ""):
        multiplier *= profile["question_bonus"]

    # Face requirement
    if profile["face_required"]:
        face_ratio = clip.get("signals", {}).get("face_visible_ratio", 0.0)
        if face_ratio < 0.3:
            multiplier *= 0.6
        elif face_ratio > 0.7:
            multiplier *= 1.1

    # Clamp to platform range
    min_mult, max_mult = profile["multiplier_range"]
    return max(min_mult, min(max_mult, multiplier))
```

## Full Scoring Pipeline

```python
def compute_virality_score(
    clip: dict,
    platform: str = "tiktok",
) -> dict:
    # Content signals
    text = clip.get("text", "")
    segments = clip.get("segments", [])

    hook = hook_strength(text.split(".")[0] + "." if "." in text else text)
    retention = retention_score(text, segments)
    quote = quote_density(text)

    content_score = (
        hook * 0.35
        + retention["score"] * 0.40
        + quote * 0.25
    )

    # Visual signals
    vis_score = visual_score(clip)

    # Platform adjustment
    plat_mult = platform_multiplier(clip, platform)

    # Final virality score
    raw_score = (content_score * 0.50 + vis_score * 0.35) * plat_mult
    virality = round(min(max(raw_score, 0.0), 1.0), 4)

    return {
        "clip_id": clip["clip_id"],
        "virality_score": virality,
        "platform": platform,
        "content_score": round(content_score, 4),
        "visual_score": round(vis_score, 4),
        "platform_multiplier": round(plat_mult, 4),
        "breakdown": {
            "hook_strength": round(hook, 4),
            "retention_score": round(retention["score"], 4),
            "retention_pattern": retention["pattern"],
            "quote_density": round(quote, 4),
        },
        "suggestions": generate_suggestions(hook, retention, quote, vis_score, platform),
    }
```

## Suggestion Generation

Provide actionable feedback for clips that score below threshold:

```python
def generate_suggestions(
    hook: float,
    retention: dict,
    quote: float,
    visual: float,
    platform: str,
) -> list[str]:
    suggestions = []

    if hook < 0.3:
        suggestions.append(
            "Weak hook. Start with a question, surprising fact, or bold claim "
            "in the first 3 seconds."
        )

    if retention["score"] < 0.4:
        suggestions.append(
            f"Low retention architecture ({retention['pattern']}). "
            "Add a callback to the beginning or end with a question/cliffhanger."
        )

    if quote < 0.3:
        suggestions.append(
            "Low quote density. The clip lacks self-contained memorable phrases. "
            "Consider trimming to the most impactful statement."
        )

    if visual < 0.3:
        suggestions.append(
            "Weak visual engagement. The video may be static or visually "
            "disconnected from the spoken content."
        )

    profile = PLATFORM_PROFILES[platform]
    if profile["face_required"] and visual < 0.5:
        suggestions.append(
            f"{platform} prefers face-on-camera content. "
            "Consider clips where the speaker is visible."
        )

    return suggestions
```

## Free Tier vs Production

| Component | Free Tier | Production |
|---|---|---|
| Scoring model | Rule-based (this document) | Fine-tuned XGBoost on labeled data |
| Platform profiles | 4 hardcoded | User-configurable via API |
| Training data | None | 100K+ labeled clips from platform APIs |
| Inference latency | <50ms per clip | <10ms per clip |
| A/B testing | No | Yes, via feature flags |
| Feedback loop | No | Clips tracked post-publish, scores adjusted |

## Production ML Model (Optional Upgrade)

When sufficient labeled data exists (clips with actual view counts), replace the rule-based scorer with a trained model:

```python
import xgboost as xgb
import numpy as np

def extract_features(clip: dict) -> np.ndarray:
    """Convert clip signals into a flat feature vector for XGBoost."""
    signals = clip.get("signals", {})

    return np.array([
        signals.get("hook_strength", 0),
        signals.get("retention_score", 0),
        signals.get("quote_density", 0),
        signals.get("transcript", 0),
        signals.get("visual_relevance", 0),
        signals.get("visual_dynamics", 0),
        signals.get("emotion_intensity", 0),
        signals.get("emotion_shifts", 0),
        signals.get("face_visible_ratio", 0),
        clip.get("duration", 0) / 90.0,  # Normalized
        clip.get("word_count", 0) / 500.0,
        1.0 if "?" in clip.get("text", "") else 0.0,
    ])

# Training
def train_virality_model(training_data: list[dict]) -> xgb.XGBRegressor:
    X = np.array([extract_features(c) for c in training_data])
    y = np.array([c["normalized_views"] for c in training_data])

    model = xgb.XGBRegressor(
        n_estimators=500,
        max_depth=6,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        reg_alpha=0.1,
        reg_lambda=1.0,
    )

    model.fit(X, y, eval_metric="rmse", verbose=50)
    return model

# Inference
def ml_virality_score(model: xgb.XGBRegressor, clip: dict) -> float:
    features = extract_features(clip).reshape(1, -1)
    raw_score = model.predict(features)[0]
    return float(np.clip(raw_score, 0, 1))
```

Deploy the trained model as a separate service:

```python
from fastapi import FastAPI
import xgboost as xgb

app = FastAPI()
model = xgb.XGBRegressor()
model.load_model("/models/virality_v3.json")

@app.post("/score")
async def score_clip(clip: dict):
    features = extract_features(clip).reshape(1, -1)
    score = float(model.predict(features)[0])
    return {
        "virality_score": round(min(max(score, 0), 1), 4),
        "model_version": "v3",
    }
```

## Calibration

The rule-based scorer's weights should be calibrated against actual platform performance data. Process:

1. Publish 100+ clips scored by the current system.
2. After 7 days, collect view/engagement metrics.
3. Compute Spearman correlation between virality_score and actual performance.
4. Adjust weights to maximize correlation.

Target: Spearman rho > 0.6 between predicted virality and actual view count percentile. Below 0.4, the model is not useful and should be replaced with the ML approach.

## API Integration

Production endpoint for scoring clips:

```python
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()

class ClipScoreRequest(BaseModel):
    clip_id: str
    text: str
    start: float
    end: float
    duration: float
    segments: list[dict]
    signals: dict
    platform: str = "tiktok"

class ClipScoreResponse(BaseModel):
    clip_id: str
    virality_score: float
    platform: str
    content_score: float
    visual_score: float
    platform_multiplier: float
    breakdown: dict
    suggestions: list[str]

@app.post("/api/v1/score", response_model=ClipScoreResponse)
async def score_clip_endpoint(request: ClipScoreRequest):
    if request.platform not in PLATFORM_PROFILES:
        raise HTTPException(400, f"Unknown platform: {request.platform}")

    result = compute_virality_score(request.dict(), request.platform)
    return ClipScoreResponse(**result)
```

## Weight Reference Table

| Signal | Weight in Content Score | Weight in Final Score | Why |
|---|---|---|---|
| Hook strength | 0.35 in content | 0.175 total | First 3 seconds decide scroll vs watch |
| Retention architecture | 0.40 in content | 0.200 total | Keeps viewers past the first drop-off point |
| Quote density | 0.25 in content | 0.125 total | Shareability drives organic reach |
| Visual-text alignment | 0.25 in visual | 0.0875 total | Mismatch confuses viewers |
| Visual dynamics | 0.20 in visual | 0.070 total | Static video loses attention |
| Face presence | 0.25 in visual | 0.0875 total | Human faces increase engagement 30-50% |
| Emotion intensity | 0.20 in visual | 0.070 total | Emotional content is shared more |
| Emotion variety | 0.10 in visual | 0.035 total | Range of emotion = more engaging |
