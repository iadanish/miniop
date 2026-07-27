"""Test the scoring and clip generation pipeline."""

from app.services.scorer import score_clip
from app.services.processor import generate_clip_candidates
from app.services.mimo_asr import ASRSegment


def test_scorer():
    result = score_clip(
        "test_0", 10.0, 55.0,
        "Do you know what happens when you mix acid and base? "
        "The truth is, it is amazing. Here is the thing about chemistry."
    )
    print(f"Score: {result.final_score:.2f}")
    print(f"  Hook: {result.hook_score:.2f}")
    print(f"  Retention: {result.retention_score:.2f}")
    print(f"  Quotability: {result.quotability_score:.2f}")
    print(f"  Platforms: {result.platform_scores}")
    print(f"  Suggestions: {result.suggestions}")
    assert result.final_score > 0
    print("  PASS: scorer works\n")


def test_clip_candidates():
    segments = [
        ASRSegment(id=0, start=0.0, end=5.0, text="Hello everyone."),
        ASRSegment(id=1, start=5.0, end=12.0, text="Today we are going to talk about something amazing."),
        ASRSegment(id=2, start=12.0, end=20.0, text="The truth is, most people do not know this."),
        ASRSegment(id=3, start=20.0, end=30.0, text="Let me show you how it works step by step."),
        ASRSegment(id=4, start=30.0, end=45.0, text="And that is why this matters for everyone watching."),
    ]
    candidates = generate_clip_candidates(segments, 45.0)
    print(f"Generated {len(candidates)} clip candidates")
    for c in candidates:
        print(f"  {c['start']:.1f}s - {c['end']:.1f}s ({c['duration']:.1f}s)")
    assert len(candidates) > 0
    print("  PASS: clip candidates work\n")


def test_backend_health():
    import httpx
    resp = httpx.get("http://localhost:8000/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "healthy"
    print("  PASS: backend health OK\n")


def test_backend_root():
    import httpx
    resp = httpx.get("http://localhost:8000/")
    assert resp.status_code == 200
    data = resp.json()
    assert data["version"] == "0.2.0"
    print("  PASS: backend root OK\n")


if __name__ == "__main__":
    print("=== MiniOp Pipeline Tests ===\n")

    test_scorer()
    test_clip_candidates()
    test_backend_health()
    test_backend_root()

    print("=== All tests passed ===")
