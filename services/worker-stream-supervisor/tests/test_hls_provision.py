import asyncio
import json

from worker_stream_supervisor.pool import PortPool
from worker_stream_supervisor.worker import handle_provision, handle_delete


class _EnvForker:
    """Captures spawn env; the stream_pods write after spawn fails against a bad
    DATABASE_URL, which is fine — we only assert on the env and the pools."""
    def __init__(self):
        self.env = None
    def active_count(self):
        return 0
    def spawn(self, *, stream_id, env):
        self.env = env
    def terminate(self, stream_id):
        pass


class _FakeMsg:
    def __init__(self, payload):
        self.data = json.dumps(payload).encode()
        self.acked = False
    async def ack(self):
        self.acked = True
    async def nak(self, delay=0):
        pass


class _FakeJS:
    def __init__(self):
        self.published = []
    async def publish(self, subject, data):
        self.published.append((subject, data))


_CFG = {"DATABASE_URL": "postgres://bad/nodb", "WS_HOST": "pod-host", "MAX_PODS": 4}


def _provision(hls_pool):
    forker = _EnvForker()
    msg = _FakeMsg({"stream_id": "s_hls01", "tenant_id": "t", "source": {"kind": "hls", "url": "https://x/y.m3u8"}})
    ws = PortPool(start=10000, end=10009)
    srt = PortPool(start=11000, end=11009)
    ing = PortPool(start=9100, end=9109)
    # The stream_pods write will fail against the bad DB and raise, but only after
    # spawn has captured env and the ports are allocated.
    try:
        asyncio.run(handle_provision(_FakeJS(), ws, srt, ing, forker, _CFG, msg, hls_pool=hls_pool))
    except Exception:
        pass
    return forker, hls_pool


def test_hls_port_is_allocated_and_passed_as_env():
    hls = PortPool(start=10100, end=10109)
    forker, hls = _provision(hls)
    assert forker.env["POD_HLS_PORT"] == "10100"
    assert hls.in_use_count() == 1


def test_exhausted_hls_pool_still_provisions_without_a_preview():
    hls = PortPool(start=10100, end=10100)
    hls.allocate("s_other")  # the only HLS port is taken
    forker, hls = _provision(hls)
    # Stream still provisions (ws etc. allocated, spawn captured), just no preview.
    assert "POD_HLS_PORT" not in forker.env
    assert forker.env["STREAM_ID"] == "s_hls01"


def test_delete_frees_the_hls_port():
    hls = PortPool(start=10100, end=10109)
    hls.allocate("s_a")
    ws = PortPool(start=10000, end=10009); ws.allocate("s_a")
    srt = PortPool(start=11000, end=11009)
    ing = PortPool(start=9100, end=9109)
    msg = _FakeMsg({"stream_id": "s_a"})
    try:
        asyncio.run(handle_delete(_FakeJS(), ws, srt, ing, _EnvForker(), _CFG, msg, hls_pool=hls))
    except Exception:
        pass
    assert hls.in_use_count() == 0
