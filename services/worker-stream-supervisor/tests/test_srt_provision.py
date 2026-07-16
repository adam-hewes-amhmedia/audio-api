import asyncio

from py_common import nats_client

from worker_stream_supervisor.pool import PortPool
from worker_stream_supervisor.worker import handle_delete, srt_env

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
