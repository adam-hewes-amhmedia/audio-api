# Audio API Plan 2: VAD + Sync Mode + Webhooks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prereq:** Plan 1 complete. The format-only slice works end-to-end. The patterns established in Plan 1 (worker scaffold, NATS consumer, MinIO result persistence, orchestrator dispatch, aggregator merge) are reused here.

**Goal:** Add VAD as the second analysis (proves the "add a worker" pattern), turn on synchronous job submission, and ship HMAC-signed webhook delivery with retries.

**Architecture:**
- VAD worker is a new Python service following the same shape as `worker-format`.
- Sync mode uses Postgres `LISTEN/NOTIFY` to wake the gateway when the aggregator finishes the job.
- Webhook delivery is a new Node service (`worker-webhook`) consuming `audio.event.job.completed` and POSTing to the caller's `callback_url`.

**Tech Stack additions:**
- Python: `silero-vad` (or `webrtcvad-wheels` as a lighter fallback), `soundfile`, `numpy`
- Node: `node:crypto` for HMAC (no new deps)
- Postgres: `pg_notify` and `LISTEN` channel per `job_id` for sync completion

**Reference:** `docs/superpowers/specs/2026-05-14-audio-api-design.md`.

---

## File Structure (changes in this plan)

```
audio-api/
  services/
    worker-vad/                                   NEW
      pyproject.toml
      Dockerfile
      src/worker_vad/
        __init__.py
        __main__.py
        vad.py
        worker.py
      tests/test_vad.py
    worker-webhook/                                NEW
      package.json
      tsconfig.json
      Dockerfile
      src/index.ts
      src/sign.ts
      src/deliver.ts
      tests/sign.test.ts
      tests/deliver.test.ts
    api-gateway/
      src/routes/jobs.ts                           MODIFIED - sync mode wait
      src/sync-waiter.ts                           NEW - LISTEN/NOTIFY helper
      tests/jobs-sync.test.ts                      NEW
    orchestrator/
      src/pipeline.ts                              MODIFIED - fan out vad after format
      src/index.ts                                 MODIFIED - handle vad.ready
      tests/pipeline.test.ts                       MODIFIED
    aggregator/
      src/aggregate.ts                             MODIFIED - include vad
      src/index.ts                                 MODIFIED - wait for vad too, fire pg_notify
      tests/aggregate.test.ts                      MODIFIED
  packages/
    proto/
      schemas/events/vad-ready.json                NEW
      src/index.ts                                 MODIFIED - VadReady + subject
    contracts/
      openapi.yaml                                 MODIFIED - analyses enum + webhook docs
      error-codes.yaml                             MODIFIED - add WEBHOOK_DELIVERY_FAILED
  infra/
    migrations/0002_tenant_webhook_secret.sql      NEW - store HMAC secret per tenant
    docker-compose.yml                             MODIFIED - add worker-vad and worker-webhook
  tests/
    fixtures/audio/sample-speech.wav               NEW - 5s spoken-word fixture for VAD test
```

---

## Task 1: VAD event schema and proto updates

**Files:**
- Create: `audio-api/packages/proto/schemas/events/vad-ready.json`
- Modify: `audio-api/packages/proto/src/index.ts`
- Modify: `audio-api/packages/proto/src/index.test.ts`

- [ ] **Step 1: Create `vad-ready.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "events/vad-ready.json",
  "type": "object",
  "required": ["result_object", "per_channel"],
  "properties": {
    "result_object": { "type": "string" },
    "per_channel": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["channel", "speech_ratio", "segments"],
        "properties": {
          "channel": { "type": "integer" },
          "speech_ratio": { "type": "number" },
          "segments": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["start_ms", "end_ms"],
              "properties": {
                "start_ms": { "type": "integer" },
                "end_ms": { "type": "integer" }
              }
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Update `packages/proto/src/index.ts`**

Add the validator and the new subject:

```ts
export const validateVadReady = load("events/vad-ready.json");

export interface VadSegment { start_ms: number; end_ms: number; }
export interface VadPerChannel { channel: number; speech_ratio: number; segments: VadSegment[]; }
export interface VadReady { result_object: string; per_channel: VadPerChannel[]; }

// Append to SUBJECTS:
//   WORK_VAD:         "audio.work.vad",
//   EVENT_VAD_READY:  "audio.event.vad.ready",
```

Modify the `SUBJECTS` block to include:

```ts
export const SUBJECTS = {
  WORK_FETCH:         "audio.work.fetch",
  WORK_FORMAT:        "audio.work.format",
  WORK_VAD:           "audio.work.vad",
  EVENT_FILE_READY:   "audio.event.file.ready",
  EVENT_FORMAT_READY: "audio.event.format.ready",
  EVENT_VAD_READY:    "audio.event.vad.ready",
  EVENT_JOB_DONE:     "audio.event.job.completed",
  EVENT_JOB_FAILED:   "audio.event.job.failed"
} as const;
```

- [ ] **Step 3: Add a test for the validator**

Append to `packages/proto/src/index.test.ts`:

```ts
import { validateVadReady } from "./index.js";

