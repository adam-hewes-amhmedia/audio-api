import os

import pytest

from worker_stream_pod.transcriber import Segment, FasterWhisperTranscriber

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "en_probe.wav")


def _load_pcm_bytes(path: str) -> bytes:
    import soundfile as sf
    data, sr = sf.read(path, dtype="int16")
    assert sr == 16000
    return data.tobytes()


@pytest.mark.slow
def test_transcribes_speech_and_offsets_timestamps():
    pcm = _load_pcm_bytes(FIXTURE)
    t = FasterWhisperTranscriber("small", device="cpu", compute_type="int8")
    base = 1000
    cues = t.transcribe(pcm, base_offset_ms=base)

    assert isinstance(cues, list) and len(cues) >= 1
    assert all(isinstance(c, Segment) for c in cues)

    text = " ".join(c.text for c in cues).lower()
    assert any(tok in text for tok in ["terminal", "approach", "gap"]), text

    # timestamps are shifted onto the stream timeline by base_offset_ms
    assert all(c.start_ms >= base for c in cues)
    assert all(c.end_ms >= c.start_ms for c in cues)
