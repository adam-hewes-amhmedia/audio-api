import subprocess
from pathlib import Path
import pytest
from worker_format.probe import probe, ProbeError

# Fixture lives at <repo>/tests/fixtures/audio/sample-stereo.wav (created in this task).
FIXTURE = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "audio" / "sample-stereo.wav"

@pytest.mark.skipif(not FIXTURE.exists(), reason="fixture not generated yet")
def test_probe_stereo():
    out = probe(str(FIXTURE))
    assert out["channel_count"] == 2
    assert out["channel_layout"] in ("stereo", "2 channels")
    assert out["sample_rate"] > 0

def test_probe_missing():
    with pytest.raises(ProbeError):
        probe("/no/such/file.wav")