describe("vad-ready schema", () => {
  it("validates a per-channel structure", () => {
    expect(validateVadReady({ result_object: "x", per_channel: [
      { channel: 0, speech_ratio: 0.5, segments: [{ start_ms: 0, end_ms: 100 }] }
    ]})).toBe(true);
    expect(validateVadReady({ result_object: "x", per_channel: [{ channel: 0 }] })).toBe(false);
  });
});
```

- [ ] **Step 4: Build, test, commit**

```bash
cd audio-api/packages/proto && pnpm test && pnpm build
git add audio-api/packages/proto
git commit -m "feat(proto): VadReady schema and audio.work.vad / event.vad.ready subjects"
```

Update Python equivalents:

- [ ] **Step 5: Mirror SUBJECTS additions in Python**

Edit `audio-api/packages/py-common/py_common/nats_client.py` - add `"WORK_VAD": "audio.work.vad"` and `"EVENT_VAD_READY": "audio.event.vad.ready"` to the `SUBJECTS` dict.

- [ ] **Step 6: Commit**

```bash
git add audio-api/packages/py-common
git commit -m "feat(py-common): add vad subjects to py-common"
```

---

## Task 2: Worker-vad (Python)

**Files:**
- Create: `audio-api/services/worker-vad/pyproject.toml`
- Create: `audio-api/services/worker-vad/Dockerfile`
- Create: `audio-api/services/worker-vad/src/worker_vad/__init__.py`
- Create: `audio-api/services/worker-vad/src/worker_vad/__main__.py`
- Create: `audio-api/services/worker-vad/src/worker_vad/vad.py`
- Create: `audio-api/services/worker-vad/src/worker_vad/worker.py`
- Create: `audio-api/services/worker-vad/tests/test_vad.py`
- Create: `audio-api/tests/fixtures/audio/sample-speech.wav`

- [ ] **Step 1: Generate the speech fixture**

`tests/fixtures/audio/sample-speech.wav` needs real spoken audio (synthetic sine won't trigger Silero VAD). Use a public-domain TTS or LibriVox snippet.

For deterministic CI, generate using `espeak-ng` if available:

```bash
sudo apt-get install -y espeak-ng
espeak-ng -w audio-api/tests/fixtures/audio/sample-speech.wav \
  "This is a short test of the audio analysis pipeline. Hello, world."
# Re-encode to 16-bit 16kHz mono - Silero's expected input shape
ffmpeg -y -i audio-api/tests/fixtures/audio/sample-speech.wav \
  -ac 1 -ar 16000 -sample_fmt s16 \
  audio-api/tests/fixtures/audio/sample-speech.wav.tmp \
  && mv audio-api/tests/fixtures/audio/sample-speech.wav.tmp \
        audio-api/tests/fixtures/audio/sample-speech.wav
```

If espeak-ng isn't available, fall back to a committed LibriVox snippet (download in step 1 of CI). The fixture file (small, ~100KB) IS committed to the repo.

- [ ] **Step 2: `pyproject.toml`**

```toml
[project]
name = "worker-vad"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "py-common @ file:../../packages/py-common",
  "silero-vad>=5.0.0",
  "soundfile>=0.12.1",
  "numpy>=1.26.0",
  "torch>=2.2.0"
]
[project.optional-dependencies]
dev = ["pytest>=8.0.0"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.package-dir]
"" = "src"

[tool.setuptools.packages.find]
where = ["src"]
```

- [ ] **Step 3: `src/worker_vad/vad.py`**

```python
import numpy as np
import soundfile as sf
from silero_vad import load_silero_vad, get_speech_timestamps

_model = None
def model():
    global _model
    if _model is None:
        _model = load_silero_vad()
    return _model

