import asyncio
import json
import os
import socket

import psycopg

from py_common import logging_setup, nats_client
from worker_stream_supervisor.pool import PortPool, PoolFull
from worker_stream_supervisor.forker import Forker

log = logging_setup.setup("worker-stream-supervisor")


def _config() -> dict:
    port_start = int(os.environ.get("STREAM_INGEST_PORT_START", "9100"))
    port_end   = int(os.environ.get("STREAM_INGEST_PORT_END",   "9109"))
    return {
        "DATABASE_URL": os.environ["DATABASE_URL"],
        "PUBLIC_HOST":  os.environ.get("STREAM_INGEST_PUBLIC_HOST", socket.gethostname()),
        "PORT_START":   port_start,
        "PORT_END":     port_end,
        "MAX_PODS":     int(os.environ.get("STREAM_MAX_PODS", str(port_end - port_start + 1))),
        "POD_CMD":      os.environ.get("STREAM_POD_CMD", "python -m worker_stream_pod").split(),
        "WS_PORT_OFFSET": int(os.environ.get("STREAM_POD_WS_PORT_OFFSET", "1000")),
    }


async def handle_provision(js, pool: PortPool, forker: Forker, cfg: dict, msg) -> None:
    env = nats_client.decode(msg.data)
    payload = env["payload"] if "payload" in env else env  # supervisor messages may be raw payload
    sid = payload["stream_id"]
    tenant = payload["tenant_id"]

    if forker.active_count() >= cfg["MAX_PODS"]:
        await _publish_failed(js, sid, "STREAM_PROVISION_FAILED", "max pod capacity reached")
        await msg.ack()
        log.warning("provision_rejected_capacity", extra={"stream_id": sid})
        return

    try:
        port = pool.allocate(sid)
    except PoolFull:
        await _publish_failed(js, sid, "STREAM_PROVISION_FAILED", "no free SRT ports")
        await msg.ack()
        return

    ws_port = port + cfg["WS_PORT_OFFSET"]
    pod_id = f"p_{sid[2:]}"
    spawn_env = {
        "STREAM_ID":    sid,
        "POD_ID":       pod_id,
        "INGEST_HOST":  cfg["PUBLIC_HOST"],
        "INGEST_PORT":  str(port),
        "POD_WS_PORT":  str(ws_port),
        "OPTIONS_JSON": json.dumps(payload.get("options", {}) or {}),
        "TARGET_LANG":  payload.get("target_lang", "en"),
        "DATABASE_URL": cfg["DATABASE_URL"],
        "NATS_URL":     os.environ.get("NATS_URL", "nats://nats:4222"),
    }
    forker.spawn(stream_id=sid, env=spawn_env)

    async with await psycopg.AsyncConnection.connect(cfg["DATABASE_URL"]) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO stream_pods (pod_id, supervisor_host, ingest_host, ingest_port, stream_id, status) "
                "VALUES (%s, %s, %s, %s, %s, 'starting') "
                "ON CONFLICT (pod_id) DO UPDATE SET status='starting', last_heartbeat=now()",
                (pod_id, socket.gethostname(), cfg["PUBLIC_HOST"], port, sid),
            )
            await cur.execute(
                "UPDATE streams SET pod_id=%s, ingest_host=%s, ingest_port=%s WHERE id=%s",
                (pod_id, cfg["PUBLIC_HOST"], port, sid),
            )
        await conn.commit()

    ready_payload = {
        "stream_id":   sid,
        "pod_id":      pod_id,
        "ingest_host": cfg["PUBLIC_HOST"],
        "ingest_port": port,
        "ws_port":     ws_port,
    }
    await js.publish(nats_client.SUBJECTS["STREAM_READY"], nats_client.encode(ready_payload))
    await msg.ack()
    log.info("pod_spawned", extra={"stream_id": sid, "pod_id": pod_id, "port": port, "ws_port": ws_port})


async def _publish_failed(js, stream_id: str, code: str, message: str) -> None:
    await js.publish(nats_client.SUBJECTS["STREAM_FAILED"], nats_client.encode({
        "stream_id": stream_id, "code": code, "message": message,
    }))


async def main():
    cfg = _config()
    pool = PortPool(start=cfg["PORT_START"], end=cfg["PORT_END"])
    forker = Forker(cmd=cfg["POD_CMD"])
    nc, js = await nats_client.connect()
    log.info(
        "supervisor_consuming",
        extra={
            "subject": nats_client.SUBJECTS["STREAM_PROVISION_REQUESTED"],
            "port_range": f"{cfg['PORT_START']}-{cfg['PORT_END']}",
            "max_pods": cfg["MAX_PODS"],
        },
    )

    durable = "stream-supervisor"
    try:
        await js.add_consumer(
            "AUDIO_STREAMS",
            durable_name=durable,
            filter_subject=nats_client.SUBJECTS["STREAM_PROVISION_REQUESTED"],
            ack_policy="explicit",
            max_deliver=3,
        )
    except Exception:
        pass

    sub = await js.pull_subscribe(
        subject=nats_client.SUBJECTS["STREAM_PROVISION_REQUESTED"],
        durable=durable,
        stream="AUDIO_STREAMS",
    )

    while True:
        try:
            msgs = await sub.fetch(batch=2, timeout=5)
        except asyncio.TimeoutError:
            continue
        for m in msgs:
            try:
                await handle_provision(js, pool, forker, cfg, m)
            except Exception:
                log.exception("provision_failed")
                try:
                    await m.nak(delay=5)
                except Exception:
                    pass
