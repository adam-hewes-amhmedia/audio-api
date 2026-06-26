import asyncio

from worker_stream_pod.cue_assembler import CueAssembler
from worker_stream_pod.transcriber import Segment


class FakeGate:
    """Deterministic VadGate stand-in. `signals` is aligned to push() calls:
    each entry is None, 'silence_boundary', or 'max_window'."""

    def __init__(self, signals):
        self._signals = list(signals)
        self._i = 0
        self._buf = bytearray()
        self._start = 0
        self._end = 0

    def push(self, frame, frame_ms):
        self._buf += frame
        self._end += frame_ms
        sig = self._signals[self._i] if self._i < len(self._signals) else None
        self._i += 1
        return sig

    def open_buffer(self):
        if not self._buf:
            return None
        return (bytes(self._buf), self._start, self._end)

    def commit(self):
        if not self._buf:
            return None
        res = (bytes(self._buf), self._start, self._end)
        self._buf = bytearray()
        self._start = self._end
        return res

    def flush(self):
        return self.commit()


class FakeTranscriber:
    """Returns one scripted Segment per call unless `segments_per_call` overrides."""

    def __init__(self, segments_per_call=1):
        self.calls = []
        self.segments_per_call = segments_per_call

    def transcribe(self, pcm, *, base_offset_ms):
        self.calls.append(base_offset_ms)
        out = []
        for k in range(self.segments_per_call):
            base = base_offset_ms + k * 40
            out.append(Segment(
                text=f"en@{base}",
                source_text=f"fr@{base}",
                start_ms=base,
                end_ms=base + 30,
                confidence=0.9,
            ))
        return out


async def _afeed(frames):
    for f in frames:
        yield f


def _run(assembler, frames):
    async def go():
        return [item async for item in assembler.run(_afeed(frames))]
    return asyncio.run(go())


def test_interim_cadence_and_commit_then_flush():
    gate = FakeGate(signals=[None, None, "silence_boundary", None, None])
    tx = FakeTranscriber()
    asm = CueAssembler(gate=gate, transcriber=tx, interim_interval_ms=100, frame_ms=100)
    out = _run(asm, [b"S0", b"S1", b"S2", b"S3", b"S4"])

    finals = [c for c, is_final in out if is_final]
    interims = [c for c, is_final in out if not is_final]

    # commit after 3 frames + flush of the trailing 2 frames => 2 finalised cues
    assert len(finals) == 2
    assert [c.cue_id for c in finals] == [0, 1]
    # finalised timestamps are non-overlapping and ordered
    for prev, nxt in zip(finals, finals[1:]):
        assert nxt.start_ms >= prev.end_ms
    # interim cues were emitted on the 100ms cadence while a buffer was open
    assert len(interims) >= 2
    assert all(c.cue_id is not None for c in interims)


def test_force_commit_on_max_window():
    gate = FakeGate(signals=[None, "max_window"])
    tx = FakeTranscriber()
    asm = CueAssembler(gate=gate, transcriber=tx, interim_interval_ms=10_000, frame_ms=100)
    out = _run(asm, [b"S0", b"S1"])
    finals = [c for c, is_final in out if is_final]
    assert len(finals) == 1


def test_multiple_segments_per_commit_get_sequential_ids():
    gate = FakeGate(signals=["silence_boundary"])
    tx = FakeTranscriber(segments_per_call=3)
    asm = CueAssembler(gate=gate, transcriber=tx, interim_interval_ms=10_000, frame_ms=100)
    out = _run(asm, [b"S0"])
    finals = [c for c, is_final in out if is_final]
    assert [c.cue_id for c in finals] == [0, 1, 2]
    assert finals[0].text == "en@0"


def test_open_buffer_is_flushed_to_a_final_at_end_of_stream():
    # No commit signal: the trailing audio must still be finalised on stream end.
    gate = FakeGate(signals=[None, None])
    tx = FakeTranscriber()
    asm = CueAssembler(gate=gate, transcriber=tx, interim_interval_ms=10_000, frame_ms=100)
    out = _run(asm, [b"S0", b"S1"])
    finals = [c for c, is_final in out if is_final]
    assert len(finals) == 1


def test_drops_finalised_cues_shorter_than_min_cue_ms():
    # FakeTranscriber emits 30ms segments; with a 100ms floor they are dropped.
    gate = FakeGate(signals=["silence_boundary"])
    tx = FakeTranscriber()
    asm = CueAssembler(gate=gate, transcriber=tx, interim_interval_ms=10_000, frame_ms=100, min_cue_ms=100)
    out = _run(asm, [b"S0"])
    assert [c for c, is_final in out if is_final] == []


def test_keeps_cues_at_or_above_min_cue_ms_with_sequential_ids():
    gate = FakeGate(signals=["silence_boundary"])
    tx = FakeTranscriber(segments_per_call=3)  # 30ms each
    # min below the segment length keeps them; ids stay sequential
    asm = CueAssembler(gate=gate, transcriber=tx, interim_interval_ms=10_000, frame_ms=100, min_cue_ms=20)
    out = _run(asm, [b"S0"])
    finals = [c for c, is_final in out if is_final]
    assert [c.cue_id for c in finals] == [0, 1, 2]


def test_empty_flush_emits_no_extra_final():
    # The only frame is committed by the signal, so flush() is empty -> no extra cue.
    gate = FakeGate(signals=["silence_boundary"])
    tx = FakeTranscriber()
    asm = CueAssembler(gate=gate, transcriber=tx, interim_interval_ms=10_000, frame_ms=100)
    out = _run(asm, [b"S0"])
    finals = [c for c, is_final in out if is_final]
    assert len(finals) == 1