def analyse(path: str) -> dict:
    audio, sr = sf.read(path, always_2d=True, dtype="float32")
    # audio shape: (frames, channels)
    per_channel = []
    duration_s = audio.shape[0] / sr
    for ch in range(audio.shape[1]):
        sig = audio[:, ch]
        # Silero expects mono 16kHz int16 or float. Resample if needed.
        if sr != 16000:
            import scipy.signal as sps  # type: ignore
            sig = sps.resample_poly(sig, 16000, sr).astype(np.float32)
            sr_eff = 16000
        else:
            sr_eff = sr
        ts = get_speech_timestamps(sig, model(), sampling_rate=sr_eff, return_seconds=False)
        segs = [{"start_ms": int(t["start"] / sr_eff * 1000),
                 "end_ms":   int(t["end"]   / sr_eff * 1000)} for t in ts]
        total_speech = sum(s["end_ms"] - s["start_ms"] for s in segs)
        ratio = (total_speech / 1000.0) / max(duration_s, 1e-9)
        per_channel.append({"channel": ch, "speech_ratio": round(ratio, 4), "segments": segs})
    return {"per_channel": per_channel, "duration_s": duration_s}
```

- [ ] **Step 4: Write failing test**

`tests/test_vad.py`:

```python
from pathlib import Path
import pytest
from worker_vad.vad import analyse

FIXTURE = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "audio" / "sample-speech.wav"

@pytest.mark.skipif(not FIXTURE.exists(), reason="fixture missing")
def test_analyse_returns_per_channel():
    out = analyse(str(FIXTURE))
    assert "per_channel" in out
    assert len(out["per_channel"]) >= 1
    ch0 = out["per_channel"][0]
    assert "speech_ratio" in ch0
    assert 0.0 <= ch0["speech_ratio"] <= 1.0
    # At least one speech segment found
    assert len(ch0["segments"]) >= 1
```

- [ ] **Step 5: Install and run**

```bash
cd audio-api/services/worker-vad
python -m venv .venv && source .venv/bin/activate
pip install -e "../../packages/py-common[dev]"
pip install -e ".[dev]"
pytest -q
```
Expected: 1 passed (1 skipped if fixture not yet generated).

- [ ] **Step 6: `src/worker_vad/worker.py` (follows worker-format pattern)**

```python
import asyncio
import json
import os
import tempfile

from py_common import logging_setup, telemetry, nats_client, storage
from py_common.errors import StageError
from worker_vad.vad import analyse

log = logging_setup.setup("worker-vad")
tracer = telemetry.setup("worker-vad")

async def handle(env: dict, s3) -> dict:
    job_id = env["job_id"]
    src_key = env["payload"].get("source_object_key") or f"working/{job_id}/source.bin"
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as t:
        tmp = t.name
    try:
        storage.download_to_file(s3, src_key, tmp)
        try:
            result = analyse(tmp)
        except Exception as e:
            raise StageError("VAD_MODEL_FAILED", str(e), retryable=True)
    finally:
        try: os.unlink(tmp)
        except FileNotFoundError: pass

    result_key = f"results/{job_id}/vad.json"
    storage.upload_bytes(s3, result_key, json.dumps(result).encode("utf-8"))
    result["result_object"] = result_key
    return result

async def main():
    nc, js = await nats_client.connect()
    s3 = storage.client()
    log.info("worker-vad consuming")

    durable = "worker-vad"
    try:
        await js.add_consumer("AUDIO_WORK",
            durable_name=durable, filter_subject=nats_client.SUBJECTS["WORK_VAD"],
            ack_policy="explicit", max_deliver=3)
    except Exception: pass

    sub = await js.pull_subscribe(
        subject=nats_client.SUBJECTS["WORK_VAD"], durable=durable, stream="AUDIO_WORK"
    )
    while True:
        try:
            msgs = await sub.fetch(batch=2, timeout=5)
        except asyncio.TimeoutError:
            continue
        for m in msgs:
            env = nats_client.decode(m.data)
            with tracer.start_as_current_span("stage.vad", attributes={"job_id": env["job_id"]}):
                try:
                    out = await handle(env, s3)
                    evt = nats_client.envelope(
                        env["job_id"], env["tenant_id"], env["trace_id"], env["attempt_id"], out
                    )
                    await js.publish(nats_client.SUBJECTS["EVENT_VAD_READY"], nats_client.encode(evt))
                    await m.ack()
                    log.info("vad.done", job_id=env["job_id"])
                except StageError as e:
                    if m.metadata.num_delivered >= 3:
                        fail = nats_client.envelope(env["job_id"], env["tenant_id"], env["trace_id"], env["attempt_id"],
                                                    {"stage": "vad", "code": e.code, "message": str(e)})
                        await js.publish(nats_client.SUBJECTS["EVENT_JOB_FAILED"], nats_client.encode(fail))
                        await m.ack()
                    else:
                        await m.nak(delay=5)
                    log.error("vad.failed", code=e.code, msg=str(e))

if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 7: `__main__.py`**

