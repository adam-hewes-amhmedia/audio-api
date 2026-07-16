import asyncio

import pytest

from py_common import nats_client

from worker_stream_supervisor.pool import PortPool
from worker_stream_supervisor.worker import handle_delete, handle_provision, srt_env

# handle_delete's DB work is best-effort (it logs and continues), so point it at
# a closed port: connection refused is instant and exercises the pool path.
_NO_DB = "postgres://x:x@127.0.0.1:1/x"


class FakeForker:
    def __init__(self):
        self.terminated = []

    def terminate(self, sid):
        self.terminated.append(sid)


class FakeMsg:
    def __init__(self, payload):
        self.data = nats_client.encode(payload)
        self.acked = False

    async def ack(self):
        self.acked = True


class FakeJS:
    def __init__(self):
        self.published = []

    async def publish(self, subject, data):
        self.published.append((subject, nats_client.decode(data)))


class SpawnFailsForker:
    def active_count(self):
        return 0

    def spawn(self, **kwargs):
        raise OSError("fork failed")


def _provision_payload(**over):
    payload = {
        "stream_id": "s_a",
        "tenant_id": "t_a",
        "source": {"kind": "hls", "url": "https://cdn.example.com/x.m3u8"},
    }
    payload.update(over)
    return payload


_CFG = {"MAX_PODS": 4, "WS_HOST": "sup1", "DATABASE_URL": _NO_DB}


def test_srt_pool_full_rolls_back_the_ws_port():
    ws_pool = PortPool(start=10000, end=10001)
    srt_pool = PortPool(start=11000, end=11000)
    srt_pool.allocate("s_other")   # the only SRT port is taken

    js, msg = FakeJS(), FakeMsg(_provision_payload(caption_ts=True))
    asyncio.run(handle_provision(js, ws_pool, srt_pool, SpawnFailsForker(), _CFG, msg))

    assert "no free SRT ports" in js.published[0][1]["message"]
    assert ws_pool.in_use_count() == 0   # the WS port must not be stranded


def test_spawn_failure_rolls_back_every_allocated_port():
    ws_pool = PortPool(start=10000, end=10001)
    srt_pool = PortPool(start=11000, end=11001)

    msg = FakeMsg(_provision_payload(caption_ts=True))
    # spawn failure re-raises so provision_loop still naks and retries, but the
    # ports must not stay allocated while it does.
    with pytest.raises(OSError):
        asyncio.run(handle_provision(FakeJS(), ws_pool, srt_pool, SpawnFailsForker(), _CFG, msg))

    assert ws_pool.in_use_count() == 0
    assert srt_pool.in_use_count() == 0


def test_delete_frees_both_ws_and_srt_ports():
    ws_pool = PortPool(start=10000, end=10001)
    srt_pool = PortPool(start=11000, end=11001)
    ws_pool.allocate("s_a")
    srt_pool.allocate("s_a")

    forker = FakeForker()
    msg = FakeMsg({"stream_id": "s_a"})
    asyncio.run(handle_delete(None, ws_pool, srt_pool, forker, {"DATABASE_URL": _NO_DB}, msg))

    assert forker.terminated == ["s_a"]
    assert msg.acked
    assert ws_pool.in_use_count() == 0
    # Without this the caption SRT port leaks and the pool exhausts after 10 deletes.
    assert srt_pool.in_use_count() == 0


def test_delete_without_caption_ts_leaves_srt_pool_untouched():
    ws_pool = PortPool(start=10000, end=10001)
    srt_pool = PortPool(start=11000, end=11001)
    ws_pool.allocate("s_b")   # no SRT port was ever allocated for this stream

    msg = FakeMsg({"stream_id": "s_b"})
    asyncio.run(handle_delete(None, ws_pool, srt_pool, FakeForker(), {"DATABASE_URL": _NO_DB}, msg))

    assert ws_pool.in_use_count() == 0
    assert srt_pool.in_use_count() == 0


def test_srt_env_allocates_only_when_enabled():
    pool = PortPool(start=11000, end=11001)
    env, port = srt_env(True, pool, "s_a")
    assert port == 11000
    assert env["POD_CAPTION_TS"] == "1"
    assert env["POD_SRT_PORT"] == "11000"
    assert env["POD_SRT_HOST"] == "0.0.0.0"

    env2, port2 = srt_env(False, pool, "s_b")
    assert port2 is None
    assert env2 == {}
    assert pool.in_use_count() == 1   # disabled path allocates nothing
