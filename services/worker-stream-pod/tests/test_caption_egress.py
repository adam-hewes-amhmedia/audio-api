import asyncio

from worker_stream_pod.worker import _config, start_caption_egress


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