```python
from worker_vad.worker import main
import asyncio
if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 8: `__init__.py`**

```python
__all__ = ["vad", "worker"]
```

- [ ] **Step 9: Dockerfile**

```dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY packages/py-common /app/packages/py-common
COPY services/worker-vad /app/services/worker-vad
WORKDIR /app/services/worker-vad
RUN pip install --no-cache-dir -e ../../packages/py-common
RUN pip install --no-cache-dir -e .
RUN useradd -u 1000 -m runner && chown -R runner:runner /app
USER runner
CMD ["python", "-m", "worker_vad"]
```

- [ ] **Step 10: Commit**

```bash
git add audio-api/services/worker-vad audio-api/tests/fixtures/audio/sample-speech.wav
git commit -m "feat(worker-vad): Silero VAD worker, per-channel speech timeline"
```

---

## Task 3: Orchestrator dispatches VAD; aggregator waits for it

**Files:**
- Modify: `audio-api/services/orchestrator/src/pipeline.ts`
- Modify: `audio-api/services/orchestrator/src/index.ts`
- Modify: `audio-api/services/orchestrator/tests/pipeline.test.ts`
- Modify: `audio-api/services/aggregator/src/aggregate.ts`
- Modify: `audio-api/services/aggregator/src/index.ts`
- Modify: `audio-api/services/aggregator/tests/aggregate.test.ts`

- [ ] **Step 1: Update orchestrator pipeline rules + test**

Replace `nextStepsAfterFormatReady` in `pipeline.ts`:

```ts
const FANOUT_AFTER_FORMAT = new Set(["vad", "language", "dme_classify"]);

export function nextStepsAfterFormatReady(job: JobAnalyses): string[] {
  return job.analyses.filter(a => FANOUT_AFTER_FORMAT.has(a));
}
```

Update the test:

```ts
it("format.ready dispatches vad when requested", () => {
  expect(nextStepsAfterFormatReady({ analyses: ["format", "vad"] })).toEqual(["vad"]);
  expect(nextStepsAfterFormatReady({ analyses: ["format"] })).toEqual([]);
});
```

Run: `pnpm test`. Expected: PASS.

- [ ] **Step 2: Wire vad subject into orchestrator dispatch map**

In `services/orchestrator/src/index.ts`, update `subjectMap`:

```ts
const subjectMap: Record<string, string> = {
  format: SUBJECTS.WORK_FORMAT,
  vad:    SUBJECTS.WORK_VAD
};
```

Also add `audio.event.vad.ready` to the consumer's filter_subjects:

```ts
filter_subjects: [
  "audio.event.file.ready",
  "audio.event.format.ready",
  "audio.event.vad.ready",
  "audio.event.job.failed"
]
```

And handle it in the event loop:

```ts
} else if (subject === SUBJECTS.EVENT_VAD_READY) {
  await getPool().query(
    "UPDATE analyses SET status='completed', completed_at=now(), result_object=$3 WHERE job_id=$1 AND name=$2",
    [env.job_id, "vad", env.payload.result_object]
  );
  await getPool().query(
    "INSERT INTO job_events (job_id, kind, stage, payload) VALUES ($1,'stage_completed','vad',$2)",
    [env.job_id, env.payload]
  );
}
```

- [ ] **Step 3: Update aggregator to include VAD**

In `services/aggregator/src/aggregate.ts`:

```ts
export function buildReport(a: BuildReportArgs) {
  const out: any = { job_id: a.job_id, input: a.input, failures: a.failures };
  if (a.perAnalysis.format) {
    const f = a.perAnalysis.format;
    out.format = {
      codec: f.codec, sample_rate: f.sample_rate, bit_depth: f.bit_depth,
      channel_count: f.channel_count, channel_layout: f.channel_layout,
      channels: Array.from({ length: f.channel_count }, (_, i) => ({ index: i, label: `ch${i}` }))
    };
  }
  if (a.perAnalysis.vad) {
    out.vad = { per_channel: a.perAnalysis.vad.per_channel };
  }
  return out;
}
```

- [ ] **Step 4: Update aggregator test**

Append:

```ts
it("includes vad when present", () => {
  const r = buildReport({
    job_id: "j_x", input: { duration_s: 5, size_bytes: 100 },
    perAnalysis: {
      format: { codec: "pcm_s16le", sample_rate: 48000, channel_count: 1, channel_layout: "mono", duration_s: 5 },
      vad: { per_channel: [{ channel: 0, speech_ratio: 0.4, segments: [{ start_ms: 0, end_ms: 200 }] }] }
    },
    failures: []
  });
  expect(r.vad.per_channel[0].channel).toBe(0);
});
```

Run: `pnpm test`. Expected: PASS.

- [ ] **Step 5: Aggregator must now also subscribe to vad.ready**

In `services/aggregator/src/index.ts`:

```ts
filter_subjects: ["audio.event.format.ready", "audio.event.vad.ready"]
```

- [ ] **Step 6: Commit**

```bash
git add audio-api/services/orchestrator audio-api/services/aggregator
git commit -m "feat(pipeline): dispatch and aggregate VAD alongside format"
```

---

## Task 4: Update API gateway to accept `vad`

**Files:**
- Modify: `audio-api/services/api-gateway/src/routes/jobs.ts`
- Modify: `audio-api/packages/contracts/openapi.yaml`
- Modify: `audio-api/services/api-gateway/tests/jobs-post.test.ts`

- [ ] **Step 1: Allow `vad` in the validation set**

In `routes/jobs.ts`:

```ts
const VALID_ANALYSES = new Set(["format", "vad"]);
```

- [ ] **Step 2: Update OpenAPI enum**

In `openapi.yaml` under `JobSubmission.analyses.items`:

```yaml
items: { type: string, enum: [format, vad] }
```

- [ ] **Step 3: Add a test**

In `jobs-post.test.ts`:

```ts
it("accepts vad as an analysis", async () => {
  const app = await buildServer();
  const res = await app.inject({
    method: "POST", url: "/v1/jobs",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { input: { type: "url", url: "https://example.com/a.wav" }, analyses: ["format", "vad"] }
  });
  expect(res.statusCode).toBe(201);
  await app.close();
});
```

Run tests. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add audio-api/services/api-gateway audio-api/packages/contracts
git commit -m "feat(api-gateway): accept vad analysis"
```

