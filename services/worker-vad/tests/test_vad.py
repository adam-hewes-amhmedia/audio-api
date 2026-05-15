from pathlib import Path
import pytest

FIXTURE = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "audio" / "sample-speech.wav"


@pytest.mark.skipif(not FIXTURE.exists(), reason="fixture missing")
def test_analyse_returns_per_channel():
    from worker_vad.vad import analyse
    out = analyse(str(FIXTURE))
    assert "per_channel" in out
    assert len(out["per_channel"]) >= 1
    ch0 = out["per_channel"][0]
    assert "speech_ratio" in ch0
    assert 0.0 <= ch0["speech_ratio"] <= 1.0
    assert len(ch0["segments"]) >= 1
