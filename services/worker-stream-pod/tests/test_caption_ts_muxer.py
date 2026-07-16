import asyncio
import pytest

from worker_stream_pod.cue_emitter import Cue
from worker_stream_pod.caption_ts_muxer import Caption708Muxer


class FakeClock:
    def __init__(self):
        self.t = 1000.0
    def __call__(self):
        return self.t


@pytest.mark.asyncio
async def test_emits_frames_and_psi_even_when_idle():
    written = []
    clock = FakeClock()

    async def sink(b):
        written.append(b)

    mux = Caption708Muxer(sink=sink, now=clock, fps=25, psi_interval_frames=5)
    stop = asyncio.Event()

    async def advance():
        for _ in range(10):
            clock.t += 0.04
            await asyncio.sleep(0)
        stop.set()

    await asyncio.gather(mux.run(stop), advance())
    assert mux.frames_emitted >= 1
    assert b"".join(written).count(b"\x47") >= mux.frames_emitted  # TS packets present


def test_add_overflow_drops_oldest():
    mux = Caption708Muxer(sink=None, now=lambda: 0.0, queue_max=2)
    for i in range(5):
        mux.add(Cue(cue_id=i, start_ms=0, end_ms=1000, text=f"c{i}"))
    assert mux.dropped == 3