---

## Task 5: Sync mode (Postgres LISTEN/NOTIFY waiter)

**Files:**
- Create: `audio-api/services/api-gateway/src/sync-waiter.ts`
- Modify: `audio-api/services/api-gateway/src/routes/jobs.ts`
- Modify: `audio-api/services/aggregator/src/index.ts`
- Create: `audio-api/services/api-gateway/tests/jobs-sync.test.ts`

- [ ] **Step 1: Aggregator fires NOTIFY after finalising**

In `services/aggregator/src/index.ts`, after the UPDATE of jobs status, add:

```ts
await getPool().query(`SELECT pg_notify('job_done', $1)`, [jobId]);
```

- [ ] **Step 2: Implement `src/sync-waiter.ts`**

```ts
import pg from "pg";

export async function waitForCompletion(jobId: string, timeoutMs: number): Promise<"completed" | "failed" | "timeout"> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("LISTEN job_done");

    // Race condition guard: was the job already done before we started listening?
    const r = await client.query("SELECT status FROM jobs WHERE id=$1", [jobId]);
    if (r.rowCount && (r.rows[0].status === "completed" || r.rows[0].status === "failed")) {
      return r.rows[0].status;
    }

    return await new Promise<"completed" | "failed" | "timeout">(resolve => {
      const t = setTimeout(() => resolve("timeout"), timeoutMs);
      client.on("notification", async msg => {
        if (msg.payload === jobId) {
          clearTimeout(t);
          const r2 = await client.query("SELECT status FROM jobs WHERE id=$1", [jobId]);
          resolve(r2.rows[0]?.status === "failed" ? "failed" : "completed");
        }
      });
    });
  } finally {
    await client.end().catch(() => {});
  }
}
```

- [ ] **Step 3: Wire sync mode into POST /v1/jobs**

In `routes/jobs.ts`, after creating the job and publishing the fetch message, check the mode:

```ts
if (body.mode === "sync") {
  const timeout = Number(process.env.SYNC_TIMEOUT_MS ?? 60000);
  const outcome = await waitForCompletion(id, timeout);
  if (outcome === "timeout") {
    return reply.code(202).send({ job_id: id, status: "running" });
  }
  const rep = await getPool().query("SELECT report FROM results WHERE job_id=$1", [id]);
  return reply.code(200).send(rep.rows[0]?.report ?? { job_id: id, status: outcome });
}

return reply.code(201).send({ job_id: id, status: "queued" });
```

Add import: `import { waitForCompletion } from "../sync-waiter.js";`

- [ ] **Step 4: Test**

`tests/jobs-sync.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { buildServer } from "../src/server.js";
import { getPool } from "@audio-api/node-common";

const TOKEN = "test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH = createHash("sha256").update(TOKEN).digest("hex");

beforeAll(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM api_tokens WHERE id = 't_test'");
  await pool.query("INSERT INTO api_tokens (id, tenant_id, token_hash) VALUES ('t_test','tenant_test',$1)", [HASH]);
});

describe("POST /v1/jobs sync mode", () => {
  it("returns 202 when not completed within timeout", async () => {
    process.env.SYNC_TIMEOUT_MS = "100";
    const app = await buildServer();
    const res = await app.inject({
      method: "POST", url: "/v1/jobs",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { input: { type: "url", url: "https://example.invalid/a.wav" }, analyses: ["format"], mode: "sync" }
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().job_id).toMatch(/^j_/);
    await app.close();
  });
});
```

