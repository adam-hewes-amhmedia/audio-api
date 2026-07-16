"""SRT source argv, secret handling, and the SSRF guard.

Deliberately separate from test_audio_source.py: that module skips wholesale
when the ffmpeg binary is absent, because it drives real subprocesses. These are
pure -- build_argv and _redact touch nothing -- so they must run everywhere,
including dev boxes with no ffmpeg.
"""
import asyncio

import pytest

from worker_stream_pod.audio_source import FfmpegSource, SourceError


def _argv(**over):
    kwargs = dict(source_kind="srt", source_url="srt://encoder.example.com:9000", source_mode="caller")
    kwargs.update(over)
    return FfmpegSource(**kwargs).build_argv()


def test_srt_caller_argv_sets_mode_and_url():
    argv = _argv()
    assert "-mode" in argv
    assert argv[argv.index("-mode") + 1] == "caller"
    assert "srt://encoder.example.com:9000" in argv
    assert argv[argv.index("-i") + 1] == "srt://encoder.example.com:9000"
    # Live-edge seeking is an hls/dash manifest concern; srt has no manifest.
    assert "-live_start_index" not in argv
    assert "-headers" not in argv


def test_passphrase_is_its_own_token_and_never_in_the_url():
    argv = _argv(passphrase="supersecret123")
    assert "-passphrase" in argv
    assert argv[argv.index("-passphrase") + 1] == "supersecret123"
    # It must not ride in the URL: ffmpeg echoes the input URL in most errors,
    # and that stderr reaches the logs and the NATS stream.failed message.
    assert "supersecret123" not in argv[argv.index("-i") + 1]


def test_no_passphrase_means_no_passphrase_flag():
    assert "-passphrase" not in _argv()


def test_pull_kinds_are_unchanged_by_srt_support():
    argv = FfmpegSource(
        source_kind="hls",
        source_url="https://cdn.example.com/x.m3u8",
        headers={"Authorization": "Bearer secret"},
    ).build_argv()
    assert "-live_start_index" in argv
    assert "-headers" in argv
    assert "-mode" not in argv
    assert "-passphrase" not in argv


def test_redact_scrubs_the_passphrase_from_stderr():
    src = FfmpegSource(
        source_kind="srt", source_url="srt://e.example.com:9000",
        source_mode="caller", passphrase="supersecret123",
    )
    out = src._redact("[srt] connection failed with passphrase supersecret123 set")
    assert "supersecret123" not in out
    assert "***" in out


def test_redact_scrubs_header_values_from_stderr():
    src = FfmpegSource(
        source_kind="hls", source_url="https://cdn.example.com/x.m3u8",
        headers={"Authorization": "Bearer origin-secret"},
    )
    assert "origin-secret" not in src._redact("http error: sent Bearer origin-secret")


def test_redact_scrubs_signed_url_query_strings():
    # Pre-existing exposure: a signed source url carries its credential in the
    # query string, and ffmpeg echoes the input url on failure.
    src = FfmpegSource(source_kind="hls", source_url="https://cdn.example.com/x.m3u8?token=abc123&sig=xyz")
    out = src._redact("https://cdn.example.com/x.m3u8?token=abc123&sig=xyz: Server returned 403")
    assert "abc123" not in out
    assert "xyz" not in out
    assert "cdn.example.com" in out   # the useful part of the message survives


def test_srt_caller_is_ssrf_checked():
    # srt:// used to skip the guard entirely, since it only ran for http(s).
    src = FfmpegSource(
        source_kind="srt", source_url="srt://10.0.0.5:9000", source_mode="caller",
    )

    async def run():
        async for _ in src.frames():
            pass

    with pytest.raises(SourceError) as e:
        asyncio.run(run())
    assert e.value.code == "SOURCE_UNREACHABLE"


def test_srt_listener_is_not_ssrf_checked():
    # A listener dials nothing, so there is no address to vet; binding a private
    # address is the entire point.
    src = FfmpegSource(
        source_kind="srt", source_url="srt://0.0.0.0:9100", source_mode="listener",
    )
    argv = src.build_argv()
    assert argv[argv.index("-mode") + 1] == "listener"
