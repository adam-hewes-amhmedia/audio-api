import asyncio
import os
import signal

import psycopg

from py_common import logging_setup, nats_client
from worker_stream_pod.cue_emitter import StubCueSource
from worker_stream_pod.heartbeat import heartbeat_loop
from worker_stream_pod.lifecycle import StatusReporter
from worker_stream_pod.ws_server import CueBroadcaster, serve_ws

log = logging_setup.setup("worker-stream-pod")


def _config() -> dict:
    return {
        "STREAM_ID":   os.environ["STREAM_ID"],
        "POD_ID":      os.environ["POD_ID"],
        "SOURCE_KIND": os.environ["SOURCE_KIND"],
        "SOURCE_URL":  os.environ["SOURCE_URL"],
        "WS_HOST":     os.environ.get("POD_WS_HOST", "0.0.0.0"),
        "WS_PORT":     int(os.environ["POD_WS_PORT"]),
        "DATABASE_URL": os.environ["DATABASE_URL"],
        "FIRST_PACKET_DELAY_S": float(os.environ.get("POD_FIRST_PACKET_DELAY_S", "2.0")),
        "CUE_INTERVAL_MS": int(os.environ.get("POD_CUE_INTERVAL_MS", "5000")),
        "HEARTBEAT_INTERVAL_S": float(os.environ.get("POD_HEARTBEAT_INTERVAL_S", "10")),
    }


async def main():
    cfg = _config()
    nc, js = await nats_client.connect()
    broadcaster = CueBroadcaster()
    ws_server = await serve_ws(broadcaster, cfg["WS_HOST"], cfg["WS_PORT"])
    reporter = StatusReporter(js=js, stream_id=cfg["STREAM_ID"], pod_id=cfg["POD_ID"])

    async with await psycopg.AsyncConnection.connect(cfg["DATABASE_URL"]) as conn:
        async with conn.cursor() as cur:
            await cur.execute("UPDATE stream_pods SET status='ready' WHERE pod_id=%s", (cfg["POD_ID"],))
        await conn.commit()

    log.info(
        "pod_ready",
        stream_id=cfg["STREAM_ID"], pod_id=cfg["POD_ID"], ws_port=cfg["WS_PORT"],
        source_kind=cfg["SOURCE_KIND"], source_url=cfg["SOURCE_URL"],
    )

    # Stub: the source URL is captured and logged but never opened in Plan 5.
    # We just wait FIRST_PACKET_DELAY_S to mimic time-to-first-frame, then flip to
    # active. Plan 6 replaces this with a real ffmpeg-driven HLS/DASH/MP4 pull.
    await asyncio.sleep(cfg["FIRST_PACKET_DELAY_S"])
    await reporter.mark_started()
    log.info("ingest_started", stream_id=cfg["STREAM_ID"])

    stop = asyncio.Event()
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass  # Windows

    cue_count = 0
    source = StubCueSource(interval_ms=cfg["CUE_INTERVAL_MS"])

    async def emit_loop():
        nonlocal cue_count
        async for cue in source.cues():
            if stop.is_set():
                break
            payload = {
                "event":     "cue.finalised",
                "stream_id": cfg["STREAM_ID"],
                "cue_id":    cue.cue_id,
                "start_ms":  cue.start_ms,
                "end_ms":    cue.end_ms,
                "text":      cue.text,
                "confidence": cue.confidence,
            }
            await broadcaster.broadcast(payload)
            await js.publish(nats_client.SUBJECTS["STREAM_CUE_FINALISED"], nats_client.encode({
                "stream_id": cfg["STREAM_ID"],
                "cue_id":    cue.cue_id,
                "start_ms":  cue.start_ms,
                "end_ms":    cue.end_ms,
                "text":      cue.text,
                "confidence": cue.confidence,
            }))
            try:
                async with await psycopg.AsyncConnection.connect(cfg["DATABASE_URL"]) as conn:
                    async with conn.cursor() as cur:
                        await cur.execute(
                            "INSERT INTO stream_cues (stream_id, cue_id, start_ms, end_ms, text, confidence) "
                            "VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                            (cfg["STREAM_ID"], cue.cue_id, cue.start_ms, cue.end_ms, cue.text, cue.confidence),
                        )
                        await cur.execute(
                            "UPDATE streams SET cue_count = cue_count + 1 WHERE id=%s",
                            (cfg["STREAM_ID"],),
                        )
                    await conn.commit()
            except Exception as e:
                log.warning("cue_persist_failed", err=str(e))
            cue_count += 1

    emit_task = asyncio.create_task(emit_loop())
    hb_task = asyncio.create_task(
        heartbeat_loop(cfg["DATABASE_URL"], cfg["POD_ID"], cfg["HEARTBEAT_INTERVAL_S"], stop)
    )
    await stop.wait()
    emit_task.cancel()
    hb_task.cancel()
    for task in (emit_task, hb_task):
        try:
            await task
        except asyncio.CancelledError:
            pass

    await reporter.mark_ended(reason="client_delete", cue_count=cue_count)
    ws_server.close()
    await ws_server.wait_closed()
    await nc.drain()
    log.info("pod_exited", stream_id=cfg["STREAM_ID"], cues=cue_count)
