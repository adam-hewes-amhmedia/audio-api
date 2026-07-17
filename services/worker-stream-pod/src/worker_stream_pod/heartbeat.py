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


async def mark_exited(dsn: str, pod_id: str) -> None:
    """Stamp the pod's final status on the way out.

    Lives here because `beat` above is what writes status='ready', so this is
    what has to un-write it. Without this, the last thing a pod ever said about
    itself was 'ready', and the row stayed that way permanently: the supervisor
    only writes 'terminated' when it handles an explicit delete, and the reaper
    only visits pods attached to a live stream. A pod that exits on its own --
    source unreachable, ffmpeg dying, the stream simply ending -- left a row
    claiming to be ready forever.

    'terminated' rather than 'dead': the pod stopped on purpose and said so.
    'dead' is the reaper's word for a pod that stopped saying anything at all,
    and that distinction is worth keeping. An existing 'dead' is not overwritten
    -- if the reaper already timed this pod out, its finding is a real
    observation and this is just the corpse confirming it.

    MUST be called after the heartbeat task is cancelled. A beat racing this
    write would put the row straight back to 'ready'."""
    import psycopg

    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE stream_pods SET status='terminated' "
                "WHERE pod_id=%s AND status NOT IN ('dead','terminated')",
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
