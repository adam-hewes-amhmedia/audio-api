import asyncio
import json
import os
import tempfile

from py_common import logging_setup, telemetry, nats_client, storage
from py_common.errors import StageError
from worker_dme_classify.classify import classify

log = logging_setup.setup("worker-dme-classify")
tracer = telemetry.setup("worker-dme-classify")


async def handle(env: dict, s3) -> dict:
    job_id = env["job_id"]
    payload = env.get("payload") or {}
    src_key = payload.get("object_key") or payload.get("source_object_key") or f"working/{job_id}/source.bin"
    seg_ms = int(payload.get("segment_ms", 1000))
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as t:
        tmp = t.name
    try:
        storage.download_to_file(s3, src_key, tmp)
        try:
            result = classify(tmp, segment_ms=seg_ms)
        except Exception as e:
            raise StageError("DME_CLASSIFY_FAILED", str(e), retryable=True)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass

    key = f"results/{job_id}/dme_classify.json"
    storage.upload_bytes(s3, key, json.dumps(result).encode("utf-8"))
    result["result_object"] = key
    return result


async def main():
    nc, js = await nats_client.connect()
    s3 = storage.client()
    log.info("worker-dme-classify consuming", subject=nats_client.SUBJECTS["WORK_DME_CLASSIFY"])

    durable = "worker-dme-classify"
    try:
        await js.add_consumer(
            "AUDIO_WORK",
            durable_name=durable,
            filter_subject=nats_client.SUBJECTS["WORK_DME_CLASSIFY"],
            ack_policy="explicit",
            max_deliver=3,
        )
    except Exception:
        pass

    sub = await js.pull_subscribe(
        subject=nats_client.SUBJECTS["WORK_DME_CLASSIFY"],
        durable=durable,
        stream="AUDIO_WORK",
    )

    while True:
        try:
            msgs = await sub.fetch(batch=1, timeout=5)
        except asyncio.TimeoutError:
            continue
        for m in msgs:
            try:
                env = nats_client.decode(m.data)
            except Exception:
                await m.ack()
                continue
            with tracer.start_as_current_span(
                "stage.dme_classify",
                attributes={"job_id": env.get("job_id", ""), "trace_id": env.get("trace_id", "")},
            ):
                try:
                    out = await handle(env, s3)
                    evt = nats_client.envelope(
                        job_id=env["job_id"], tenant_id=env["tenant_id"],
                        trace_id=env["trace_id"], attempt_id=env["attempt_id"],
                        payload=out,
                    )
                    await js.publish(nats_client.SUBJECTS["EVENT_DME_CLASSIFY_READY"], nats_client.encode(evt))
                    await m.ack()
                    log.info("dme_classify.done", job_id=env["job_id"])
                except StageError as e:
                    if m.metadata.num_delivered >= 3:
                        fail = nats_client.envelope(
                            env["job_id"], env["tenant_id"], env["trace_id"], env["attempt_id"],
                            {"stage": "dme_classify", "code": e.code, "message": str(e)},
                        )
                        await js.publish(nats_client.SUBJECTS["EVENT_JOB_FAILED"], nats_client.encode(fail))
                        await m.ack()
                    else:
                        await m.nak(delay=5)
                    log.error("dme_classify.failed", code=e.code, msg=str(e))
