import asyncio
import json
import os
import socket
from typing import Optional, Tuple

import psycopg

from py_common import logging_setup, nats_client
from worker_stream_supervisor.pool import PortPool, PoolFull
from worker_stream_supervisor.forker import Forker
from worker_stream_supervisor.reaper import reaper_loop

log = logging_setup.setup("worker-stream-supervisor")


def _config() -> dict:
    # URL-pull model: pods pull source URLs as outbound HTTPS, so there are no
    # inbound media ports. The supervisor manages the WS fan-out port range that
    # the gateway proxies to, plus a second SRT port range allocated only for
    # streams that request caption_ts (the pod pushes an SRT caption feed).
    port_start = int(os.environ.get("STREAM_WS_PORT_START", "10000"))
    port_end   = int(os.environ.get("STREAM_WS_PORT_END",   "10009"))
    ws_host = os.environ.get("STREAM_WS_HOST", socket.gethostname())
    return {
        "DATABASE_URL": os.environ["DATABASE_URL"],
        "WS_HOST":      ws_host,
        "PORT_START":   port_start,
        "PORT_END":     port_end,
        "MAX_PODS":     int(os.environ.get("STREAM_MAX_PODS", str(port_end - port_start + 1))),
        "POD_CMD":      os.environ.get("STREAM_POD_CMD", "python -m worker_stream_pod").split(),
        "REAP_INTERVAL_S":   int(os.environ.get("STREAM_REAP_INTERVAL_S", "15")),
        "POD_STALE_AFTER_S": int(os.environ.get("STREAM_POD_STALE_AFTER_S", "30")),
        "SRT_PORT_START":  int(os.environ.get("STREAM_SRT_PORT_START", "11000")),
        "SRT_PORT_END":    int(os.environ.get("STREAM_SRT_PORT_END",   "11009")),
        "SRT_PUBLIC_HOST": os.environ.get("SRT_PUBLIC_HOST", ws_host),
    }


def srt_env(caption_ts: bool, srt_pool: PortPool, sid: str) -> Tuple[dict, Optional[int]]:
    if not caption_ts:
        return {}, None
    port = srt_pool.allocate(sid)
    return (
        {"POD_CAPTION_TS": "1", "POD_SRT_PORT": str(port), "POD_SRT_HOST": "0.0.0.0"},
        port,
    )


async def handle_provision(js, pool: PortPool, srt_pool: PortPool, forker: Forker, cfg: dict, msg) -> None:
    env = nats_client.decode(msg.data)
    payload = env["payload"] if "payload" in env else env  # supervisor messages may be raw payload
    sid = payload["stream_id"]
    tenant = payload["tenant_id"]
    source = payload["source"]  # {kind, url, headers?}

    if forker.active_count() >= cfg["MAX_PODS"]:
        await _publish_failed(js, sid, "STREAM_PROVISION_FAILED", "max pod capacity reached")
        await msg.ack()
        log.warning("provision_rejected_capacity", extra={"stream_id": sid})
        return

    try:
        ws_port = pool.allocate(sid)
    except PoolFull:
        await _publish_failed(js, sid, "STREAM_PROVISION_FAILED", "no free WS ports")
        await msg.ack()
        return

    try:
        add_env, srt_port = srt_env(bool(payload.get("caption_ts")), srt_pool, sid)
    except PoolFull:
        pool.free(sid)
        await _publish_failed(js, sid, "STREAM_PROVISION_FAILED", "no free SRT ports")
        await msg.ack()
        return

    pod_id = f"p_{sid[2:]}"
    # The source descriptor (incl. headers) reaches the pod via env only — held in
    # NATS JetStream (encrypted at rest) and pod memory, never written to disk.
    spawn_env = {
        "STREAM_ID":           sid,
        "POD_ID":              pod_id,
        "WS_HOST":             cfg["WS_HOST"],
        "POD_WS_PORT":         str(ws_port),
        "SOURCE_KIND":         source["kind"],
        "SOURCE_URL":          source["url"],
        "SOURCE_HEADERS_JSON": json.dumps(source.get("headers") or {}),
        "OPTIONS_JSON":        json.dumps(payload.get("options", {}) or {}),
        "TARGET_LANG":         payload.get("target_lang", "en"),
        "DATABASE_URL":        cfg["DATABASE_URL"],
        "NATS_URL":            os.environ.get("NATS_URL", "nats://nats:4222"),
    }
    spawn_env.update(add_env)
    forker.spawn(stream_id=sid, env=spawn_env)

    async with await psycopg.AsyncConnection.connect(cfg["DATABASE_URL"]) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO stream_pods (pod_id, supervisor_host, ws_host, ws_port, srt_port, stream_id, status) "
                "VALUES (%s, %s, %s, %s, %s, %s, 'starting') "
                "ON CONFLICT (pod_id) DO UPDATE SET ws_host=EXCLUDED.ws_host, ws_port=EXCLUDED.ws_port, srt_port=EXCLUDED.srt_port, status='starting', last_heartbeat=now()",
                (pod_id, socket.gethostname(), cfg["WS_HOST"], ws_port, srt_port, sid),
            )
            await cur.execute(
                "UPDATE streams SET pod_id=%s WHERE id=%s",
                (pod_id, sid),
            )
        await conn.commit()

    ready_payload = {
        "stream_id": sid,
        "pod_id":    pod_id,
        "ws_host":   cfg["WS_HOST"],
        "ws_port":   ws_port,
        "srt_port":  srt_port,
    }
    await js.publish(nats_client.SUBJECTS["STREAM_READY"], nats_client.encode(ready_payload))
    await msg.ack()
    log.info("pod_spawned", extra={"stream_id": sid, "pod_id": pod_id, "ws_port": ws_port, "srt_port": srt_port})


