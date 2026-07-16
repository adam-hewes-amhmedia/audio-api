import asyncio

import pytest

from worker_stream_pod.worker import _config, start_caption_egress


_EGRESS_CFG = {"CAPTION_TS": True, "SRT_HOST": "0.0.0.0", "SRT_PORT": 11000}


class _FakeStdin:
    def __init__(self, *, raise_on_write=False, raise_on_drain=False):
        self._raise_on_write = raise_on_write
        self._raise_on_drain = raise_on_drain
        self.closed = False

    def is_closing(self):
        return False

    def write(self, data):
        if self._raise_on_write:
            raise BrokenPipeError("stdin write failed")

    async def drain(self):
        if self._raise_on_drain:
            raise ConnectionResetError("stdin drain failed")

    def close(self):
        self.closed = True


class _FakeProc:
    def __init__(self, stdin):
        self.stdin = stdin


def test_config_reads_caption_ts_flag(monkeypatch):
    for k, v in {
        "STREAM_ID": "s_x", "POD_ID": "p_x", "SOURCE_KIND": "hls",
        "SOURCE_URL": "https://e/x.m3u8", "POD_WS_PORT": "10000",
        "DATABASE_URL": "postgres://x", "POD_CAPTION_TS": "1",
        "POD_SRT_PORT": "11000",
    }.items():
        monkeypatch.setenv(k, v)
    cfg = _config()
    assert cfg["CAPTION_TS"] is True
    assert cfg["SRT_PORT"] == 11000
    assert cfg["SRT_HOST"] == "0.0.0.0"


def test_start_caption_egress_noop_when_caption_ts_disabled():
    cfg = {"CAPTION_TS": False, "SRT_HOST": "0.0.0.0", "SRT_PORT": 11000}
    proc, sink = asyncio.run(start_caption_egress(cfg))
    assert proc is None
    assert sink is None


def test_start_caption_egress_noop_when_srt_port_missing():
    cfg = {"CAPTION_TS": True, "SRT_HOST": "0.0.0.0", "SRT_PORT": None}
    proc, sink = asyncio.run(start_caption_egress(cfg))
    assert proc is None
    assert sink is None


@pytest.mark.asyncio
async def test_start_caption_egress_swallows_spawn_failure(monkeypatch):
    async def boom(*args, **kwargs):
        raise OSError("ffmpeg not found")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", boom)
    # Best-effort: an ffmpeg spawn failure must not raise and must disable the
    # caption output rather than break the stream.
    proc, sink = await start_caption_egress(dict(_EGRESS_CFG))
    assert proc is None
    assert sink is None


@pytest.mark.asyncio
async def test_egress_sink_swallows_write_failure(monkeypatch):
    fake_stdin = _FakeStdin(raise_on_write=True)
    fake_proc = _FakeProc(fake_stdin)

    async def fake_spawn(*args, **kwargs):
        return fake_proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_spawn)
    proc, sink = await start_caption_egress(dict(_EGRESS_CFG))
    assert proc is fake_proc
    assert sink is not None
    # A broken stdin pipe mid-stream must be swallowed by the sink closure the
    # production code returns, never propagated to the caption muxer.
    await sink(b"\x47" * 188)


@pytest.mark.asyncio
async def test_egress_sink_swallows_drain_failure(monkeypatch):
    fake_stdin = _FakeStdin(raise_on_drain=True)
    fake_proc = _FakeProc(fake_stdin)

    async def fake_spawn(*args, **kwargs):
        return fake_proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_spawn)
    proc, sink = await start_caption_egress(dict(_EGRESS_CFG))
    assert sink is not None
    await sink(b"\x47" * 188)
