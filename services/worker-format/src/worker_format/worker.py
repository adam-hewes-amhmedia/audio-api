import asyncio
import json
import os
import tempfile
from datetime import datetime, timezone

from py_common import logging_setup, telemetry, nats_client, storage
from py_common.errors import StageError
from worker_format.probe import probe, ProbeError

log = logging_setup.setup("worker-format")
tracer = telemetry.setup("worker-format")

async def handle(env: dict, s3) -> dict:
    job_id = env["job_id"]
    payload = env["payload"]
    src_key = payload.get("object_key") or payload.get("source_object_key") or f"working/{job_id}/source.bin"
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        storage.download_to_file(s3, src_key, tmp_path)
        try:
            result = probe(tmp_path)
        except ProbeError as e:
            raise StageError("FORMAT_PROBE_FAILED", str(e), retryable=True)
    finally:
        try: os.unlink(tmp_path)
        except FileNotFoundError: pass

    result_key = f"results/{job_id}/format.json"
    storage.upload_bytes(s3, result_key, json.dumps(result).encode("utf-8"))
    result["result_object"] = result_key
    return result

async def main():
    nc, js = await nats_client.connect()
    s3 = storage.client()
    log.info("worker-format consuming", subject=nats_client.SUBJECTS["WORK_FORMAT"])

    durable = "worker-format"
    try:
        await js.add_consumer(
            "AUDIO_WORK",
            durable_name=durable,
            filter_subject=nats_client.SUBJECTS["WORK_FORMAT"],
            ack_policy="explicit",
            max_deliver=3,
        )
    except Exception:
        pass

    sub = await js.pull_subscribe(
        subject=nats_client.SUBJECTS["WORK_FORMAT"],
        durable=durable,
        stream="AUDIO_WORK",
    )

    while True:
        try:
            msgs = await sub.fetch(batch=4, timeout=5)
        except asyncio.TimeoutError:
            continue
        for m in msgs:
            try:
                env = nats_client.decode(m.data)
            except Exception:
                await m.ack()
                continue
            with tracer.start_as_current_span(
                "stage.format",
                attributes={"job_id": env.get("job_id", ""), "trace_id": env.get("trace_id", "")}
            ):
                try:
                    out = await handle(env, s3)
                    evt = nats_client.envelope(
                        job_id=env["job_id"], tenant_id=env["tenant_id"],
                        trace_id=env["trace_id"], attempt_id=env["attempt_id"],
                        payload=out
                    )
                    await js.publish(nats_client.SUBJECTS["EVENT_FORMAT_READY"], nats_client.encode(evt))
                    await m.ack()
                    log.info("format.done", job_id=env["job_id"], duration_s=out.get("duration_s"))
                except StageError as e:
                    if m.metadata.num_delivered >= 3:
                        fail = nats_client.envelope(
                            env["job_id"], env["tenant_id"], env["trace_id"], env["attempt_id"],
                            {"stage": "format", "code": e.code, "message": str(e)}
                        )
                        await js.publish(nats_client.SUBJECTS["EVENT_JOB_FAILED"], nats_client.encode(fail))
                        await m.ack()
                    else:
                        await m.nak(delay=5)
                    log.error("format.failed", code=e.code, msg=str(e))
