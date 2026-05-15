from pathlib import Path
import pytest

SPEECH = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "audio" / "sample-speech.wav"


@pytest.mark.skipif(not SPEECH.exists(), reason="fixture missing")
def test_detect_english_speech():
    from worker_language.detect import detect
    out = detect(str(SPEECH))
    assert len(out["per_channel"]) >= 1
    ch0 = out["per_channel"][0]
    assert ch0["language"] in ("en", "und")
    assert 0.0 <= ch0["confidence"] <= 1.0
