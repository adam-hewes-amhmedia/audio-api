from worker_stream_pod.audio_source import FfmpegSource


def test_srt_source_gains_the_relay_output():
    src = FfmpegSource(source_kind="srt", source_url="srt://0.0.0.0:9100",
                       source_mode="listener", relay_url="udp://127.0.0.1:10100")
    argv = src.build_argv()
    # audio output still present...
    assert "pipe:1" in argv
    # ...plus the relay output that copies every stream (never fails on audio-only).
    assert "udp://127.0.0.1:10100" in argv
    i = argv.index("udp://127.0.0.1:10100")
    assert argv[i - 1] == "mpegts" and argv[i - 2] == "-f"
    assert "-map" in argv and "0" in argv[argv.index("-map") + 1]


def test_pull_source_argv_is_unchanged_without_a_relay():
    src = FfmpegSource(source_kind="hls", source_url="https://cdn/x.m3u8")
    argv = src.build_argv()
    assert "udp://127.0.0.1" not in " ".join(argv)   # no relay for pull sources
    assert argv[-1] == "pipe:1"
