import pytest

from worker_stream_pod.vad_gate import VadGate

# 100ms frames at 16kHz mono s16le = 1600 samples = 3200 bytes.
SPEECH = (b"\x10\x00") * 1600
SILENCE = (b"\x00\x00") * 1600


def rms_is_speech(frame: bytes) -> bool:
    return any(b != 0 for b in frame)


def test_commits_on_silence_boundary():
    g = VadGate(min_cue_ms=300, silence_hold_ms=200, max_cue_ms=8000, is_speech=rms_is_speech)
    signals = []
    for _ in range(5):                 # 500ms speech
        signals.append(g.push(SPEECH, 100))
    signals.append(g.push(SILENCE, 100))   # trailing 100ms < 200 hold
    signals.append(g.push(SILENCE, 100))   # trailing 200ms >= hold -> commit
    assert signals[-1] == "silence_boundary"
    assert "silence_boundary" not in signals[:-1]

    buf = g.commit()
    assert buf is not None
    pcm, start, end = buf
    assert start == 0 and end == 700
    assert len(pcm) == 7 * len(SPEECH)


def test_no_commit_before_min_cue_ms():
    g = VadGate(min_cue_ms=1000, silence_hold_ms=100, max_cue_ms=8000, is_speech=rms_is_speech)
    sigs = [g.push(SPEECH, 100), g.push(SILENCE, 100), g.push(SILENCE, 100)]
    assert all(s is None for s in sigs)   # buffer only 300ms, below min


def test_force_commit_on_max_window():
    g = VadGate(min_cue_ms=300, silence_hold_ms=200, max_cue_ms=300, is_speech=rms_is_speech)
    sigs = [g.push(SPEECH, 100), g.push(SPEECH, 100), g.push(SPEECH, 100)]
    assert sigs[-1] == "max_window"


def test_absolute_timestamps_across_commits():
    g = VadGate(min_cue_ms=100, silence_hold_ms=100, max_cue_ms=200, is_speech=rms_is_speech)
    g.push(SPEECH, 100); g.push(SPEECH, 100)   # 200ms -> max_window
    first = g.commit()
    g.push(SPEECH, 100); g.push(SPEECH, 100)
    second = g.commit()
    assert first[1] == 0 and first[2] == 200
    assert second[1] == 200 and second[2] == 400


def test_flush_returns_remaining_open_buffer():
    g = VadGate(min_cue_ms=300, silence_hold_ms=200, max_cue_ms=8000, is_speech=rms_is_speech)
    g.push(SPEECH, 100)
    assert g.open_buffer() is not None
    rem = g.flush()
    assert rem is not None and rem[2] == 100
    assert g.open_buffer() is None


def test_advance_commits_the_cut_off_cue_and_jumps_the_clock():
    g = VadGate(min_cue_ms=300, silence_hold_ms=200, max_cue_ms=8000, is_speech=rms_is_speech)
    for _ in range(5):                 # 500ms of speech, then the encoder drops
        g.push(SPEECH, 100)

    # The half-spoken cue must not be lost just because ingest died mid-word.
    cut = g.advance(30_000)
    assert cut is not None
    _pcm, start, end = cut
    assert (start, end) == (0, 500)
    assert g.open_buffer() is None

    # The clock is frame-counted, so without the jump every later cue would be
    # stamped 30s early and drift from the wall-clock caption TS timeline.
    g.push(SPEECH, 100)
    buf = g.open_buffer()
    assert buf is not None
    assert buf[1] == 30_500


def test_advance_with_nothing_buffered_still_jumps_the_clock():
    g = VadGate(min_cue_ms=300, silence_hold_ms=200, max_cue_ms=8000, is_speech=rms_is_speech)
    assert g.advance(5_000) is None
    g.push(SPEECH, 100)
    assert g.open_buffer()[1] == 5_000


def test_advance_does_not_run_the_speech_predicate():
    # push() runs Silero inline on the event loop, so a gap must never be
    # replayed as silence frames: a 60s outage would stall the heartbeat.
    calls = []

    def counting_is_speech(frame):
        calls.append(frame)
        return True

    g = VadGate(min_cue_ms=300, silence_hold_ms=200, max_cue_ms=8000, is_speech=counting_is_speech)
    g.push(SPEECH, 100)
    calls.clear()
    g.advance(60_000)
    assert calls == []


@pytest.mark.slow
def test_silero_default_predicate_classifies_silence_as_non_speech():
    from worker_stream_pod.vad_gate import make_silero_is_speech
    is_speech = make_silero_is_speech()
    assert is_speech(SILENCE) is False
