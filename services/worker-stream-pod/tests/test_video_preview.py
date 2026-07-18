from worker_stream_pod.video_preview import build_preview_argv, relay_url_for


def test_pull_source_reads_the_source_url():
    argv = build_preview_argv(
        source_kind="hls", source_url="https://cdn/x.m3u8", headers={},
        relay_url="udp://127.0.0.1:10100", hls_dir="/tmp/hls",
    )
    assert "-i" in argv
    assert argv[argv.index("-i") + 1] == "https://cdn/x.m3u8"
    assert "udp://127.0.0.1:10100" not in argv        # pull ignores the relay
    assert "-c:v" in argv and argv[argv.index("-c:v") + 1] == "copy"
    assert "-f" in argv and "hls" in argv
    assert argv[-1] == "/tmp/hls/index.m3u8"


def test_srt_source_reads_the_relay():
    argv = build_preview_argv(
        source_kind="srt", source_url="", headers={},
        relay_url="udp://127.0.0.1:10100", hls_dir="/tmp/hls",
    )
    assert argv[argv.index("-i") + 1] == "udp://127.0.0.1:10100"


def test_video_map_is_optional_so_audio_only_only_kills_the_preview():
    argv = build_preview_argv(
        source_kind="hls", source_url="https://cdn/x.m3u8", headers={},
        relay_url="udp://127.0.0.1:10100", hls_dir="/tmp/hls",
    )
    assert "0:v:0?" in argv          # optional map: preview fails alone, captions safe


def test_relay_url_is_loopback_on_the_hls_port():
    assert relay_url_for(10100) == "udp://127.0.0.1:10100"