Run: `pnpm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add audio-api/services/api-gateway/src/sync-waiter.ts audio-api/services/api-gateway/src/routes/jobs.ts audio-api/services/aggregator/src/index.ts audio-api/services/api-gateway/tests/jobs-sync.test.ts
git commit -m "feat(sync-mode): Postgres LISTEN/NOTIFY waiter for sync job completion"
```

---

## Task 6: Tenant webhook secret migration

**Files:**
- Create: `audio-api/infra/migrations/0002_tenant_webhook_secret.sql`

- [ ] **Step 1: Migration**

```sql
BEGIN;

CREATE TABLE tenant_secrets (
  tenant_id     TEXT PRIMARY KEY,
  webhook_secret TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at    TIMESTAMPTZ
);

INSERT INTO schema_migrations (version) VALUES ('0002');

COMMIT;
```

- [ ] **Step 2: Apply locally**

```bash
cd audio-api && make up
docker compose -f infra/docker-compose.yml exec -T postgres psql -U audio -d audio -f /migrations/0002_tenant_webhook_secret.sql
```
(The migrate one-shot will pick it up next clean boot; this runs it ad hoc.)

- [ ] **Step 3: Commit**

```bash
git add audio-api/infra/migrations/0002_tenant_webhook_secret.sql
git commit -m "feat(db): tenant_secrets table for HMAC webhook signing"
```

---

## Task 7: Worker-webhook (HMAC signing + retries)

**Files:**
- Create: `audio-api/services/worker-webhook/package.json`
- Create: `audio-api/services/worker-webhook/tsconfig.json`
- Create: `audio-api/services/worker-webhook/Dockerfile`
- Create: `audio-api/services/worker-webhook/src/sign.ts`
- Create: `audio-api/services/worker-webhook/src/deliver.ts`
- Create: `audio-api/services/worker-webhook/src/index.ts`
- Create: `audio-api/services/worker-webhook/tests/sign.test.ts`
- Create: `audio-api/services/worker-webhook/tests/deliver.test.ts`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@audio-api/worker-webhook",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "lint": "echo ok",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@audio-api/node-common": "workspace:*",
    "@audio-api/proto": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  }
}
```

- [ ] **Step 2: `tsconfig.json`** (same as other services)

- [ ] **Step 3: Test for signing**

`tests/sign.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sign } from "../src/sign.js";
import { createHmac } from "node:crypto";

describe("sign", () => {
  it("produces sha256 hmac over the body", () => {
    const body = '{"a":1}';
    const sig = sign(body, "supersecret");
    const expected = "sha256=" + createHmac("sha256", "supersecret").update(body).digest("hex");
    expect(sig).toBe(expected);
  });
});
```

- [ ] **Step 4: Implement `src/sign.ts`**

```ts
import { createHmac } from "node:crypto";

export function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}
```

Run: `pnpm test`. Expected: PASS.

- [ ] **Step 5: Test for the retry policy**

`tests/deliver.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { deliverWithRetries, BACKOFF_MS } from "../src/deliver.js";

describe("deliverWithRetries", () => {
  it("succeeds on first 2xx", async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200 } as Response));
    const result = await deliverWithRetries("https://x", "body", { sleep: async () => {}, fetchImpl: f as any });
    expect(result.attempts).toBe(1);
    expect(result.success).toBe(true);
  });
  it("retries 5 times then gives up", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 500 } as Response));
    const result = await deliverWithRetries("https://x", "body", { sleep: async () => {}, fetchImpl: f as any });
    expect(result.attempts).toBe(BACKOFF_MS.length);
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 6: Implement `src/deliver.ts`**

```ts
export const BACKOFF_MS = [0, 1000, 5000, 30_000, 120_000, 600_000]; // initial + 5 retries

export interface DeliverOpts {
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

export async function deliverWithRetries(url: string, body: string, opts: DeliverOpts = {}) {
  const sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const f = opts.fetchImpl ?? fetch;
  let lastStatus = 0;
  for (let i = 0; i < BACKOFF_MS.length; i++) {
    if (BACKOFF_MS[i] > 0) await sleep(BACKOFF_MS[i]);
    try {
      const res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
        body
      });
      lastStatus = res.status;
      if (res.ok) return { success: true, attempts: i + 1, status: res.status };
    } catch (e) {
      lastStatus = 0;
    }
  }
  return { success: false, attempts: BACKOFF_MS.length, status: lastStatus };
}
```

