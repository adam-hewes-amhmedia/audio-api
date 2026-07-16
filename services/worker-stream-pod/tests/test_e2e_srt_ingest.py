"""End-to-end SRT listener ingest against a real encoder.

Marked slow: needs a real ffmpeg, so it stays out of the default lane. The unit
tests cover argv shape, which is not the same as proving libsrt accepts it. This
pushes real audio at the port the pod binds and checks decoded PCM comes out,
and that a wrong passphrase gets nothing.
"""
import asyncio
import shutil

import pytest

from worker_stream_pod.audio_source import FfmpegSource, Gap

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="ffmpeg not installed"
)

PASSPHRASE = "supersecret123"


async def _push(port: int, passphrase, *, delay: float = 0.8):
    """Stand in for a client's encoder: an ffmpeg SRT caller pushing tone."""
    await asyncio.sleep(delay)
    argv = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-re",
        "-f", "lavfi", "-i", "sine=frequency=1000:duration=6",
        "-c:a", "aac", "-f", "mpegts", "-mode", "caller",
    ]
    if passphrase:
        argv += ["-passphrase", passphrase]
    argv += [f"srt://127.0.0.1:{port}"]
    proc = await asyncio.create_subprocess_exec(*argv, stderr=asyncio.subprocess.DEVNULL)
    await proc.communicate()


async def _listen(port: int, passphrase, *, want: int, wait_s: float):
    src = FfmpegSource(
        source_kind="srt", source_url=f"srt://0.0.0.0:{port}",
        source_mode="listener", passphrase=passphrase, ingest_wait_s=wait_s,
    )
    frames = []
    try:
        async def recv():
            async for f in src.frames():
                frames.append(f)
                if len(frames) >= want:
                    src.terminate()
                    return
        await asyncio.wait_for(recv(), timeout=wait_s + 10)
    except Exception:
        pass
    finally:
        src.terminate()
    return frames


@pytest.mark.slow
@pytest.mark.asyncio
async def test_listener_receives_a_real_encrypted_push():
    pusher = asyncio.create_task(_push(9500, PASSPHRASE))
    frames = await _listen(9500, PASSPHRASE, want=10, wait_s=20)
    pusher.cancel()

    assert len(frames) >= 10
    # 100ms of 16kHz mono s16le, which is what the inference loop expects.
    assert all(len(f) == 3200 for f in frames)


@pytest.mark.slow
@pytest.mark.asyncio
async def test_listener_survives_a_real_encoder_drop_and_reconnect():
    """Kill an encoder mid-stream, start another, and keep the stream alive.

    This is the failure the whole reconnect loop exists for: ffmpeg's SRT
    listener accepts one connection, so before this a two-second drop ended a
    live broadcast permanently.
    """
    port = 9503
    src = FfmpegSource(
        source_kind="srt", source_url=f"srt://0.0.0.0:{port}",
        source_mode="listener", passphrase=PASSPHRASE,
        ingest_wait_s=25.0, reconnect_window_s=25.0, reconnect_backoff_s=0.5,
    )

    async def spawn_encoder():
        return await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-re",
            "-f", "lavfi", "-i", "sine=frequency=1000:duration=60",
            "-c:a", "aac", "-f", "mpegts", "-mode", "caller",
            "-passphrase", PASSPHRASE, f"srt://127.0.0.1:{port}",
            stderr=asyncio.subprocess.DEVNULL,
        )

    live = {"proc": await spawn_encoder()}
    stop = asyncio.Event()

    async def reconnecting_encoder():
        """A real encoder keeps dialling back until it gets in."""
        while not stop.is_set():
            live["proc"] = await spawn_encoder()
            await live["proc"].wait()
            if stop.is_set():
                return
            await asyncio.sleep(0.3)

    retrier = None
    frames, gaps = [], []
    try:
        async def recv():
            nonlocal retrier
            async for item in src.frames():
                if isinstance(item, Gap):
                    gaps.append(item)
                    continue
                frames.append(item)
                if len(frames) == 10 and retrier is None:
                    # Drop the encoder. ffmpeg has audio buffered, so frames keep
                    # arriving for a moment: the drop only bites once that drains
                    # and the listener sees EOF.
                    live["proc"].kill()
                    await live["proc"].wait()
                    retrier = asyncio.create_task(reconnecting_encoder())
                # Stop on evidence of recovery, not on a frame count, or the
                # buffered audio alone would satisfy the test.
                if gaps and len(frames) >= 10 + len(gaps) + 5:
                    src.terminate()
                    return
        await asyncio.wait_for(recv(), timeout=90)
    finally:
        stop.set()
        src.terminate()
        if retrier is not None:
            retrier.cancel()
        p = live.get("proc")
        if p is not None and p.returncode is None:
            p.kill()
            await p.wait()

    assert src.reconnects >= 1, "the listener never accepted the encoder back"
    assert src.end_reason is None, f"the stream ended on a drop: {src.end_reason}"
    assert gaps and gaps[0].ms > 0        # the outage is measured, so cues can be shifted
    # Audio flowed again after the reconnect, which is the whole point.
    assert len(frames) > 10


@pytest.mark.slow
@pytest.mark.asyncio
async def test_listener_admits_nobody_without_the_right_passphrase():
    # The passphrase is the only auth on an open inbound port, so this is the
    # test that proves the auth is real rather than decorative.
    wrong = asyncio.create_task(_push(9501, "WRONGPASSPHRASE9"))
    frames = await _listen(9501, PASSPHRASE, want=1, wait_s=6)
    wrong.cancel()
    assert frames == []

    unauth = asyncio.create_task(_push(9502, None))
    frames = await _listen(9502, PASSPHRASE, want=1, wait_s=6)
    unauth.cancel()
    assert frames == []
