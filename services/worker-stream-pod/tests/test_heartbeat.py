import asyncio

from worker_stream_pod.heartbeat import heartbeat_loop


def test_heartbeat_loop_beats_then_exits_on_stop():
    calls = []
    stop = asyncio.Event()

    async def fake_beat(dsn, pod_id):
        calls.append(pod_id)
        stop.set()  # ask the loop to exit after the first beat

    async def run():
        await asyncio.wait_for(
            heartbeat_loop("dsn", "p1", 0.01, stop, beat_fn=fake_beat),
            timeout=2,
        )

    asyncio.run(run())
    assert calls == ["p1"]


def test_heartbeat_loop_survives_beat_errors():
    calls = []
    stop = asyncio.Event()

    async def flaky_beat(dsn, pod_id):
        calls.append(pod_id)
        stop.set()
        raise RuntimeError("db down")

    async def run():
        # Must not propagate the beat error.
        await asyncio.wait_for(
            heartbeat_loop("dsn", "p1", 0.01, stop, beat_fn=flaky_beat),
            timeout=2,
        )

    asyncio.run(run())
    assert calls == ["p1"]