Run tests. Expected: PASS (both).

- [ ] **Step 7: Implement `src/index.ts`**

```ts
import {
  connectNats, getPool, createLogger, startTelemetry
} from "@audio-api/node-common";
import { SUBJECTS, Envelope } from "@audio-api/proto";
import { sign } from "./sign.js";
import { deliverWithRetries } from "./deliver.js";

startTelemetry("worker-webhook");
const log = createLogger("worker-webhook");

async function main() {
  const { nc, js, jsm } = await connectNats();

  await jsm.consumers.add("AUDIO_EVENTS", {
    durable_name: "worker-webhook",
    filter_subjects: [SUBJECTS.EVENT_JOB_DONE, SUBJECTS.EVENT_JOB_FAILED],
    ack_policy: "explicit" as any
  } as any).catch((e: any) => { if (!/exists/.test(String(e))) throw e; });

  const sub = await js.consumers.get("AUDIO_EVENTS", "worker-webhook").then(c => c.consume({ max_messages: 4 }));

  for await (const m of sub) {
    try {
      const env = JSON.parse(new TextDecoder().decode(m.data)) as Envelope<any>;
      const job = await getPool().query(
        "SELECT callback_url, tenant_id, status FROM jobs WHERE id=$1", [env.job_id]
      );
      if (!job.rowCount || !job.rows[0].callback_url) { m.ack(); continue; }

      const tenant = job.rows[0].tenant_id;
      const secretRow = await getPool().query(
        "SELECT webhook_secret FROM tenant_secrets WHERE tenant_id=$1", [tenant]
      );
      if (!secretRow.rowCount) { log.warn({ tenant }, "no webhook secret"); m.ack(); continue; }

      const payload = {
        event: m.subject === SUBJECTS.EVENT_JOB_DONE ? "job.completed" : "job.failed",
        job_id: env.job_id,
        status: job.rows[0].status,
        results_url: `${process.env.PUBLIC_API_URL ?? "http://localhost:8080"}/v1/jobs/${env.job_id}/results`
      };
      const body = JSON.stringify(payload);
      const sig = sign(body, secretRow.rows[0].webhook_secret);

      const result = await deliverWithRetries(job.rows[0].callback_url, body, {
        headers: { "X-Signature": sig, "X-Job-Id": env.job_id }
      });

      await getPool().query(
        `INSERT INTO job_events (job_id, kind, stage, payload) VALUES ($1, 'webhook_attempt', NULL, $2)`,
        [env.job_id, result]
      );
      m.ack();
      log.info({ job_id: env.job_id, ok: result.success, attempts: result.attempts }, "webhook.done");
    } catch (e: any) {
      log.error({ err: e }, "webhook.error");
      m.nak(5000);
    }
  }
}

main().catch(e => { log.error({ err: e }, "fatal"); process.exit(1); });
```

- [ ] **Step 8: Dockerfile (same shape as Plan 1 Node services)**

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY services/worker-webhook ./services/worker-webhook
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @audio-api/worker-webhook... build

FROM node:20-alpine AS runtime
USER node
WORKDIR /app
COPY --from=builder /repo/services/worker-webhook/dist ./dist
COPY --from=builder /repo/services/worker-webhook/package.json ./package.json
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ./packages
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
```

- [ ] **Step 9: Commit**

```bash
git add audio-api/services/worker-webhook
git commit -m "feat(worker-webhook): HMAC-signed callback delivery with exponential backoff"
```

---

## Task 8: Wire VAD + webhook into docker-compose; aggregator emits job.completed

**Files:**
- Modify: `audio-api/infra/docker-compose.yml`
- Modify: `audio-api/services/aggregator/src/index.ts`

- [ ] **Step 1: Aggregator must publish job.completed for the webhook worker**

In `aggregator/src/index.ts`, after writing results and updating job status, before the `m.ack()`:

```ts
await publish(js, SUBJECTS.EVENT_JOB_DONE, {
  job_id: jobId, tenant_id: env.tenant_id, trace_id: env.trace_id,
  attempt_id: env.attempt_id, emitted_at: new Date().toISOString(),
  payload: { status: finalStatus }
});
```

Import `publish` and `SUBJECTS` if not already.

- [ ] **Step 2: Add VAD and webhook services to compose**

In `infra/docker-compose.yml` under `services:`:

```yaml
  worker-vad:
    build: { context: .., dockerfile: services/worker-vad/Dockerfile }
    depends_on: [nats, minio]
    env_file: ../.env
    environment: { OTEL_SERVICE_NAME: worker-vad }

  worker-webhook:
    build: { context: .., dockerfile: services/worker-webhook/Dockerfile }
    depends_on: [nats, postgres]
    env_file: ../.env
    environment:
      OTEL_SERVICE_NAME: worker-webhook
      PUBLIC_API_URL: http://localhost:8080
