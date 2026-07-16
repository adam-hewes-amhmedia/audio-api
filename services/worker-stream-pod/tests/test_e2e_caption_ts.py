"""End-to-end structural check of the caption TS output.

Marked slow: needs real ffprobe on PATH, so it stays out of the default
lane. This proves the bytes we emit parse as a real MPEG-TS carrying our
data PID. It does not prove the captions decode; that needs the target
muxer or a known-good 708 decoder (see the plan's real-world caveat).
"""
import asyncio
import shutil
import subprocess
import time

import pytest

from worker_stream_pod.caption_ts_muxer import Caption708Muxer
from worker_stream_pod.cue_emitter import Cue
from worker_stream_pod.ts_mux import DATA_PID

pytestmark = pytest.mark.skipif(
    shutil.which("ffprobe") is None, reason="ffprobe not on PATH"
)


@pytest.mark.slow
@pytest.mark.asyncio
async def test_ts_stream_probes_as_valid_mpegts(tmp_path):
    chunks = []

    async def sink(b: bytes) -> None:
        chunks.append(b)

    mux = Caption708Muxer(sink=sink, now=time.time, fps=25, psi_interval_frames=5)
    mux.add(Cue(cue_id=1, start_ms=0, end_ms=1500, text="ROUND TRIP OK"))
    stop = asyncio.Event()

    async def stopper():
        await asyncio.sleep(0.5)
        stop.set()

    await asyncio.gather(mux.run(stop), stopper())

    data = b"".join(chunks)
    assert mux.frames_emitted > 0
    assert len(data) % 188 == 0
    assert all(data[i] == 0x47 for i in range(0, len(data), 188))

    ts_path = tmp_path / "cap.ts"
    ts_path.write_bytes(data)

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,id",
         "-of", "csv=p=0", str(ts_path)],
        capture_output=True, text=True,
    )
    assert probe.returncode == 0, f"ffprobe rejected the stream: {probe.stderr}"
    # ffprobe reports our 2038 PID as a data stream; ids print as hex.
    assert "data" in probe.stdout, f"no data stream found: {probe.stdout!r}"
    assert hex(DATA_PID) in probe.stdout.lower(), f"data PID missing: {probe.stdout!r}"
