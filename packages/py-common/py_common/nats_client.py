import json
import os
from datetime import datetime, timezone
from typing import Optional
import nats
from nats.aio.client import Client
from nats.js import JetStreamContext

SUBJECTS = {
    "WORK_FETCH":         "audio.work.fetch",
    "WORK_FORMAT":        "audio.work.format",
    "EVENT_FILE_READY":   "audio.event.file.ready",
    "EVENT_FORMAT_READY": "audio.event.format.ready",
    "EVENT_JOB_DONE":     "audio.event.job.completed",
    "EVENT_JOB_FAILED":   "audio.event.job.failed",
}

async def connect() -> tuple[Client, JetStreamContext]:
    url = os.environ.get("NATS_URL", "nats://localhost:4222")
    nc = await nats.connect(url, max_reconnect_attempts=-1)
    js = nc.jetstream()
    return nc, js

def envelope(job_id: str, tenant_id: str, trace_id: str, attempt_id: str, payload: dict) -> dict:
    return {
        "job_id": job_id,
        "tenant_id": tenant_id,
        "trace_id": trace_id,
        "attempt_id": attempt_id,
        "emitted_at": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
    }

def encode(obj: dict) -> bytes:
    return json.dumps(obj).encode("utf-8")

def decode(data: bytes) -> dict:
    return json.loads(data.decode("utf-8"))
