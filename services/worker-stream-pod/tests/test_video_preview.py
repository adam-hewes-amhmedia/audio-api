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


def test_segment_filenames_match_the_gateways_regex():
    # The gateway 404s anything that doesn't match ^seg-\d+\.ts$. ffmpeg only
    # emits that shape if we tell it to via -hls_segment_filename.
    argv = build_preview_argv(
        source_kind="hls", source_url="https://cdn/x.m3u8", headers={},
        relay_url="udp://127.0.0.1:10100", hls_dir="/tmp/hls",
    )
    assert "-hls_segment_filename" in argv
    assert argv[argv.index("-hls_segment_filename") + 1] == "/tmp/hls/seg-%d.ts"
    assert argv[-1] == "/tmp/hls/index.m3u8"          # playlist path stays last


def test_preview_is_video_only_no_audio_map_or_codec():
    # Preview is muted and video-only by design. If audio were muxed, an
    # audio-only source would produce a playable (pictureless) preview
    # instead of failing so the console shows the "no preview" fallback.
    argv = build_preview_argv(
        source_kind="hls", source_url="https://cdn/x.m3u8", headers={},
        relay_url="udp://127.0.0.1:10100", hls_dir="/tmp/hls",
    )
    assert "-an" in argv
    assert "-c:a" not in argv
    assert "aac" not in argv
    assert "0:a:0?" not in argv


def test_pull_source_with_headers_sets_the_headers_flag():
    argv = build_preview_argv(
        source_kind="hls", source_url="https://cdn/x.m3u8",
        headers={"Authorization": "Bearer x"},
        relay_url="udp://127.0.0.1:10100", hls_dir="/tmp/hls",
    )
    assert "-headers" in argv
    assert argv[argv.index("-headers") + 1] == "Authorization: Bearer x\r\n"
    # -headers must precede -i for ffmpeg to apply it to this input.
    assert argv.index("-headers") < argv.index("-i")


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