```

- [ ] **Step 3: Bring up and verify**

```bash
cd audio-api && docker compose -f infra/docker-compose.yml build worker-vad worker-webhook
make up
docker compose -f infra/docker-compose.yml logs worker-vad | tail -5
# Expected: "worker-vad consuming"
docker compose -f infra/docker-compose.yml logs worker-webhook | tail -5
# Expected: subscriber running, no errors
```

- [ ] **Step 4: Commit**

```bash
git add audio-api/services/aggregator/src/index.ts audio-api/infra/docker-compose.yml
git commit -m "feat(infra): include worker-vad and worker-webhook; aggregator emits job.completed"
```

---

## Task 9: End-to-end smoke for VAD + webhook

**Files:**
- Modify: `audio-api/scripts/smoke.ts`

- [ ] **Step 1: Extend smoke.ts to exercise the new paths**

Add at the bottom of `scripts/smoke.ts`:

```ts
async function smokeWithVadAndWebhook() {
  console.log("\n=== VAD + webhook smoke ===");

  // Spin up a tiny receiver
  const received: any[] = [];
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, () => r()));
  const port = (server.address() as any).port;
  const cb = `http://host.docker.internal:${port}/hook`;

  // Set a tenant secret
  const { execSync } = await import("node:child_process");
  execSync(
    `docker compose -f infra/docker-compose.yml exec -T postgres psql -U audio -d audio -c ` +
    `"INSERT INTO tenant_secrets (tenant_id, webhook_secret) VALUES ('tenant_dev','dev-secret') ON CONFLICT DO NOTHING;"`
  );

  const sub = await fetch(`${API}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      input: { type: "url", url: SAMPLE_URL },
      analyses: ["format", "vad"],
      callback_url: cb
    })
  });
  const { job_id } = await sub.json();

  // Wait up to 120s for the webhook
  const start = Date.now();
  while (received.length === 0 && Date.now() - start < 120_000) {
    await new Promise(r => setTimeout(r, 1000));
  }
  if (received.length === 0) throw new Error("webhook not received");
  console.log("webhook headers:", received[0].headers["x-signature"], "body:", received[0].body.slice(0, 80));

  // Verify HMAC
  const { createHmac } = await import("node:crypto");
  const expected = "sha256=" + createHmac("sha256", "dev-secret").update(received[0].body).digest("hex");
  if (received[0].headers["x-signature"] !== expected) throw new Error("HMAC mismatch");

  server.close();
  console.log("VAD + webhook OK");
}

smokeWithVadAndWebhook().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the smoke**

```bash
cd audio-api
TOKEN=$(./scripts/seed-token.sh | grep ^TOKEN | cut -d= -f2)
export API_TOKEN="$TOKEN"
pnpm smoke
```
Expected: existing format slice passes, then VAD + webhook section passes with HMAC verified.

- [ ] **Step 3: Commit**

```bash
git add audio-api/scripts/smoke.ts
git commit -m "test(smoke): extend smoke to cover VAD + HMAC webhook delivery"
```

---

## Self-Review

**Spec coverage (Plan 2):**

| Spec section | Plan 2 task |
|---|---|
| VAD analysis | T2 (vad.py), T3 (orchestrator/aggregator wiring) |
| 3.3 Sync mode with timeout | T5 |
| 3.5 Webhook payload, HMAC, retries | T6 (secret table), T7 (sign+deliver), T8 (aggregator emits job.completed) |
| 4.1 Stage 6 delivery (sync wake via LISTEN/NOTIFY) | T5 |
| 4.3 Webhook retries with exponential backoff (1s/5s/30s/2m/10m) | T7 (BACKOFF_MS) |
| 6.3 Logged delivery attempts in `job_events` | T7 |
| 9.4 Smoke for webhook signature verification | T9 |

**Placeholder scan:** none.

**Type consistency:**
- `VadReady`, `VadPerChannel`, `VadSegment` defined in proto; matches Python output keys.
- `SUBJECTS.WORK_VAD` and `SUBJECTS.EVENT_VAD_READY` used identically in orchestrator (TS) and worker (Py).
- `BACKOFF_MS` length matches the spec's "5 retries" (initial attempt + 5 retries = 6 entries).

**Scope:** Plan 2 ends with a runnable two-analysis pipeline plus working sync mode plus working webhook delivery, all under smoke test.
