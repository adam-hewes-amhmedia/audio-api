"""SRT source argv, secret handling, and the SSRF guard.

Deliberately separate from test_audio_source.py: that module skips wholesale
when the ffmpeg binary is absent, because it drives real subprocesses. These are
pure -- build_argv and _redact touch nothing -- so they must run everywhere,
including dev boxes with no ffmpeg.
"""
import asyncio

import pytest

from worker_stream_pod.audio_source import FfmpegSource, SourceError
from worker_stream_pod.worker import _config

_BASE_ENV = {
    "STREAM_ID": "s_x", "POD_ID": "p_x", "POD_WS_PORT": "10000",
    "DATABASE_URL": "postgres://x",
}


def _set_env(monkeypatch, **over):
    for k in ("SOURCE_URL", "SOURCE_MODE", "SOURCE_PASSPHRASE", "SOURCE_KIND"):
        monkeypatch.delenv(k, raising=False)
    for k, v in {**_BASE_ENV, **over}.items():
        monkeypatch.setenv(k, v)


def test_config_reads_srt_mode_and_passphrase(monkeypatch):
    _set_env(monkeypatch, SOURCE_KIND="srt", SOURCE_URL="srt://e.example.com:9000",
             SOURCE_MODE="caller", SOURCE_PASSPHRASE="supersecret123")
    cfg = _config()
    assert cfg["SOURCE_MODE"] == "caller"
    assert cfg["SOURCE_PASSPHRASE"] == "supersecret123"


def test_config_tolerates_a_listener_with_no_source_url(monkeypatch):
    # os.environ["SOURCE_URL"] raised KeyError and killed the pod on boot.
    _set_env(monkeypatch, SOURCE_KIND="srt", SOURCE_MODE="listener",
             SOURCE_PASSPHRASE="supersecret123")
    cfg = _config()
    assert cfg["SOURCE_URL"] == ""
    assert cfg["SOURCE_MODE"] == "listener"


def test_config_leaves_pull_sources_alone(monkeypatch):
    _set_env(monkeypatch, SOURCE_KIND="hls", SOURCE_URL="https://cdn.example.com/x.m3u8")
    cfg = _config()
    assert cfg["SOURCE_URL"] == "https://cdn.example.com/x.m3u8"
    assert cfg["SOURCE_MODE"] is None
    assert cfg["SOURCE_PASSPHRASE"] is None


def test_config_builds_the_listener_bind_url_from_the_allocated_port(monkeypatch):
    monkeypatch.setenv("POD_INGEST_PORT", "9100")
    _set_env(monkeypatch, SOURCE_KIND="srt", SOURCE_MODE="listener",
             SOURCE_PASSPHRASE="supersecret123")
    cfg = _config()
    # The supervisor allocates the port; the pod turns it into the bind address.
    assert cfg["SOURCE_URL"] == "srt://0.0.0.0:9100"
    monkeypatch.delenv("POD_INGEST_PORT", raising=False)


def test_ingest_wait_is_separate_from_provision_ttl(monkeypatch):
    _set_env(monkeypatch, SOURCE_KIND="hls", SOURCE_URL="https://cdn.example.com/x.m3u8")
    cfg = _config()
    # Waiting for a source to respond and waiting for an encoder to show up are
    # different things, so one knob must not blind the other.
    assert cfg["PROVISION_TTL_S"] == 15.0
    assert cfg["INGEST_WAIT_S"] == 300.0

    monkeypatch.setenv("POD_PROVISION_TTL_S", "20")
    monkeypatch.setenv("POD_INGEST_WAIT_S", "600")
    cfg = _config()
    assert cfg["PROVISION_TTL_S"] == 20.0
    assert cfg["INGEST_WAIT_S"] == 600.0
    for k in ("POD_PROVISION_TTL_S", "POD_INGEST_WAIT_S"):
        monkeypatch.delenv(k, raising=False)


def test_listener_waits_on_the_ingest_budget_not_the_provision_ttl():
    # 15s is right for "the source is not answering" and wrong for "the encoder
    # has not connected yet", which is normal for minutes.
    listener = FfmpegSource(
        source_kind="srt", source_url="srt://0.0.0.0:9100", source_mode="listener",
        provision_ttl_s=15.0, ingest_wait_s=300.0,
    )
    assert listener.open_timeout_s() == 300.0

    caller = FfmpegSource(
        source_kind="srt", source_url="srt://e.example.com:9000", source_mode="caller",
        provision_ttl_s=15.0, ingest_wait_s=300.0,
    )
    assert caller.open_timeout_s() == 15.0

    pull = FfmpegSource(
        source_kind="hls", source_url="https://cdn.example.com/x.m3u8",
        provision_ttl_s=15.0, ingest_wait_s=300.0,
    )
    assert pull.open_timeout_s() == 15.0


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
