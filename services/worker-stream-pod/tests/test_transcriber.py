import os

import pytest

from worker_stream_pod.transcriber import Segment, FasterWhisperTranscriber, segments_from_raw

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "en_probe.wav")


class _RawSeg:
    def __init__(self, text, start, end, avg_logprob=-0.2, no_speech_prob=0.1):
        self.text = text
        self.start = start
        self.end = end
        self.avg_logprob = avg_logprob
        self.no_speech_prob = no_speech_prob


def test_segments_from_raw_offsets_and_maps():
    segs = segments_from_raw([_RawSeg("hi", 1.0, 2.5)], base_offset_ms=1000, no_speech_threshold=0.6)
    assert len(segs) == 1
    assert segs[0].text == "hi"
    assert segs[0].start_ms == 2000 and segs[0].end_ms == 3500
    assert segs[0].confidence == -0.2


def test_segments_from_raw_drops_high_no_speech_prob():
    raw = [_RawSeg("real", 0, 2, no_speech_prob=0.1), _RawSeg("Thanks for watching!", 2, 4, no_speech_prob=0.92)]
    segs = segments_from_raw(raw, base_offset_ms=0, no_speech_threshold=0.6)
    assert [s.text for s in segs] == ["real"]


def test_segments_from_raw_drops_empty_text():
    assert segments_from_raw([_RawSeg("   ", 0, 2)], base_offset_ms=0, no_speech_threshold=0.6) == []


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
