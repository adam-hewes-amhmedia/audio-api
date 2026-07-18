import asyncio
import os

import pytest

from worker_stream_pod import worker as worker_mod
from worker_stream_pod.worker import start_video_preview


_PREVIEW_CFG = {
    "HLS_PORT": 10100,
    "HLS_HOST": "0.0.0.0",
    "SOURCE_KIND": "hls",
    "SOURCE_URL": "https://cdn/x.m3u8",
    "SOURCE_HEADERS": {},
}


class _FakeProc:
    def __init__(self):
        self.terminated = False
        self.killed = False
        self.waited = False

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True

    async def wait(self):
        self.waited = True


@pytest.mark.asyncio
async def test_start_video_preview_cleans_up_proc_and_dir_when_serve_hls_fails(monkeypatch, tmp_path):
    fake_dir = tmp_path / "hls_fake"
    fake_dir.mkdir()
    fake_proc = _FakeProc()

    monkeypatch.setattr(worker_mod.tempfile, "mkdtemp", lambda prefix=None: str(fake_dir))

    async def fake_spawn(*args, **kwargs):
        return fake_proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_spawn)

    async def boom_serve_hls(*args, **kwargs):
        raise OSError("address already in use")

    monkeypatch.setattr(worker_mod, "serve_hls", boom_serve_hls)

    proc, server, hls_dir = await start_video_preview(dict(_PREVIEW_CFG))

    assert (proc, server, hls_dir) == (None, None, None)
    # The spawned ffmpeg must not be left running unsupervised.
    assert fake_proc.terminated is True
    assert fake_proc.waited is True
    # The tempdir created for the abandoned preview must not leak on disk.
    assert not os.path.exists(fake_dir)
