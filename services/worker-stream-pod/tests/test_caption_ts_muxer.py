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


# The pop-on lifecycle lives in `_triplets_for_tick(elapsed_ms)`, the caption
# state machine. We drive it directly and deterministically: it is a pure
# function of the queue, `_clear_at_ms` and the passed `elapsed_ms`, whereas the
# async `run()` loop couples the state transitions to a real wall-clock
# `asyncio.sleep`, so it cannot be stepped tick-by-tick without real time
# passing. Testing the state machine directly is the intended seam.
#
# Stable signatures (from cea708.py): a pop-on caption always contains the 608
# Resume Caption Loading marker (0, 0x14, 0x20); a clear always contains the 608
# Erase Displayed Memory marker (0, 0x14, 0x2C).
_RCL = (0, 0x14, 0x20)   # cea708 pop-on signature
_EDM = (0, 0x14, 0x2C)   # cea708 clear signature


def test_promote_returns_popon_once_then_padding():
    mux = Caption708Muxer(sink=None, now=lambda: 0.0)
    mux.add(Cue(cue_id=1, start_ms=0, end_ms=1000, text="HELLO"))

    # First tick after add: the caption is promoted to the screen.
    promoted = mux._triplets_for_tick(0.0)
    assert _RCL in promoted            # pop-on caption, not padding
    assert promoted != []

    # Promote-once: the same caption is not re-sent on the next tick before its
    # clear time; the decoder holds it, so this tick is padding-only.
    assert mux._triplets_for_tick(40.0) == []


def test_clear_fires_once_at_scheduled_time():
    mux = Caption708Muxer(sink=None, now=lambda: 0.0)
    mux.add(Cue(cue_id=1, start_ms=0, end_ms=1000, text="HELLO"))
    mux._triplets_for_tick(0.0)        # promote; clear scheduled at 0 + 1000ms

    # Before the clear time: still padding.
    assert mux._triplets_for_tick(500.0) == []

    # At/after the clear time: the clear fires exactly once.
    cleared = mux._triplets_for_tick(1000.0)
    assert _EDM in cleared             # erase-displayed-memory clear
    # Subsequent idle ticks are padding-only (clear does not repeat).
    assert mux._triplets_for_tick(1040.0) == []


def test_new_cue_replaces_current_before_clear():
    mux = Caption708Muxer(sink=None, now=lambda: 0.0)
    mux.add(Cue(cue_id=1, start_ms=0, end_ms=1000, text="FIRST"))
    mux._triplets_for_tick(0.0)        # promote A; clear scheduled at 1000ms

    # B arrives before A's clear time.
    mux.add(Cue(cue_id=2, start_ms=0, end_ms=500, text="SECOND"))
    replaced = mux._triplets_for_tick(200.0)
    # The tick returns B's pop-on (a fresh hidden buffer flip replaces A on
    # screen), not A's clear.
    assert _RCL in replaced
    assert _EDM not in replaced
    # The clear time is rescheduled off B's duration: 200 + (500 - 0) = 700ms.
    assert mux._clear_at_ms == 700.0


def test_idle_returns_padding():
    mux = Caption708Muxer(sink=None, now=lambda: 0.0)
    # Empty queue, no pending clear: keepalive padding (caller pads to a CDP).
    assert mux._triplets_for_tick(0.0) == []
    assert mux._triplets_for_tick(1000.0) == []
