from pathlib import Path
import pytest

MIXED = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "audio" / "sample-mixed.wav"


@pytest.mark.skipif(not MIXED.exists(), reason="fixture missing")
def test_classify_mixed():
    from worker_dme_classify.classify import classify
    out = classify(str(MIXED), segment_ms=1000)
    assert "per_channel" in out
    ch0 = out["per_channel"][0]
    assert len(ch0["timeline"]) >= 1
    for seg in ch0["timeline"]:
        assert seg["tag"] in ("dialog", "music", "effects", "mixed", "silence")
        assert seg["start_ms"] < seg["end_ms"]