async def _publish_failed(js, stream_id: str, code: str, message: str) -> None:
    await js.publish(nats_client.SUBJECTS["STREAM_FAILED"], nats_client.encode({
        "stream_id": stream_id, "code": code, "message": message,
    }))


async def handle_delete(js, pool: PortPool, srt_pool: PortPool, forker: Forker, cfg: dict, msg) -> None:
    env = nats_client.decode(msg.data)
    payload = env["payload"] if "payload" in env else env
    sid = payload["stream_id"]

    # Look up pod_id before terminating so we can update stream_pods
    pod_id: str | None = None
    try:
        async with await psycopg.AsyncConnection.connect(cfg["DATABASE_URL"]) as conn:
            async with conn.cursor() as cur:
                await cur.execute("SELECT pod_id FROM streams WHERE id=%s", (sid,))
                row = await cur.fetchone()
                if row:
                    pod_id = row[0]
    except Exception:
        log.exception("delete_lookup_failed", extra={"stream_id": sid})

    forker.terminate(sid)
    pool.free(sid)
    # free() is a no-op when the stream never held an SRT port (caption_ts off).
    srt_pool.free(sid)

    if pod_id:
        try:
            async with await psycopg.AsyncConnection.connect(cfg["DATABASE_URL"]) as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "UPDATE stream_pods SET status='terminated' WHERE pod_id=%s",
                        (pod_id,),
                    )
                await conn.commit()
        except Exception:
            log.exception("delete_update_failed", extra={"stream_id": sid, "pod_id": pod_id})

    await msg.ack()
    log.info("pod_terminated", extra={"stream_id": sid, "pod_id": pod_id})


async def main():
    cfg = _config()
    pool = PortPool(start=cfg["PORT_START"], end=cfg["PORT_END"])
    srt_pool = PortPool(start=cfg["SRT_PORT_START"], end=cfg["SRT_PORT_END"])
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

    provision_durable = "stream-supervisor"
    try:
        await js.add_consumer(
            "AUDIO_STREAMS",
            durable_name=provision_durable,
            filter_subject=nats_client.SUBJECTS["STREAM_PROVISION_REQUESTED"],
            ack_policy="explicit",
            max_deliver=3,
        )
    except Exception:
        pass

    delete_durable = "stream-supervisor-delete"
    try:
        await js.add_consumer(
            "AUDIO_STREAMS",
            durable_name=delete_durable,
            filter_subject=nats_client.SUBJECTS["STREAM_DELETE_REQUESTED"],
            ack_policy="explicit",
            max_deliver=3,
        )
    except Exception:
        pass

    provision_sub = await js.pull_subscribe(
        subject=nats_client.SUBJECTS["STREAM_PROVISION_REQUESTED"],
        durable=provision_durable,
        stream="AUDIO_STREAMS",
    )

    delete_sub = await js.pull_subscribe(
        subject=nats_client.SUBJECTS["STREAM_DELETE_REQUESTED"],
        durable=delete_durable,
        stream="AUDIO_STREAMS",
    )

    async def provision_loop():
        while True:
            try:
                msgs = await provision_sub.fetch(batch=2, timeout=5)
            except asyncio.TimeoutError:
                continue
            for m in msgs:
                try:
                    await handle_provision(js, pool, srt_pool, forker, cfg, m)
                except Exception:
                    log.exception("provision_failed")
                    try:
                        await m.nak(delay=5)
                    except Exception:
                        pass

    async def delete_loop():
        while True:
            try:
                msgs = await delete_sub.fetch(batch=2, timeout=5)
            except asyncio.TimeoutError:
                continue
            for m in msgs:
                try:
                    await handle_delete(js, pool, srt_pool, forker, cfg, m)
                except Exception:
                    log.exception("delete_failed")
                    try:
                        await m.nak(delay=5)
                    except Exception:
                        pass

    await asyncio.gather(
        provision_loop(),
        delete_loop(),
        reaper_loop(
            js,
            cfg["DATABASE_URL"],
            interval_s=cfg["REAP_INTERVAL_S"],
            stale_after_s=cfg["POD_STALE_AFTER_S"],
        ),
    )
