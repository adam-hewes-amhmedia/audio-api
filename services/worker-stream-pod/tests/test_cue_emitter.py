import asyncio
from worker_stream_pod.cue_emitter import CueEmitter, StubCueSource


def test_stub_emits_one_cue_per_interval():
    src = StubCueSource(interval_ms=10, max_cues=3)
    em = CueEmitter(source=src)
    cues = asyncio.run(em.collect_all())
    assert len(cues) == 3
    assert cues[0].cue_id == 0
    assert cues[2].cue_id == 2
    assert all(c.text.startswith("[stub cue") for c in cues)
    for prev, nxt in zip(cues, cues[1:]):
        assert nxt.start_ms >= prev.end_ms
