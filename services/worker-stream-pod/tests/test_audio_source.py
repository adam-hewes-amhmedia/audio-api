import asyncio
import os
import shutil

import pytest

from worker_stream_pod.audio_source import FfmpegSource, SourceError

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "en_probe.wav").replace("\\", "/")

# These drive a real ffmpeg subprocess; skip where the binary is unavailable.
pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


async def _collect(src, n):
    out = []
    async for f in src.frames():
        out.append(f)
        if len(out) >= n:
            src.terminate()
            break
    return out


def test_build_argv_includes_headers_and_format():
    src = FfmpegSource(
        source_kind="hls",
        source_url="https://cdn.example.com/x.m3u8",
        headers={"Authorization": "Bearer secret"},
    )
    argv = src.build_argv()
    assert "ffmpeg" in argv[0]
    assert "-i" in argv and "https://cdn.example.com/x.m3u8" in argv
    assert "s16le" in argv and "16000" in argv
    # headers passed via -headers, joined; the secret is in argv but the source
    # never logs argv.
    joined = " ".join(argv)
    assert "-headers" in argv
    assert "Authorization: Bearer secret" in joined
    # hls gets the low-latency start flag
    assert "-live_start_index" in argv


def test_pulls_100ms_pcm_frames_from_local_file():
    src = FfmpegSource(source_kind="mp4", source_url=FIXTURE, headers=None)
    frames = asyncio.run(_collect(src, 5))
    assert len(frames) == 5
    assert all(len(f) == 3200 for f in frames)  # 100ms @ 16kHz mono s16le


def test_reads_to_eof_and_reports_source_eof():
    src = FfmpegSource(source_kind="mp4", source_url=FIXTURE, headers=None)

    async def run():
        count = 0
        async for _f in src.frames():
            count += 1
        return count, src.end_reason

    count, reason = asyncio.run(run())
    assert count > 10                  # the fixture is ~6.7s -> ~67 frames
    assert reason == "source_eof"


def test_unresolvable_url_raises_source_unreachable():
    src = FfmpegSource(source_kind="hls", source_url="https://fixtures.invalid/none.m3u8", headers=None)
    with pytest.raises(SourceError) as e:
        asyncio.run(_collect(src, 1))
    assert e.value.code == "SOURCE_UNREACHABLE"


def test_max_duration_stops_the_pull():
    src = FfmpegSource(source_kind="mp4", source_url=FIXTURE, headers=None, max_duration_s=0.3)

    async def run():
        count = 0
        async for _f in src.frames():
            count += 1
        return count, src.end_reason

    count, reason = asyncio.run(run())
    # 0.3s cap -> ~3 frames, well short of the full ~67
    assert 0 < count <= 6
    assert reason == "max_duration"
