"""The reconnect loop: encoders drop, and a drop must not end a live stream.

Drives FfmpegSource against a fake subprocess so the policy is deterministic and
needs no ffmpeg. The real thing is covered in the slow lane
(test_e2e_srt_ingest.py), which kills an actual encoder mid-stream.
"""
import asyncio

import pytest

from worker_stream_pod import audio_source
from worker_stream_pod.audio_source import FfmpegSource, Gap, SourceError

FRAME = b"\x01\x00" * 1600   # 100ms @ 16kHz mono s16le


class FakeStdout:
    """Serves `frames` frames, then EOF."""

    def __init__(self, frames):
        self._left = frames

    async def readexactly(self, n):
        if self._left <= 0:
            raise asyncio.IncompleteReadError(partial=b"", expected=n)
        self._left -= 1
        return FRAME


class FakeProc:
    def __init__(self, frames, rc=0):
        self.stdout = FakeStdout(frames)
        self.stderr = None
        self.returncode = None
        self._rc = rc
        self.killed = False

    def kill(self):
        self.killed = True
        self.returncode = self._rc

    async def wait(self):
        self.returncode = self._rc
        return self._rc


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def _patch_spawn(monkeypatch, procs, clock=None, spawn_gap_s=0.0):
    """Hand out `procs` in order, one per ffmpeg spawn."""
    handed = []

    async def fake_exec(*argv, **kwargs):
        if clock is not None:
            clock.t += spawn_gap_s      # time passes while the encoder is away
        if not procs:
            raise AssertionError("spawned more times than expected")
        p = procs.pop(0)
        handed.append(argv)
        return p

    monkeypatch.setattr(audio_source.asyncio, "create_subprocess_exec", fake_exec)
    return handed


async def _drain(src, limit=50):
    out = []
    async for item in src.frames():
        out.append(item)
        if len(out) >= limit:
            src.terminate()
            break
    return out


def _listener(**over):
    kwargs = dict(
        source_kind="srt", source_url="srt://0.0.0.0:9100", source_mode="listener",
        reconnect_window_s=60.0, reconnect_backoff_s=0.0,
    )
    kwargs.update(over)
    return FfmpegSource(**kwargs)


@pytest.mark.asyncio
async def test_listener_relistens_after_the_encoder_drops(monkeypatch):
    clock = FakeClock()
    # First encoder sends 2 frames then drops; the next one sends 2 more.
    _patch_spawn(monkeypatch, [FakeProc(2), FakeProc(2)], clock=clock, spawn_gap_s=3.0)
    src = _listener(now=clock)

    out = await _drain(src, limit=5)

    frames = [i for i in out if isinstance(i, bytes)]
    gaps = [i for i in out if isinstance(i, Gap)]
    assert len(frames) == 4, "stream ended instead of accepting the reconnect"
    assert len(gaps) == 1
    assert gaps[0].ms == 3000        # measured, so cues stay on wall clock
    assert src.reconnects == 1


@pytest.mark.asyncio
async def test_caller_redials_when_the_source_server_restarts(monkeypatch):
    clock = FakeClock()
    _patch_spawn(monkeypatch, [FakeProc(1), FakeProc(1)], clock=clock, spawn_gap_s=2.0)
    src = FfmpegSource(
        source_kind="srt", source_url="srt://e.example.com:9000", source_mode="caller",
        reconnect_window_s=60.0, reconnect_backoff_s=0.0, now=clock,
    )
    # The guard would block a dial-out to a test host; it is covered elsewhere.
    monkeypatch.setattr(audio_source, "assert_url_allowed", lambda *a, **k: None)

    out = await _drain(src, limit=3)
    assert len([i for i in out if isinstance(i, bytes)]) == 2
    assert src.reconnects == 1


@pytest.mark.asyncio
async def test_reconnect_gives_up_once_the_window_closes(monkeypatch):
    clock = FakeClock()
    # Encoder sends 2 frames, drops, and never returns: each respawn EOFs
    # immediately while the clock runs past the window.
    _patch_spawn(monkeypatch, [FakeProc(2)] + [FakeProc(0) for _ in range(20)],
                 clock=clock, spawn_gap_s=25.0)
    src = _listener(now=clock, reconnect_window_s=60.0)

    out = await _drain(src, limit=50)

    assert len([i for i in out if isinstance(i, bytes)]) == 2
    assert src.end_reason == "source_eof"   # ended, rather than waiting forever


@pytest.mark.asyncio
async def test_pull_sources_still_end_on_eof(monkeypatch):
    # For an mp4 or a finished live event, EOF is a legitimate end. Retrying it
    # would turn every normal finish into a stream that never ends.
    _patch_spawn(monkeypatch, [FakeProc(2)])
    monkeypatch.setattr(audio_source, "assert_url_allowed", lambda *a, **k: None)
    src = FfmpegSource(source_kind="hls", source_url="https://cdn.example.com/x.m3u8")

    out = await _drain(src, limit=10)
    assert len(out) == 2
    assert src.end_reason == "source_eof"
    assert src.reconnects == 0


@pytest.mark.asyncio
async def test_a_source_that_never_opens_is_not_retried(monkeypatch):
    # No frame ever arrived, so this is a bad source, not a dropped encoder.
    _patch_spawn(monkeypatch, [FakeProc(0)])
    src = _listener()

    with pytest.raises(SourceError):
        await _drain(src, limit=5)
    assert src.reconnects == 0


@pytest.mark.asyncio
async def test_relisten_waits_on_the_reconnect_window_not_the_ingest_wait(monkeypatch):
    clock = FakeClock()
    handed = _patch_spawn(monkeypatch, [FakeProc(1), FakeProc(1)], clock=clock, spawn_gap_s=1.0)
    src = _listener(now=clock, ingest_wait_s=300.0, reconnect_window_s=60.0)

    await _drain(src, limit=2)

    def listen_timeout(argv):
        return argv[argv.index("-listen_timeout") + 1]

    # First listen waits for someone to show up at all; a relisten only waits for
    # the encoder that was already here to come back.
    assert listen_timeout(handed[0]) == str(int(300 * 1_000_000))
    assert listen_timeout(handed[1]) == str(int(60 * 1_000_000))
