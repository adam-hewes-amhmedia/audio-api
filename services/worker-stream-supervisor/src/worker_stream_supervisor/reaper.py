import asyncio
from datetime import datetime, timezone

from py_common import logging_setup, nats_client

log = logging_setup.setup("worker-stream-supervisor")

REAP_REASON = "pod_heartbeat_timeout"

# Streams that can still be driven to a terminal state by the reaper, and the
# orchestrator stream-machine event that does it. active/ending end cleanly via
# ingest_ended; pre-ingest streams have no ingest_ended transition, so they fail.
_INGEST_ENDED_STATUSES = ("active", "ending")
_FAILED_STATUSES = ("provisioning", "awaiting_ingest")


def reap_action(stream_status: str):
    """Map a live stream status to the terminal event to emit, or None to skip."""
    if stream_status in _INGEST_ENDED_STATUSES:
        return "ingest_ended"
    if stream_status in _FAILED_STATUSES:
        return "failed"
    return None


def build_event(action: str, stream_id: str, pod_id: str, cue_count: int):
    """Return (subject, payload) for the reaper's terminal event."""
    if action == "ingest_ended":
        return nats_client.SUBJECTS["STREAM_INGEST_ENDED"], {
            "stream_id": stream_id,
            "pod_id": pod_id,
            "reason": REAP_REASON,
            "cue_count": cue_count,
            "ended_at": datetime.now(timezone.utc).isoformat(),
        }
    if action == "failed":
        return nats_client.SUBJECTS["STREAM_FAILED"], {
            "stream_id": stream_id,
            "code": "POD_HEARTBEAT_TIMEOUT",
            "message": "pod heartbeat timed out; stream reaped",
        }
    raise ValueError(f"unknown reap action: {action}")


async def reap_once(js, *, fetch_stale, mark_pod_dead):
    """Publish a terminal event for each stale stream and mark its pod dead.
    `fetch_stale` returns dicts with stream_id/pod_id/stream_status/cue_count.
    Returns the list of reaped stream ids."""
    stale = await fetch_stale()
    reaped = []
    for row in stale:
        action = reap_action(row["stream_status"])
        if action is None:
            continue
        subject, payload = build_event(
            action, row["stream_id"], row["pod_id"], row["cue_count"]
        )
        await js.publish(subject, nats_client.encode(payload))
        await mark_pod_dead(row["pod_id"])
        reaped.append(row["stream_id"])
    return reaped


async def _fetch_stale(conn, stale_after_s: int):
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT s.id, s.pod_id, s.status, s.cue_count "
            "FROM streams s JOIN stream_pods p ON p.pod_id = s.pod_id "
            "WHERE s.status IN ('provisioning','awaiting_ingest','active','ending') "
            "AND p.status NOT IN ('terminated','dead') "
            "AND p.last_heartbeat < now() - make_interval(secs => %s)",
            (stale_after_s,),
        )
        rows = await cur.fetchall()
    return [
        {"stream_id": r[0], "pod_id": r[1], "stream_status": r[2], "cue_count": r[3]}
        for r in rows
    ]


async def _mark_pod_dead(conn, pod_id: str):
    async with conn.cursor() as cur:
        await cur.execute(
            "UPDATE stream_pods SET status='dead' WHERE pod_id=%s", (pod_id,)
        )


async def reaper_loop(js, dsn: str, *, interval_s: int, stale_after_s: int):
    """Periodically reap streams whose pod has stopped heartbeating. This is the
    backstop for pods that die without a clean SIGTERM (crash, OOM, supervisor
    restart) and never publish ingest.ended themselves."""
    import psycopg

    while True:
        try:
            await asyncio.sleep(interval_s)
            async with await psycopg.AsyncConnection.connect(dsn) as conn:
                async def fetch_stale():
                    return await _fetch_stale(conn, stale_after_s)

                async def mark_pod_dead(pod_id):
                    await _mark_pod_dead(conn, pod_id)

                reaped = await reap_once(
                    js, fetch_stale=fetch_stale, mark_pod_dead=mark_pod_dead
                )
                await conn.commit()
            if reaped:
                log.info(
                    "reaped_stale_streams",
                    extra={"count": len(reaped), "stream_ids": reaped},
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("reaper_failed")
