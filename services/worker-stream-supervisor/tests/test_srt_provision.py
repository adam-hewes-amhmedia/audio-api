import asyncio

import pytest

from py_common import nats_client

from worker_stream_supervisor.pool import PortPool
from worker_stream_supervisor.worker import handle_delete, handle_provision, ingest_env, srt_env

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


class CapturingForker:
    def __init__(self):
        self.env = None

    def active_count(self):
        return 0

    def spawn(self, *, stream_id, env):
        self.env = env


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
    asyncio.run(handle_provision(js, ws_pool, srt_pool, PortPool(start=9100, end=9101), SpawnFailsForker(), _CFG, msg))

    assert "no free SRT ports" in js.published[0][1]["message"]
    assert ws_pool.in_use_count() == 0   # the WS port must not be stranded


def test_spawn_failure_rolls_back_every_allocated_port():
    ws_pool = PortPool(start=10000, end=10001)
    srt_pool = PortPool(start=11000, end=11001)

    msg = FakeMsg(_provision_payload(caption_ts=True))
    # spawn failure re-raises so provision_loop still naks and retries, but the
    # ports must not stay allocated while it does.
    with pytest.raises(OSError):
        asyncio.run(handle_provision(FakeJS(), ws_pool, srt_pool, PortPool(start=9100, end=9101), SpawnFailsForker(), _CFG, msg))

    assert ws_pool.in_use_count() == 0
    assert srt_pool.in_use_count() == 0


def test_delete_frees_both_ws_and_srt_ports():
    ws_pool = PortPool(start=10000, end=10001)
    srt_pool = PortPool(start=11000, end=11001)
    ws_pool.allocate("s_a")
    srt_pool.allocate("s_a")

    forker = FakeForker()
    msg = FakeMsg({"stream_id": "s_a"})
    asyncio.run(handle_delete(None, ws_pool, srt_pool, PortPool(start=9100, end=9101), forker, {"DATABASE_URL": _NO_DB}, msg))

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
    asyncio.run(handle_delete(None, ws_pool, srt_pool, PortPool(start=9100, end=9101), FakeForker(), {"DATABASE_URL": _NO_DB}, msg))

    assert ws_pool.in_use_count() == 0
    assert srt_pool.in_use_count() == 0


def _provision(forker, payload):
    """Run handle_provision far enough to capture the spawn env.

    The stream_pods write lands after spawn and fails against _NO_DB; that is not
    what these assert, so the resulting error is swallowed deliberately. A failure
    *before* spawn leaves forker.env as None, which the tests check for.
    """
    try:
        asyncio.run(handle_provision(
            FakeJS(), PortPool(start=10000, end=10001), PortPool(start=11000, end=11001),
            PortPool(start=9100, end=9101), forker, _CFG, FakeMsg(payload),
        ))
    except Exception:
        pass


def test_spawn_env_carries_srt_mode_and_passphrase():
    forker = CapturingForker()
    _provision(forker, _provision_payload(source={
        "kind": "srt", "url": "srt://encoder.example.com:9000",
        "mode": "caller", "passphrase": "supersecret123",
    }))

    assert forker.env is not None
    assert forker.env["SOURCE_KIND"] == "srt"
    assert forker.env["SOURCE_URL"] == "srt://encoder.example.com:9000"
    assert forker.env["SOURCE_MODE"] == "caller"
    assert forker.env["SOURCE_PASSPHRASE"] == "supersecret123"


def test_listener_source_without_a_url_still_provisions():
    forker = CapturingForker()
    _provision(forker, _provision_payload(source={
        "kind": "srt", "mode": "listener", "passphrase": "supersecret123",
    }))

    # source["url"] was unguarded, so a listener payload raised KeyError before
    # the pod was ever spawned.
    assert forker.env is not None, "provisioning raised before spawning the pod"
    assert forker.env["SOURCE_URL"] == ""
    assert forker.env["SOURCE_MODE"] == "listener"


