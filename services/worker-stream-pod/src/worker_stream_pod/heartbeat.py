import asyncio

from py_common import logging_setup

log = logging_setup.setup("worker-stream-pod")


async def beat(dsn: str, pod_id: str) -> None:
    """Refresh the pod's liveness marker. Opens a short-lived connection so a
    stuck connection can't silently freeze the heartbeat (matches the pod's
    connection-per-write style elsewhere)."""
    import psycopg

    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE stream_pods SET last_heartbeat=now(), status='ready' WHERE pod_id=%s",
                (pod_id,),
            )
        await conn.commit()


async def heartbeat_loop(dsn, pod_id, interval_s, stop, *, beat_fn=beat) -> None:
    """Beat every `interval_s` until `stop` is set. A failed beat is logged but
    never crashes the pod -- the supervisor's reaper is the backstop if beats
    stop landing entirely."""
    while not stop.is_set():
        try:
            await beat_fn(dsn, pod_id)
        except Exception as e:
            log.warning("heartbeat_failed", err=str(e))
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval_s)
        except asyncio.TimeoutError:
            pass