def test_pull_source_spawn_env_is_unchanged():
    forker = CapturingForker()
    _provision(forker, _provision_payload())

    assert forker.env["SOURCE_KIND"] == "hls"
    assert forker.env["SOURCE_URL"] == "https://cdn.example.com/x.m3u8"
    assert forker.env["SOURCE_MODE"] == ""
    assert forker.env["SOURCE_PASSPHRASE"] == ""


def test_ingest_env_allocates_only_for_an_srt_listener():
    pool = PortPool(start=9100, end=9101)

    env, port = ingest_env({"kind": "srt", "mode": "listener"}, pool, "s_a")
    assert port == 9100
    assert env["POD_INGEST_PORT"] == "9100"

    # A caller dials out; an hls source pulls. Neither needs an inbound port.
    assert ingest_env({"kind": "srt", "mode": "caller", "url": "srt://e:9000"}, pool, "s_b") == ({}, None)
    assert ingest_env({"kind": "hls", "url": "https://cdn/x.m3u8"}, pool, "s_c") == ({}, None)
    assert pool.in_use_count() == 1


def test_ingest_pool_full_rolls_back_the_other_ports():
    ws_pool = PortPool(start=10000, end=10001)
    srt_pool = PortPool(start=11000, end=11001)
    ingest_pool = PortPool(start=9100, end=9100)
    ingest_pool.allocate("s_other")   # the only ingest port is taken

    js = FakeJS()
    msg = FakeMsg(_provision_payload(
        caption_ts=True,
        source={"kind": "srt", "mode": "listener", "passphrase": "supersecret123"},
    ))
    asyncio.run(handle_provision(js, ws_pool, srt_pool, ingest_pool, SpawnFailsForker(), _CFG, msg))

    assert "no free ingest ports" in js.published[0][1]["message"]
    assert ws_pool.in_use_count() == 0
    assert srt_pool.in_use_count() == 0   # the caption port must not strand either


def test_delete_frees_the_ingest_port():
    ws_pool = PortPool(start=10000, end=10001)
    srt_pool = PortPool(start=11000, end=11001)
    ingest_pool = PortPool(start=9100, end=9101)
    ws_pool.allocate("s_a")
    ingest_pool.allocate("s_a")

    msg = FakeMsg({"stream_id": "s_a"})
    asyncio.run(handle_delete(None, ws_pool, srt_pool, ingest_pool, FakeForker(), {"DATABASE_URL": _NO_DB}, msg))

    assert ws_pool.in_use_count() == 0
    assert ingest_pool.in_use_count() == 0


def test_provision_merges_settings_overrides_into_spawn_env(monkeypatch):
    # A database override must reach the pod's env, winning over the container
    # default. handle_provision reads the settings table at spawn time; here that
    # read is faked so the test needs no database.
    import worker_stream_supervisor.worker as w

    async def fake_overrides(_database_url):
        return {"POD_MAX_DURATION_S": "300", "POD_MODEL_SIZE": "medium"}

    monkeypatch.setattr(w, "load_settings_overrides", fake_overrides)
    forker = CapturingForker()
    _provision(forker, _provision_payload())

    assert forker.env["POD_MAX_DURATION_S"] == "300"
    assert forker.env["POD_MODEL_SIZE"] == "medium"


def test_provision_without_overrides_leaves_spawn_env_on_container_defaults(monkeypatch):
    # Empty table (or an unreadable one): the pod inherits the container env, so
    # the tuning keys are simply absent from spawn_env.
    import worker_stream_supervisor.worker as w

    async def no_overrides(_database_url):
        return {}

    monkeypatch.setattr(w, "load_settings_overrides", no_overrides)
    forker = CapturingForker()
    _provision(forker, _provision_payload())

    assert "POD_MAX_DURATION_S" not in forker.env
    assert "POD_MODEL_SIZE" not in forker.env


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
