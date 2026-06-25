# Audio API Plan 5: Live Subtitles Skeleton + Stub Lifecycle

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the new `Stream` resource end-to-end with a stub inference pipeline. By the end of this plan you can `POST /v1/streams` with an HLS / DASH / MP4 source URL, the pod is forked, and you can watch dummy English cues arrive over WebSocket. The real ffmpeg pull is stubbed here; Plan 6 swaps the stub for real ffmpeg + Whisper + TTML archiver.

**Architecture:** Stream-pod model (per the design spec). Gateway issues a `Stream`, orchestrator publishes a provision request on NATS, a single `worker-stream-supervisor` per GPU host forks a `worker-stream-pod` subprocess per active stream. The pod owns source pull (stubbed in this plan), the inference pipeline (also stubbed), and the WebSocket fan-out. Gateway proxies WS connections through to the pod. No inbound media ports are exposed; the only port pool the supervisor manages is for WebSocket fan-out.

**Tech Stack:**
- Node 20, TypeScript 5, Fastify 5, `@fastify/websocket`, `ws`, `pg`, `nats.js` (existing stack)
- Python 3.12, `nats-py`, `psycopg[binary]`, `websockets`, `structlog`, `pytest` (matches existing workers)
- NATS JetStream control plane on the existing `AUDIO_EVENTS` stream
- Postgres 16, migration `0003_streams.sql`

**Reference:** [`../live-subtitles-design.md`](../live-subtitles-design.md).

---

## Out of scope for this plan (covered in Plan 6)

- Real ffmpeg pull from the source URL (this plan uses a stub `audio_in` interface; the source URL is accepted, persisted, and propagated to the pod environment but the pod does not yet open it).
- ffmpeg HLS/DASH/MP4 demuxer config, Silero VAD, faster-whisper inference.
- SSRF allow/deny enforcement on `source.url` (out-of-scope here; Plan 6 adds it before any real pull happens).
- Rolling WebVTT segments and gateway HTTP proxy for VTT.
- TTML archiver (`worker-tt-archiver`).
- Real audio-to-cue latency measurement.

Plan 5 ends with: lifecycle working, status transitions correct, dummy cues every 5 seconds flowing through WS, end-to-end integration test green.

---

## File Structure (created or modified in this plan)

```
audio-api/
  infra/migrations/
    0003_streams.sql                                  # NEW

  packages/proto/
    schemas/events/
      stream-provision-requested.json                 # NEW
      stream-ready.json                               # NEW
      stream-ingest-started.json                      # NEW
      stream-ingest-ended.json                        # NEW
      stream-cue-finalised.json                       # NEW
      stream-failed.json                              # NEW
    src/index.ts                                      # MODIFY (export schemas + types + SUBJECTS)
    src/index.test.ts                                 # MODIFY (add cases)

  packages/contracts/
    openapi.yaml                                      # MODIFY (add /v1/streams)
    error-codes.yaml                                  # MODIFY (add STREAM_* codes)

  packages/node-common/src/
    ids.ts                                            # MODIFY (add streamId())
    errors.ts                                         # MODIFY (map STREAM_* codes)

  services/api-gateway/src/
    routes/streams.ts                                 # NEW
    routes/streams-ws.ts                              # NEW
    server.ts                                         # MODIFY (register new routes)
    package.json                                      # MODIFY (add @fastify/websocket, ws)

  services/orchestrator/src/
    stream-machine.ts                                 # NEW
    index.ts                                          # MODIFY (start the stream machine)

  services/worker-stream-supervisor/                  # NEW SERVICE (Python)
    pyproject.toml
    Dockerfile
    app/__init__.py
    app/main.py
    app/pool.py
    app/forker.py
    tests/test_pool.py
    tests/test_forker.py

  services/worker-stream-pod/                         # NEW SERVICE (Python)
    pyproject.toml
    Dockerfile
    app/__init__.py
    app/main.py
    app/lifecycle.py
    app/stub_audio.py
    app/cue_emitter.py
    app/ws_server.py
    tests/test_cue_emitter.py
    tests/test_lifecycle.py

  infra/docker-compose.yml                            # MODIFY (add supervisor)
  tests/integration/stream-skeleton.test.ts           # NEW
  scripts/submit-stream.sh                            # NEW (helper for manual demos)
```

Working directory for every step is the audio-api monorepo root (e.g. `C:/dev/audio-api`).

---

## Task 1: Database migration for streams

**Files:**
- Create: `infra/migrations/0003_streams.sql`
- Test: `tests/integration/migrations.test.ts` (modify existing test file)

- [ ] **Step 1: Write the failing migration test**

Append to `tests/integration/migrations.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Client } from "pg";

describe("migration 0003 streams", () => {
  it("creates streams, stream_cues, stream_pods tables with expected columns", async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      const v = await c.query("SELECT version FROM schema_migrations WHERE version='0003'");
      expect(v.rowCount).toBe(1);

      const cols = await c.query(`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name IN ('streams','stream_cues','stream_pods')
        ORDER BY table_name, column_name
      `);
      const got = cols.rows.map(r => `${r.table_name}.${r.column_name}`);
      for (const expected of [
        "streams.id","streams.tenant_id","streams.status","streams.target_lang",
        "streams.source_kind","streams.source_url","streams.source_headers","streams.pod_id",
        "stream_cues.stream_id","stream_cues.cue_id","stream_cues.text",
        "stream_pods.pod_id","stream_pods.ws_host","stream_pods.ws_port","stream_pods.last_heartbeat"
      ]) {
        expect(got, `missing column ${expected}`).toContain(expected);
      }
    } finally {
      await c.end();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```
make up && make migrate
pnpm --filter @audio-api/integration-tests test -- migrations
```

Expected: FAIL with `migration 0003 streams ... expected 0 to be 1` (no migration yet).

- [ ] **Step 3: Write the migration**

Create `infra/migrations/0003_streams.sql`:

```sql
BEGIN;

CREATE TABLE streams (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  status                   TEXT NOT NULL,
  source_kind              TEXT NOT NULL,
  source_url               TEXT NOT NULL,
  source_headers           JSONB,                       -- Plan 5: plaintext (stubbed pod, no fetch); Plan 6 migrates to encrypted bytea before any real ffmpeg pull
  source_hint              TEXT,
  target_lang              TEXT NOT NULL DEFAULT 'en',
  options                  JSONB NOT NULL DEFAULT '{}',
  callback_url             TEXT,
  pod_id                   TEXT,
  ttml_object              TEXT,
  cue_count                INT NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at               TIMESTAMPTZ,
  ended_at                 TIMESTAMPTZ,
  archived_at              TIMESTAMPTZ,
  error                    JSONB,
  CONSTRAINT streams_source_kind_chk CHECK (source_kind IN ('hls','dash','mp4'))
);
CREATE INDEX idx_streams_tenant_created ON streams (tenant_id, created_at DESC);
CREATE INDEX idx_streams_active_status  ON streams (status)
  WHERE status IN ('provisioning','awaiting_ingest','active','ending');

CREATE TABLE stream_cues (
  stream_id   TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  cue_id      INT  NOT NULL,
  start_ms    INT  NOT NULL,
  end_ms      INT  NOT NULL,
  text        TEXT NOT NULL,
  source_text TEXT,
  confidence  REAL,
  PRIMARY KEY (stream_id, cue_id)
);

CREATE TABLE stream_pods (
  pod_id          TEXT PRIMARY KEY,
  supervisor_host TEXT NOT NULL,
  ws_host         TEXT NOT NULL,
  ws_port         INT  NOT NULL,
  stream_id       TEXT REFERENCES streams(id) ON DELETE SET NULL,
  status          TEXT NOT NULL,
  last_heartbeat  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stream_pods_heartbeat ON stream_pods (status, last_heartbeat);

INSERT INTO schema_migrations(version) VALUES ('0003');

COMMIT;
```

- [ ] **Step 4: Apply and re-run the test**

```
make migrate
pnpm --filter @audio-api/integration-tests test -- migrations
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git add infra/migrations/0003_streams.sql tests/integration/migrations.test.ts
git commit -m "feat(db): add streams (source URL + headers), stream_cues, stream_pods (ws host/port) tables (migration 0003)"
```

---

## Task 2: Shared message schemas and types

**Files:**
- Create: `packages/proto/schemas/events/stream-provision-requested.json`
- Create: `packages/proto/schemas/events/stream-ready.json`
- Create: `packages/proto/schemas/events/stream-ingest-started.json`
- Create: `packages/proto/schemas/events/stream-ingest-ended.json`
- Create: `packages/proto/schemas/events/stream-cue-finalised.json`
- Create: `packages/proto/schemas/events/stream-failed.json`
- Modify: `packages/proto/src/index.ts`
- Modify: `packages/proto/src/index.test.ts`

- [ ] **Step 1: Write a failing schema-loader test**

Append to `packages/proto/src/index.test.ts`:

```typescript
import {
  validateStreamProvisionRequested,
  validateStreamReady,
  validateStreamIngestStarted,
  validateStreamIngestEnded,
  validateStreamCueFinalised,
  validateStreamFailed,
  SUBJECTS
} from "./index.js";

it("loads stream event schemas and SUBJECTS", () => {
  expect(validateStreamProvisionRequested).toBeTypeOf("function");
  expect(validateStreamReady).toBeTypeOf("function");
  expect(validateStreamIngestStarted).toBeTypeOf("function");
  expect(validateStreamIngestEnded).toBeTypeOf("function");
  expect(validateStreamCueFinalised).toBeTypeOf("function");
  expect(validateStreamFailed).toBeTypeOf("function");
  expect(SUBJECTS.STREAM_PROVISION_REQUESTED).toBe("audio.stream.provision.requested");
  expect(SUBJECTS.STREAM_READY).toBe("audio.stream.ready");
  expect(SUBJECTS.STREAM_INGEST_STARTED).toBe("audio.stream.ingest.started");
  expect(SUBJECTS.STREAM_INGEST_ENDED).toBe("audio.stream.ingest.ended");
  expect(SUBJECTS.STREAM_CUE_FINALISED).toBe("audio.stream.cue.finalised");
  expect(SUBJECTS.STREAM_FAILED).toBe("audio.stream.failed");
});

it("validates a sample stream-provision-requested payload", () => {
  const ok = validateStreamProvisionRequested({
    stream_id: "s_01HX",
    tenant_id: "t1",
    source: { kind: "hls", url: "https://cdn.example.com/m.m3u8" },
    options: { model_size: "medium" },
    source_hint: "fr",
    target_lang: "en"
  });
  expect(ok).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

```
pnpm --filter @audio-api/proto test
```

Expected: FAIL (`validateStreamProvisionRequested` undefined).

- [ ] **Step 3: Create the JSON schemas**

`packages/proto/schemas/events/stream-provision-requested.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "StreamProvisionRequested",
  "type": "object",
  "required": ["stream_id","tenant_id","source","target_lang"],
  "additionalProperties": false,
  "properties": {
    "stream_id": { "type": "string" },
    "tenant_id": { "type": "string" },
    "source": {
      "type": "object",
      "required": ["kind","url"],
      "additionalProperties": false,
      "properties": {
        "kind":    { "type": "string", "enum": ["hls","dash","mp4"] },
        "url":     { "type": "string", "format": "uri" },
        "headers": {
          "type": "object",
          "additionalProperties": { "type": "string" },
          "maxProperties": 10
        }
      }
    },
    "source_hint": { "type": "string" },
    "target_lang": { "type": "string", "const": "en" },
    "options":     { "type": "object" }
  }
}
```

Note: the supervisor receives source headers inline on the provision message rather than re-reading the encrypted blob from Postgres. The provision message is held only in NATS JetStream (encrypted at rest) and the pod env (memory only, never written to disk).

`packages/proto/schemas/events/stream-ready.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "StreamReady",
  "type": "object",
  "required": ["stream_id","pod_id","ws_host","ws_port"],
  "additionalProperties": false,
  "properties": {
    "stream_id": { "type": "string" },
    "pod_id":    { "type": "string" },
    "ws_host":   { "type": "string" },
    "ws_port":   { "type": "integer", "minimum": 1024, "maximum": 65535 }
  }
}
```

`packages/proto/schemas/events/stream-ingest-started.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "StreamIngestStarted",
  "type": "object",
  "required": ["stream_id","pod_id","started_at"],
  "additionalProperties": false,
  "properties": {
    "stream_id":  { "type": "string" },
    "pod_id":     { "type": "string" },
    "started_at": { "type": "string", "format": "date-time" }
  }
}
```

`packages/proto/schemas/events/stream-ingest-ended.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "StreamIngestEnded",
  "type": "object",
  "required": ["stream_id","pod_id","reason","ended_at","cue_count"],
  "additionalProperties": false,
  "properties": {
    "stream_id": { "type": "string" },
    "pod_id":    { "type": "string" },
    "reason":    { "type": "string", "enum": ["client_delete","source_eof","source_failed","idle_timeout","max_duration","pod_error"] },
    "ended_at":  { "type": "string", "format": "date-time" },
    "cue_count": { "type": "integer", "minimum": 0 }
  }
}
```

`packages/proto/schemas/events/stream-cue-finalised.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "StreamCueFinalised",
  "type": "object",
  "required": ["stream_id","cue_id","start_ms","end_ms","text"],
  "additionalProperties": false,
  "properties": {
    "stream_id":  { "type": "string" },
    "cue_id":     { "type": "integer", "minimum": 0 },
    "start_ms":   { "type": "integer", "minimum": 0 },
    "end_ms":     { "type": "integer", "minimum": 0 },
    "text":       { "type": "string" },
    "source_text": { "type": "string" },
    "confidence": { "type": "number" }
  }
}
```

`packages/proto/schemas/events/stream-failed.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "StreamFailed",
  "type": "object",
  "required": ["stream_id","code","message"],
  "additionalProperties": false,
  "properties": {
    "stream_id": { "type": "string" },
    "pod_id":    { "type": "string" },
    "code":      { "type": "string" },
    "message":   { "type": "string" }
  }
}
```

- [ ] **Step 4: Wire the schemas into `packages/proto/src/index.ts`**

Append to `packages/proto/src/index.ts`:

```typescript
export const validateStreamProvisionRequested = load("events/stream-provision-requested.json");
export const validateStreamReady              = load("events/stream-ready.json");
export const validateStreamIngestStarted      = load("events/stream-ingest-started.json");
export const validateStreamIngestEnded        = load("events/stream-ingest-ended.json");
export const validateStreamCueFinalised       = load("events/stream-cue-finalised.json");
export const validateStreamFailed             = load("events/stream-failed.json");

export type StreamSourceKind = "hls" | "dash" | "mp4";
export interface StreamSource {
  kind: StreamSourceKind;
  url: string;
  headers?: Record<string, string>;
}
export interface StreamProvisionRequested {
  stream_id: string; tenant_id: string;
  source: StreamSource;
  source_hint?: string; target_lang: "en"; options?: Record<string, unknown>;
}
export interface StreamReady {
  stream_id: string; pod_id: string; ws_host: string; ws_port: number;
}
export interface StreamIngestStarted { stream_id: string; pod_id: string; started_at: string; }
export interface StreamIngestEnded {
  stream_id: string; pod_id: string;
  reason: "client_delete"|"source_eof"|"source_failed"|"idle_timeout"|"max_duration"|"pod_error";
  ended_at: string; cue_count: number;
}
export interface StreamCueFinalised {
  stream_id: string; cue_id: number;
  start_ms: number; end_ms: number;
  text: string; source_text?: string; confidence?: number;
}
export interface StreamFailed {
  stream_id: string; pod_id?: string; code: string; message: string;
}
```

Extend the `SUBJECTS` const:

```typescript
export const SUBJECTS = {
  // ... existing entries unchanged ...
  STREAM_PROVISION_REQUESTED: "audio.stream.provision.requested",
  STREAM_READY:               "audio.stream.ready",
  STREAM_INGEST_STARTED:      "audio.stream.ingest.started",
  STREAM_INGEST_ENDED:        "audio.stream.ingest.ended",
  STREAM_CUE_FINALISED:       "audio.stream.cue.finalised",
  STREAM_FAILED:              "audio.stream.failed"
} as const;
```

- [ ] **Step 5: Run tests to verify they pass**

```
pnpm --filter @audio-api/proto test
```

Expected: PASS.

- [ ] **Step 6: Add Python-side constants**

Edit `packages/py-common/src/audio_api_common/subjects.py` (create if absent):

```python
STREAM_PROVISION_REQUESTED = "audio.stream.provision.requested"
STREAM_READY               = "audio.stream.ready"
STREAM_INGEST_STARTED      = "audio.stream.ingest.started"
STREAM_INGEST_ENDED        = "audio.stream.ingest.ended"
STREAM_CUE_FINALISED       = "audio.stream.cue.finalised"
STREAM_FAILED              = "audio.stream.failed"
```

- [ ] **Step 7: Add error codes**

Append to `packages/contracts/error-codes.yaml`:

```yaml
STREAM_PROVISION_FAILED:
  http_status: 503
  retryable: true
  message: "No GPU capacity available for new streams. Try again shortly."
SOURCE_UNREACHABLE:
  http_status: 502
  retryable: false
  message: "Could not open the source URL (DNS, TLS, or HTTP error)."
SOURCE_UNSUPPORTED:
  http_status: 415
  retryable: false
  message: "Source URL opened but contains no usable audio track."
STREAM_INGEST_TIMEOUT:
  http_status: 408
  retryable: false
  message: "Source opened but produced no decodable audio within the ingest TTL."
STREAM_INFERENCE_FAILED:
  http_status: 500
  retryable: false
  message: "Inference pipeline failed repeatedly."
STREAM_POD_CRASHED:
  http_status: 500
  retryable: false
  message: "Stream pod crashed; create a new stream."
STREAM_ARCHIVE_FAILED:
  http_status: 500
  retryable: false
  message: "TTML archive failed; live VTT still available."
STREAM_NOT_FOUND:
  http_status: 404
  retryable: false
  message: "Stream not found."
STREAM_CAP_EXCEEDED:
  http_status: 429
  retryable: true
  message: "Concurrent stream cap reached for this tenant."
```

Update `packages/node-common/src/errors.ts` to map these codes (follow the existing map pattern; mirror in `services/api-gateway/src/auth.ts` if codes are referenced there).

- [ ] **Step 8: Commit**

```
git add packages/proto packages/contracts packages/node-common packages/py-common
git commit -m "feat(proto): add stream event schemas, subjects, error codes"
```

---

## Task 3: Stream IDs helper

**Files:**
- Modify: `packages/node-common/src/ids.ts`
- Test: `packages/node-common/src/ids.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create or append to `packages/node-common/src/ids.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { streamId, podId } from "./ids.js";

describe("streamId", () => {
  it("produces an s_-prefixed ULID-shape value", () => {
    const id = streamId();
    expect(id).toMatch(/^s_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe("podId", () => {
  it("produces a p_-prefixed ULID-shape value", () => {
    const id = podId();
    expect(id).toMatch(/^p_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```
pnpm --filter @audio-api/node-common test
```

Expected: FAIL (`streamId` / `podId` undefined).

- [ ] **Step 3: Implement**

Add to `packages/node-common/src/ids.ts` (the file already has `jobId` / `traceId` / `attemptId` using `ulid`):

```typescript
import { ulid } from "ulid";
export function streamId() { return `s_${ulid()}`; }
export function podId() { return `p_${ulid()}`; }
```

Make sure both are re-exported from `packages/node-common/src/index.ts`.

- [ ] **Step 4: Run to verify pass**

```
pnpm --filter @audio-api/node-common test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git add packages/node-common
git commit -m "feat(ids): add streamId() and podId() helpers"
```

---

## Task 4: Gateway REST endpoints for `/v1/streams`

**Files:**
- Create: `services/api-gateway/src/routes/streams.ts`
- Modify: `services/api-gateway/src/server.ts`
- Modify: `services/api-gateway/package.json` (add ws deps in Task 6)
- Test: `services/api-gateway/src/routes/streams.test.ts`

- [ ] **Step 1: Write the failing test**

Create `services/api-gateway/src/routes/streams.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { getPool } from "@audio-api/node-common";

let app: Awaited<ReturnType<typeof buildServer>>;
const AUTH = { authorization: "Bearer dev-token" };

beforeAll(async () => { app = await buildServer(); });
afterAll(async () => { await app.close(); });

const VALID_SOURCE = { kind: "hls", url: "https://cdn.example.com/test.m3u8" };

describe("POST /v1/streams", () => {
  it("creates a stream, returns provisioning status + echoed source", async () => {
    const r = await app.inject({
      method: "POST", url: "/v1/streams", headers: AUTH,
      payload: { source: VALID_SOURCE, source_hint: "fr", output: { target_lang: "en" } }
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.stream_id).toMatch(/^s_/);
    expect(body.status).toBe("provisioning");
    expect(body.source.kind).toBe("hls");
    expect(body.source.url).toBe(VALID_SOURCE.url);
    expect(body.source.headers).toBeUndefined(); // never echoed
    expect(body.outputs.websocket_url).toContain(body.stream_id);

    const row = await getPool().query(
      "SELECT status, source_kind, source_url FROM streams WHERE id=$1", [body.stream_id]
    );
    expect(row.rows[0].status).toBe("provisioning");
    expect(row.rows[0].source_kind).toBe("hls");
    expect(row.rows[0].source_url).toBe(VALID_SOURCE.url);
  });

  it("rejects unsupported target_lang", async () => {
    const r = await app.inject({
      method: "POST", url: "/v1/streams", headers: AUTH,
      payload: { source: VALID_SOURCE, output: { target_lang: "de" } }
    });
    expect(r.statusCode).toBe(400);
  });

  it("rejects missing source", async () => {
    const r = await app.inject({
      method: "POST", url: "/v1/streams", headers: AUTH,
      payload: { output: { target_lang: "en" } }
    });
    expect(r.statusCode).toBe(400);
  });

  it("rejects unsupported source.kind", async () => {
    const r = await app.inject({
      method: "POST", url: "/v1/streams", headers: AUTH,
      payload: { source: { kind: "rtmp", url: "rtmp://x/y" }, output: { target_lang: "en" } }
    });
    expect(r.statusCode).toBe(400);
  });

  it("rejects plain http source.url by default", async () => {
    const r = await app.inject({
      method: "POST", url: "/v1/streams", headers: AUTH,
      payload: { source: { kind: "mp4", url: "http://example.com/f.mp4" }, output: { target_lang: "en" } }
    });
    expect(r.statusCode).toBe(400);
  });
});

describe("GET /v1/streams/:id", () => {
  it("returns 404 for unknown id", async () => {
    const r = await app.inject({
      method: "GET", url: "/v1/streams/s_doesnotexist", headers: AUTH
    });
    expect(r.statusCode).toBe(404);
  });
});

describe("DELETE /v1/streams/:id", () => {
  it("flips status to ending", async () => {
    const create = await app.inject({
      method: "POST", url: "/v1/streams", headers: AUTH,
      payload: { source: VALID_SOURCE, source_hint: "fr", output: { target_lang: "en" } }
    });
    const id = create.json().stream_id;
    const del = await app.inject({ method: "DELETE", url: `/v1/streams/${id}`, headers: AUTH });
    expect(del.statusCode).toBe(202);
    const row = await getPool().query("SELECT status FROM streams WHERE id=$1", [id]);
    expect(row.rows[0].status).toBe("ending");
  });
});
```

- [ ] **Step 2: Run to verify failure**

```
pnpm --filter @audio-api/api-gateway test
```

Expected: FAIL (404 on POST /v1/streams).

- [ ] **Step 3: Implement the route**

Create `services/api-gateway/src/routes/streams.ts`:

```typescript
import { FastifyInstance } from "fastify";
import {
  getPool, withTx, connectNats, publish, streamId, traceId, ApiError
} from "@audio-api/node-common";
import {
  SUBJECTS, StreamProvisionRequested, StreamSourceKind
} from "@audio-api/proto";

interface CreateBody {
  source?: {
    kind?: string;
    url?: string;
    headers?: Record<string, string>;
  };
  source_hint?: string;
  output?: { target_lang?: string };
  options?: Record<string, unknown>;
  callback_url?: string;
}

const KINDS: ReadonlySet<StreamSourceKind> = new Set(["hls","dash","mp4"]);
const ALLOW_HTTP = process.env.STREAM_ALLOW_HTTP === "1";

let natsRef: Awaited<ReturnType<typeof connectNats>> | null = null;
async function nats() { if (!natsRef) natsRef = await connectNats(); return natsRef; }

function publicBase() { return process.env.PUBLIC_BASE_URL ?? "http://localhost:8080"; }
function wsBase() { return process.env.PUBLIC_WS_URL ?? "ws://localhost:8080"; }

function validateSource(body: CreateBody): { kind: StreamSourceKind; url: string; headers?: Record<string,string> } {
  const s = body.source;
  if (!s || !s.kind || !s.url) throw new ApiError("INPUT_UNREACHABLE", "source.kind and source.url are required");
  if (!KINDS.has(s.kind as StreamSourceKind)) {
    throw new ApiError("INPUT_UNREACHABLE", `source.kind must be one of: ${[...KINDS].join(", ")}`);
  }
  let u: URL;
  try { u = new URL(s.url); }
  catch { throw new ApiError("INPUT_UNREACHABLE", "source.url must be a valid URL"); }
  if (u.protocol === "http:" && !ALLOW_HTTP) {
    throw new ApiError("INPUT_UNREACHABLE", "source.url must use https://");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ApiError("INPUT_UNREACHABLE", "source.url must use http(s)");
  }
  if (s.headers && Object.keys(s.headers).length > 10) {
    throw new ApiError("INPUT_UNREACHABLE", "source.headers may not exceed 10 entries");
  }
  return { kind: s.kind as StreamSourceKind, url: s.url, headers: s.headers };
}

export async function streamsRoutes(app: FastifyInstance) {
  app.post<{ Body: CreateBody }>("/v1/streams", { onRequest: app.requireAuth }, async (req, reply) => {
    const body = req.body ?? {};
    const target = body.output?.target_lang ?? "en";
    if (target !== "en") {
      throw new ApiError("INPUT_UNREACHABLE", "output.target_lang must be 'en' in v1");
    }
    const source = validateSource(body);

    const id = streamId();
    const tenant = req.tenant_id!;
    const tid = traceId();

    // NOTE: source.headers stored as plaintext JSONB in Plan 5 because the pod is stubbed
    // and never fetches the URL. Plan 6 migrates source_headers to encrypted BYTEA before
    // any real ffmpeg pull happens.
    await withTx(async client => {
      await client.query(
        `INSERT INTO streams
           (id, tenant_id, status, source_kind, source_url, source_headers, source_hint,
            target_lang, options, callback_url)
         VALUES ($1,$2,'provisioning',$3,$4,$5,$6,'en',$7,$8)`,
        [id, tenant, source.kind, source.url, source.headers ?? null,
         body.source_hint ?? null, body.options ?? {}, body.callback_url ?? null]
      );
    });

    const { js } = await nats();
    const env: StreamProvisionRequested = {
      stream_id: id, tenant_id: tenant, target_lang: "en",
      source: { kind: source.kind, url: source.url, headers: source.headers },
      source_hint: body.source_hint, options: body.options ?? {}
    };
    await publish(js, SUBJECTS.STREAM_PROVISION_REQUESTED, env);

    return reply.code(201).send({
      stream_id: id,
      status: "provisioning",
      source: { kind: source.kind, url: source.url },   // headers deliberately omitted
      outputs: {
        websocket_url: `${wsBase()}/v1/streams/${id}/captions`,
        vtt_url: `${publicBase()}/v1/streams/${id}/captions.vtt`,
        ttml_url: `${publicBase()}/v1/streams/${id}/captions.ttml`
      }
    });
  });

  app.get<{ Params: { id: string } }>("/v1/streams/:id", { onRequest: app.requireAuth }, async (req, reply) => {
    const r = await getPool().query(
      `SELECT id, status, source_kind, source_url, cue_count, created_at, started_at, ended_at, archived_at
       FROM streams WHERE id=$1 AND tenant_id=$2`,
      [req.params.id, req.tenant_id]
    );
    if (r.rowCount === 0) return reply.code(404).send({ code: "STREAM_NOT_FOUND", message: "Stream not found" });
    return r.rows[0];
  });

  app.delete<{ Params: { id: string } }>("/v1/streams/:id", { onRequest: app.requireAuth }, async (req, reply) => {
    const r = await getPool().query(
      `UPDATE streams SET status='ending'
       WHERE id=$1 AND tenant_id=$2 AND status IN ('provisioning','awaiting_ingest','active')
       RETURNING id`,
      [req.params.id, req.tenant_id]
    );
    if (r.rowCount === 0) return reply.code(404).send({ code: "STREAM_NOT_FOUND", message: "Stream not found or not cancellable" });
    return reply.code(202).send({ stream_id: req.params.id, status: "ending" });
  });
}
```

- [ ] **Step 4: Register the route**

Edit `services/api-gateway/src/server.ts`:

```typescript
import { streamsRoutes } from "./routes/streams.js";
// ... after jobsRoutes registration:
await app.register(streamsRoutes);
```

- [ ] **Step 5: Run tests to verify pass**

```
pnpm --filter @audio-api/api-gateway test
```

Expected: PASS.

- [ ] **Step 6: Update the OpenAPI contract**

Edit `packages/contracts/openapi.yaml`, add (paths section):

```yaml
/v1/streams:
  post:
    summary: Create a live subtitle stream
    security: [{ bearerAuth: [] }]
    requestBody:
      required: true
      content:
        application/json:
          schema: { $ref: "#/components/schemas/StreamCreate" }
    responses:
      "201":
        description: Stream provisioning
        content:
          application/json:
            schema: { $ref: "#/components/schemas/StreamCreateResponse" }
/v1/streams/{id}:
  get:
    summary: Get stream status
    security: [{ bearerAuth: [] }]
    parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
    responses:
      "200": { description: ok }
      "404": { description: not found }
  delete:
    summary: End a stream
    security: [{ bearerAuth: [] }]
    parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
    responses:
      "202": { description: ending }
      "404": { description: not found }
```

Add to `components.schemas`:

```yaml
StreamSource:
  type: object
  required: [kind, url]
  properties:
    kind: { type: string, enum: [hls, dash, mp4] }
    url:  { type: string, format: uri }
    headers:
      type: object
      additionalProperties: { type: string }
      maxProperties: 10
StreamCreate:
  type: object
  required: [source]
  properties:
    source: { $ref: "#/components/schemas/StreamSource" }
    source_hint: { type: string }
    output:
      type: object
      properties:
        target_lang: { type: string, enum: [en] }
    options: { type: object }
    callback_url: { type: string, format: uri }
StreamCreateResponse:
  type: object
  required: [stream_id, status, source, outputs]
  properties:
    stream_id: { type: string }
    status:    { type: string }
    source:
      type: object
      required: [kind, url]
      properties:
        kind: { type: string, enum: [hls, dash, mp4] }
        url:  { type: string, format: uri }
    outputs:
      type: object
      required: [websocket_url, vtt_url, ttml_url]
      properties:
        websocket_url: { type: string }
        vtt_url:       { type: string }
        ttml_url:      { type: string }
```

- [ ] **Step 7: Commit**

```
git add services/api-gateway packages/contracts
git commit -m "feat(gateway): add POST/GET/DELETE /v1/streams accepting source URL (hls/dash/mp4)"
```

---

## Task 5: Orchestrator stream state machine

**Files:**
- Create: `services/orchestrator/src/stream-machine.ts`
- Modify: `services/orchestrator/src/index.ts`
- Test: `services/orchestrator/src/stream-machine.test.ts`

- [ ] **Step 1: Write the failing test**

Create `services/orchestrator/src/stream-machine.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { applyStreamEvent } from "./stream-machine.js";

describe("applyStreamEvent", () => {
  it("provisioning -> awaiting_ingest on stream.ready", () => {
    expect(applyStreamEvent("provisioning", "ready")).toEqual({
      next: "awaiting_ingest", terminal: false
    });
  });
  it("awaiting_ingest -> active on stream.ingest.started", () => {
    expect(applyStreamEvent("awaiting_ingest", "ingest_started")).toEqual({
      next: "active", terminal: false
    });
  });
  it("active -> ended on stream.ingest.ended", () => {
    expect(applyStreamEvent("active", "ingest_ended")).toEqual({
      next: "ended", terminal: false
    });
  });
  it("ended -> archived on archived", () => {
    expect(applyStreamEvent("ended", "archived")).toEqual({
      next: "archived", terminal: true
    });
  });
  it("any -> failed on failed", () => {
    expect(applyStreamEvent("active", "failed")).toEqual({
      next: "failed", terminal: true
    });
  });
  it("rejects invalid transitions", () => {
    expect(() => applyStreamEvent("archived", "ready")).toThrow(/invalid transition/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```
pnpm --filter @audio-api/orchestrator test
```

Expected: FAIL.

- [ ] **Step 3: Implement the machine**

Create `services/orchestrator/src/stream-machine.ts`:

```typescript
export type StreamStatus =
  "provisioning" | "awaiting_ingest" | "active" | "ending" | "ended" | "archived" | "failed";

export type StreamEvent =
  "ready" | "ingest_started" | "ingest_ended" | "archived" | "failed" | "delete_requested";

const TABLE: Record<StreamStatus, Partial<Record<StreamEvent, StreamStatus>>> = {
  provisioning:    { ready: "awaiting_ingest", failed: "failed", delete_requested: "ending" },
  awaiting_ingest: { ingest_started: "active", failed: "failed", delete_requested: "ending" },
  active:          { ingest_ended: "ended", failed: "failed", delete_requested: "ending" },
  ending:          { ingest_ended: "ended", failed: "failed" },
  ended:           { archived: "archived", failed: "failed" },
  archived:        {},
  failed:          {}
};

const TERMINAL = new Set<StreamStatus>(["archived", "failed"]);

export function applyStreamEvent(current: StreamStatus, ev: StreamEvent) {
  const next = TABLE[current][ev];
  if (!next) throw new Error(`invalid transition: ${current} --${ev}-->`);
  return { next, terminal: TERMINAL.has(next) };
}
```

- [ ] **Step 4: Run to verify pass**

```
pnpm --filter @audio-api/orchestrator test
```

Expected: PASS.

- [ ] **Step 5: Wire the machine into the orchestrator runtime**

Edit `services/orchestrator/src/index.ts` to subscribe to stream events on NATS, look up the current `streams.status`, apply the transition, and persist. Add (alongside existing job subscriptions):

```typescript
import { applyStreamEvent, StreamEvent, StreamStatus } from "./stream-machine.js";
import { SUBJECTS } from "@audio-api/proto";
import { getPool } from "@audio-api/node-common";

const STREAM_SUBJECT_TO_EVENT: Record<string, StreamEvent> = {
  [SUBJECTS.STREAM_READY]:           "ready",
  [SUBJECTS.STREAM_INGEST_STARTED]:  "ingest_started",
  [SUBJECTS.STREAM_INGEST_ENDED]:    "ingest_ended",
  [SUBJECTS.STREAM_FAILED]:          "failed"
};

async function consumeStreamEvent(subject: string, payload: any) {
  const ev = STREAM_SUBJECT_TO_EVENT[subject]; if (!ev) return;
  const id = payload.stream_id;
  const row = await getPool().query("SELECT status FROM streams WHERE id=$1", [id]);
  if (row.rowCount === 0) return;
  const current = row.rows[0].status as StreamStatus;
  let next: StreamStatus;
  try { next = applyStreamEvent(current, ev).next; }
  catch { return; }
  await getPool().query(
    `UPDATE streams
     SET status=$2,
         started_at = CASE WHEN $2='active' AND started_at IS NULL THEN now() ELSE started_at END,
         ended_at   = CASE WHEN $2='ended'  AND ended_at   IS NULL THEN now() ELSE ended_at END
     WHERE id=$1`,
    [id, next]
  );
}
```

Bind it inside the orchestrator startup loop next to the existing job-event subscription (follow the existing pattern in `index.ts`).

- [ ] **Step 6: Commit**

```
git add services/orchestrator
git commit -m "feat(orchestrator): stream state machine + DB persistence on stream events"
```

---

## Task 6: Supervisor scaffold (Python)

**Files:**
- Create: `services/worker-stream-supervisor/pyproject.toml`
- Create: `services/worker-stream-supervisor/Dockerfile`
- Create: `services/worker-stream-supervisor/app/__init__.py`
- Create: `services/worker-stream-supervisor/app/main.py`
- Create: `services/worker-stream-supervisor/app/pool.py`
- Create: `services/worker-stream-supervisor/app/forker.py`
- Create: `services/worker-stream-supervisor/tests/test_pool.py`
- Create: `services/worker-stream-supervisor/tests/test_forker.py`
- Modify: `infra/docker-compose.yml`

- [ ] **Step 1: Write the failing pool test**

Create `services/worker-stream-supervisor/tests/test_pool.py`:

```python
from app.pool import PortPool, PoolFull

def test_port_pool_allocates_unique_ports():
    p = PortPool(start=9000, end=9002)
    a, b, c = p.allocate("s1"), p.allocate("s2"), p.allocate("s3")
    assert {a, b, c} == {9000, 9001, 9002}

def test_port_pool_raises_when_full():
    p = PortPool(start=9000, end=9001)
    p.allocate("s1"); p.allocate("s2")
    try:
        p.allocate("s3"); assert False, "expected PoolFull"
    except PoolFull:
        pass

def test_port_pool_releases_on_free():
    p = PortPool(start=9000, end=9000)
    p.allocate("s1"); p.free("s1")
    assert p.allocate("s2") == 9000
```

- [ ] **Step 2: Write the failing forker test**

Create `services/worker-stream-supervisor/tests/test_forker.py`:

```python
import os, sys, time, subprocess
from app.forker import Forker

def test_forker_spawns_python_subprocess(tmp_path):
    marker = tmp_path / "ran.txt"
    f = Forker(cmd=[sys.executable, "-c", f"open({marker!r}, 'w').write('ok')"])
    pid = f.spawn(stream_id="s1", env={"STREAM_ID": "s1"})
    # wait briefly for the subprocess to write
    for _ in range(50):
        if marker.exists(): break
        time.sleep(0.05)
    assert marker.read_text() == "ok"
    f.terminate("s1")
```

- [ ] **Step 3: Run to verify failure**

```
cd services/worker-stream-supervisor && pytest -q
```

Expected: FAIL (modules don't exist).

- [ ] **Step 4: Implement pool**

Create `services/worker-stream-supervisor/app/pool.py`:

```python
from dataclasses import dataclass, field
from typing import Dict

class PoolFull(Exception): pass

@dataclass
class PortPool:
    start: int
    end: int
    _in_use: Dict[str, int] = field(default_factory=dict)
    _free: list = field(default_factory=list)

    def __post_init__(self):
        self._free = list(range(self.start, self.end + 1))

    def allocate(self, stream_id: str) -> int:
        if not self._free:
            raise PoolFull(f"port pool exhausted ({self.start}-{self.end})")
        port = self._free.pop(0)
        self._in_use[stream_id] = port
        return port

    def free(self, stream_id: str) -> None:
        port = self._in_use.pop(stream_id, None)
        if port is not None and port not in self._free:
            self._free.append(port); self._free.sort()
```

- [ ] **Step 5: Implement forker**

Create `services/worker-stream-supervisor/app/forker.py`:

```python
import os, subprocess
from dataclasses import dataclass, field
from typing import Dict, List

@dataclass
class Forker:
    cmd: List[str]
    _procs: Dict[str, subprocess.Popen] = field(default_factory=dict)

    def spawn(self, stream_id: str, env: Dict[str, str]) -> int:
        merged = {**os.environ, **env}
        p = subprocess.Popen(self.cmd, env=merged)
        self._procs[stream_id] = p
        return p.pid

    def terminate(self, stream_id: str) -> None:
        p = self._procs.pop(stream_id, None)
        if p and p.poll() is None:
            p.terminate()
            try: p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
```

- [ ] **Step 6: Run tests to verify pass**

```
cd services/worker-stream-supervisor && pytest -q
```

Expected: PASS.

- [ ] **Step 7: Implement the supervisor main loop**

Create `services/worker-stream-supervisor/app/main.py`:

```python
import asyncio, json, os, socket, sys
import nats, psycopg, structlog
from audio_api_common import subjects
from .pool import PortPool, PoolFull
from .forker import Forker

log = structlog.get_logger("worker-stream-supervisor")

NATS_URL    = os.environ.get("NATS_URL", "nats://nats:4222")
DATABASE_URL= os.environ["DATABASE_URL"]
WS_HOST     = os.environ.get("STREAM_WS_HOST", socket.gethostname())
WS_START    = int(os.environ.get("STREAM_WS_PORT_START", "10000"))
WS_END      = int(os.environ.get("STREAM_WS_PORT_END",   "10009"))
MAX_PODS    = int(os.environ.get("STREAM_MAX_PODS", str(WS_END - WS_START + 1)))
POD_CMD     = os.environ.get("STREAM_POD_CMD", sys.executable + " -m app.main").split()

pool = PortPool(start=WS_START, end=WS_END)
forker = Forker(cmd=POD_CMD)

async def handle_provision(nc, js, msg):
    payload = json.loads(msg.data)
    sid = payload["stream_id"]; tenant = payload["tenant_id"]
    source = payload["source"]                 # {kind, url, headers?}
    if len(forker._procs) >= MAX_PODS:
        await js.publish(subjects.STREAM_FAILED, json.dumps({
            "stream_id": sid, "code": "STREAM_PROVISION_FAILED",
            "message": "max pod capacity reached"
        }).encode())
        await msg.ack(); return
    try: ws_port = pool.allocate(sid)
    except PoolFull:
        await js.publish(subjects.STREAM_FAILED, json.dumps({
            "stream_id": sid, "code": "STREAM_PROVISION_FAILED",
            "message": "no free WS ports"
        }).encode())
        await msg.ack(); return

    pod_id = f"p_{sid[2:]}"
    env = {
        "STREAM_ID": sid, "POD_ID": pod_id,
        "WS_HOST": WS_HOST, "WS_PORT": str(ws_port),
        "SOURCE_KIND": source["kind"],
        "SOURCE_URL":  source["url"],
        "SOURCE_HEADERS_JSON": json.dumps(source.get("headers") or {}),
        "OPTIONS_JSON": json.dumps(payload.get("options", {})),
        "TARGET_LANG": payload["target_lang"]
    }
    forker.spawn(stream_id=sid, env=env)

    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO stream_pods (pod_id, supervisor_host, ws_host, ws_port, stream_id, status) "
                "VALUES (%s, %s, %s, %s, %s, 'starting')",
                (pod_id, socket.gethostname(), WS_HOST, ws_port, sid)
            )
            await cur.execute(
                "UPDATE streams SET pod_id=%s WHERE id=%s",
                (pod_id, sid)
            )
        await conn.commit()

    await js.publish(subjects.STREAM_READY, json.dumps({
        "stream_id": sid, "pod_id": pod_id,
        "ws_host": WS_HOST, "ws_port": ws_port
    }).encode())
    await msg.ack()
    log.info("pod_spawned", stream_id=sid, pod_id=pod_id, ws_port=ws_port)

async def main():
    nc = await nats.connect(NATS_URL)
    js = nc.jetstream()
    sub = await js.subscribe(subjects.STREAM_PROVISION_REQUESTED, durable="stream-supervisor")
    log.info("supervisor_started", ports=f"{PORT_START}-{PORT_END}", max_pods=MAX_PODS)
    async for msg in sub.messages:
        try: await handle_provision(nc, js, msg)
        except Exception as e:
            log.exception("provision_failed", err=str(e))
            await msg.nak()

if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 8: Add to docker-compose**

Edit `infra/docker-compose.yml`, add:

```yaml
worker-stream-supervisor:
  build: { context: ../services/worker-stream-supervisor }
  environment:
    DATABASE_URL: postgres://audio:audio@postgres:5432/audio
    NATS_URL: nats://nats:4222
    STREAM_WS_HOST: worker-stream-supervisor
    STREAM_WS_PORT_START: "10000"
    STREAM_WS_PORT_END:   "10009"
    STREAM_MAX_PODS: "4"
    STREAM_POD_CMD: "python -m worker_stream_pod.main"
  depends_on: [postgres, nats]
```

No `ports:` mapping — the WS port range is consumed inside the docker network by the gateway, not from the host. No inbound media ports are needed because pods pull source URLs as outbound HTTPS.

(Note `STREAM_POD_CMD` points at the pod module from Task 7. The pod image is built separately and mounted into the supervisor image; for the POC a simpler option is to keep both in one container — see Step 9.)

- [ ] **Step 9: Pod-in-same-image POC choice**

For the skeleton, ship the pod and supervisor in one image so the supervisor can `subprocess.Popen` the pod module without inter-container plumbing. Set the Dockerfile to install both packages, set `STREAM_POD_CMD=python -m worker_stream_pod.main`. Splitting images is a later concern.

- [ ] **Step 10: Commit**

```
git add services/worker-stream-supervisor infra/docker-compose.yml
git commit -m "feat(supervisor): scaffold worker-stream-supervisor with WS port pool + forker, propagates source descriptor to pod env"
```

---

## Task 7: Pod scaffold with stub cue emitter and WebSocket server

**Files:**
- Create: `services/worker-stream-pod/pyproject.toml`
- Create: `services/worker-stream-pod/Dockerfile`
- Create: `services/worker-stream-pod/app/__init__.py`
- Create: `services/worker-stream-pod/app/main.py`
- Create: `services/worker-stream-pod/app/lifecycle.py`
- Create: `services/worker-stream-pod/app/stub_audio.py`
- Create: `services/worker-stream-pod/app/cue_emitter.py`
- Create: `services/worker-stream-pod/app/ws_server.py`
- Create: `services/worker-stream-pod/tests/test_cue_emitter.py`
- Create: `services/worker-stream-pod/tests/test_lifecycle.py`

- [ ] **Step 1: Write the failing cue-emitter test**

Create `services/worker-stream-pod/tests/test_cue_emitter.py`:

```python
import asyncio
from app.cue_emitter import CueEmitter, StubCueSource

def test_stub_emits_one_cue_per_interval():
    src = StubCueSource(interval_ms=10, max_cues=3)
    em = CueEmitter(source=src)
    cues = asyncio.run(em.collect_all())
    assert len(cues) == 3
    assert cues[0].cue_id == 0 and cues[2].cue_id == 2
    assert all(c.text.startswith("[stub cue") for c in cues)
    for prev, nxt in zip(cues, cues[1:]):
        assert nxt.start_ms >= prev.end_ms
```

- [ ] **Step 2: Write the failing lifecycle test**

Create `services/worker-stream-pod/tests/test_lifecycle.py`:

```python
import asyncio, json
from app.lifecycle import StatusReporter

class FakeJS:
    def __init__(self): self.published = []
    async def publish(self, subject, data): self.published.append((subject, json.loads(data)))

def test_status_reporter_emits_ingest_started_and_ended():
    js = FakeJS()
    r = StatusReporter(js=js, stream_id="s1", pod_id="p1")
    async def run():
        await r.mark_started()
        await r.mark_ended(reason="source_eof", cue_count=7)
    asyncio.run(run())
    subjects = [s for s,_ in js.published]
    assert subjects[0].endswith(".ingest.started")
    assert subjects[1].endswith(".ingest.ended")
    assert js.published[1][1]["cue_count"] == 7
```

- [ ] **Step 3: Run to verify failure**

```
cd services/worker-stream-pod && pytest -q
```

Expected: FAIL.

- [ ] **Step 4: Implement the cue emitter and stub source**

Create `services/worker-stream-pod/app/cue_emitter.py`:

```python
import asyncio, time
from dataclasses import dataclass
from typing import AsyncIterator, List, Optional

@dataclass
class Cue:
    cue_id: int
    start_ms: int
    end_ms: int
    text: str
    source_text: Optional[str] = None
    confidence: Optional[float] = None

class StubCueSource:
    def __init__(self, interval_ms: int = 5000, max_cues: Optional[int] = None):
        self.interval_ms = interval_ms
        self.max_cues = max_cues

    async def cues(self) -> AsyncIterator[Cue]:
        i = 0; start = 0
        while self.max_cues is None or i < self.max_cues:
            yield Cue(
                cue_id=i, start_ms=start, end_ms=start + self.interval_ms,
                text=f"[stub cue {i}] live captioning placeholder",
                confidence=1.0
            )
            i += 1; start += self.interval_ms
            await asyncio.sleep(self.interval_ms / 1000.0)

class CueEmitter:
    def __init__(self, source):
        self.source = source

    async def collect_all(self) -> List[Cue]:
        out = []
        async for c in self.source.cues(): out.append(c)
        return out
```

Create `services/worker-stream-pod/app/stub_audio.py` (placeholder for Plan 6; in this plan it just records that "the source produced a first decoded frame" after a fixed delay so the lifecycle can flip to `active`):

```python
import asyncio

class StubSourcePull:
    """Stand-in for Plan 6's ffmpeg-driven HLS/DASH/MP4 puller.

    In the skeleton the source URL is captured and logged but never opened;
    we just wait `first_packet_delay_s` to mimic the time-to-first-frame and
    then block until the pod is asked to shut down.
    """
    def __init__(self, source_kind: str, source_url: str, first_packet_delay_s: float = 2.0):
        self.source_kind = source_kind
        self.source_url = source_url
        self.first_packet_delay_s = first_packet_delay_s

    async def wait_for_first_packet(self) -> None:
        await asyncio.sleep(self.first_packet_delay_s)

    async def wait_for_eof_or_disconnect(self) -> str:
        # in skeleton: never returns until pod is cancelled; Plan 6 returns
        # "source_eof" on EOF or "source_failed" on persistent upstream error.
        await asyncio.Event().wait()
        return "source_eof"
```

- [ ] **Step 5: Implement the lifecycle reporter and WS server**

Create `services/worker-stream-pod/app/lifecycle.py`:

```python
import asyncio, json
from datetime import datetime, timezone
from audio_api_common import subjects

class StatusReporter:
    def __init__(self, js, stream_id: str, pod_id: str):
        self.js = js; self.stream_id = stream_id; self.pod_id = pod_id

    async def mark_started(self) -> None:
        await self.js.publish(subjects.STREAM_INGEST_STARTED, json.dumps({
            "stream_id": self.stream_id, "pod_id": self.pod_id,
            "started_at": datetime.now(timezone.utc).isoformat()
        }).encode())

    async def mark_ended(self, reason: str, cue_count: int) -> None:
        await self.js.publish(subjects.STREAM_INGEST_ENDED, json.dumps({
            "stream_id": self.stream_id, "pod_id": self.pod_id,
            "reason": reason, "cue_count": cue_count,
            "ended_at": datetime.now(timezone.utc).isoformat()
        }).encode())
```

Create `services/worker-stream-pod/app/ws_server.py`:

```python
import asyncio, json
from typing import Set
import websockets

class CueBroadcaster:
    def __init__(self):
        self.subs: Set[websockets.WebSocketServerProtocol] = set()
        self.lock = asyncio.Lock()

    async def register(self, ws):
        async with self.lock: self.subs.add(ws)

    async def unregister(self, ws):
        async with self.lock: self.subs.discard(ws)

    async def broadcast(self, payload: dict) -> None:
        data = json.dumps(payload)
        dead = []
        for ws in list(self.subs):
            try: await ws.send(data)
            except Exception: dead.append(ws)
        for ws in dead: await self.unregister(ws)

async def serve_ws(broadcaster: CueBroadcaster, host: str, port: int):
    async def handler(ws):
        await broadcaster.register(ws)
        try:
            await ws.wait_closed()
        finally:
            await broadcaster.unregister(ws)
    return await websockets.serve(handler, host, port)
```

- [ ] **Step 6: Implement the pod main**

Create `services/worker-stream-pod/app/main.py`:

```python
import asyncio, json, os, signal
import nats, psycopg, structlog
from .cue_emitter import StubCueSource, Cue
from .stub_audio import StubSourcePull
from .lifecycle import StatusReporter
from .ws_server import CueBroadcaster, serve_ws
from audio_api_common import subjects

log = structlog.get_logger("worker-stream-pod")

STREAM_ID    = os.environ["STREAM_ID"]
POD_ID       = os.environ["POD_ID"]
WS_BIND_HOST = os.environ.get("POD_WS_BIND", "0.0.0.0")
WS_PORT      = int(os.environ["WS_PORT"])
SOURCE_KIND  = os.environ["SOURCE_KIND"]
SOURCE_URL   = os.environ["SOURCE_URL"]
NATS_URL     = os.environ.get("NATS_URL", "nats://nats:4222")
DATABASE_URL = os.environ["DATABASE_URL"]

async def main():
    nc = await nats.connect(NATS_URL)
    js = nc.jetstream()
    bcast = CueBroadcaster()
    ws_server = await serve_ws(bcast, WS_BIND_HOST, WS_PORT)
    reporter = StatusReporter(js=js, stream_id=STREAM_ID, pod_id=POD_ID)
    audio = StubSourcePull(source_kind=SOURCE_KIND, source_url=SOURCE_URL)
    log.info("pod_started", stream_id=STREAM_ID, source_kind=SOURCE_KIND, source_url=SOURCE_URL)

    # publish pod ws endpoint so the gateway can route to it
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
        async with conn.cursor() as cur:
            await cur.execute("UPDATE stream_pods SET status='ready' WHERE pod_id=%s", (POD_ID,))
        await conn.commit()

    await audio.wait_for_first_packet()
    await reporter.mark_started()

    cue_count = 0
    src = StubCueSource(interval_ms=5000)
    stop = asyncio.Event()
    def _stop(*_): stop.set()
    signal.signal(signal.SIGTERM, _stop); signal.signal(signal.SIGINT, _stop)

    async def emit_loop():
        nonlocal cue_count
        async for cue in src.cues():
            if stop.is_set(): break
            await bcast.broadcast({
                "event": "cue.finalised",
                "stream_id": STREAM_ID,
                "cue_id": cue.cue_id,
                "start_ms": cue.start_ms, "end_ms": cue.end_ms,
                "text": cue.text, "confidence": cue.confidence
            })
            await js.publish(subjects.STREAM_CUE_FINALISED, json.dumps({
                "stream_id": STREAM_ID, "cue_id": cue.cue_id,
                "start_ms": cue.start_ms, "end_ms": cue.end_ms,
                "text": cue.text, "confidence": cue.confidence
            }).encode())
            async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "INSERT INTO stream_cues (stream_id, cue_id, start_ms, end_ms, text, confidence) "
                        "VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                        (STREAM_ID, cue.cue_id, cue.start_ms, cue.end_ms, cue.text, cue.confidence)
                    )
                    await cur.execute(
                        "UPDATE streams SET cue_count = cue_count + 1 WHERE id=%s", (STREAM_ID,)
                    )
                await conn.commit()
            cue_count += 1

    emit_task = asyncio.create_task(emit_loop())
    await stop.wait()
    emit_task.cancel()
    try: await emit_task
    except asyncio.CancelledError: pass

    await reporter.mark_ended(reason="client_delete", cue_count=cue_count)
    ws_server.close(); await ws_server.wait_closed()
    await nc.drain()
    log.info("pod_exited", stream_id=STREAM_ID, cues=cue_count)

if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 7: Run pod tests to verify pass**

```
cd services/worker-stream-pod && pytest -q
```

Expected: PASS.

- [ ] **Step 8: Sanity-check pod-supervisor wiring**

The supervisor (Task 6) already allocates the WS port, inserts it into `stream_pods.ws_host`/`ws_port`, passes it via the `WS_HOST`/`WS_PORT` env vars to the pod, and publishes it on `STREAM_READY`. Verify by running the supervisor and pod in compose locally and asserting:

```
psql -c "select pod_id, ws_host, ws_port, status from stream_pods order by last_heartbeat desc limit 1;"
```

shows a populated row whose `ws_port` matches the value in the most recent `audio.stream.ready` NATS message. No new migration is needed (`ws_port` lives in migration 0003 alongside the other pod columns).

- [ ] **Step 9: Commit**

```
git add services/worker-stream-pod packages/proto services/worker-stream-supervisor infra/migrations
git commit -m "feat(pod): scaffold worker-stream-pod with stub cue source + WS broadcast"
```

---

## Task 8: Gateway WebSocket proxy

**Files:**
- Create: `services/api-gateway/src/routes/streams-ws.ts`
- Modify: `services/api-gateway/src/server.ts`
- Modify: `services/api-gateway/package.json`
- Test: `services/api-gateway/src/routes/streams-ws.test.ts`

- [ ] **Step 1: Add deps**

In `services/api-gateway/package.json` dependencies:

```json
"@fastify/websocket": "^11.0.0",
"ws": "^8.18.0"
```

Then:

```
pnpm install
```

- [ ] **Step 2: Write the failing proxy test**

Create `services/api-gateway/src/routes/streams-ws.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../server.js";
import { getPool } from "@audio-api/node-common";
import { WebSocketServer, WebSocket } from "ws";

let app: Awaited<ReturnType<typeof buildServer>>;
let upstream: WebSocketServer;
let upstreamPort: number;
const AUTH = { authorization: "Bearer dev-token" };

beforeAll(async () => {
  upstream = new WebSocketServer({ port: 0 });
  upstreamPort = (upstream.address() as any).port;
  upstream.on("connection", ws => ws.send(JSON.stringify({ event: "cue.finalised", text: "hi" })));
  app = await buildServer(); await app.listen({ port: 0 });
});
afterAll(async () => { upstream.close(); await app.close(); });

describe("WS proxy at /v1/streams/:id/captions", () => {
  it("forwards messages from the pod to the client", async () => {
    // seed a stream + pod row pointing at the upstream port
    const id = "s_ws_test_01";
    await getPool().query(
      "INSERT INTO streams (id, tenant_id, status, target_lang, source_kind, source_url, pod_id) " +
      "VALUES ($1, 't_dev', 'active', 'en', 'hls', 'https://example.com/test.m3u8', 'p_ws_test_01') ON CONFLICT DO NOTHING",
      [id]
    );
    await getPool().query(
      "INSERT INTO stream_pods (pod_id, supervisor_host, ws_host, ws_port, stream_id, status) " +
      "VALUES ('p_ws_test_01','localhost','localhost',$1,$2,'ready') ON CONFLICT DO NOTHING",
      [upstreamPort, id]
    );

    const addr = app.server.address() as any;
    const client = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/streams/${id}/captions`, {
      headers: AUTH
    });
    const msg = await new Promise<string>((res, rej) => {
      client.on("message", d => res(d.toString()));
      client.on("error", rej);
    });
    expect(JSON.parse(msg).text).toBe("hi");
    client.close();
  });
});
```

- [ ] **Step 3: Run to verify failure**

```
pnpm --filter @audio-api/api-gateway test -- streams-ws
```

Expected: FAIL (no WS route).

- [ ] **Step 4: Implement the proxy**

Create `services/api-gateway/src/routes/streams-ws.ts`:

```typescript
import { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import WebSocket from "ws";
import { getPool, ApiError } from "@audio-api/node-common";

export async function streamsWsRoutes(app: FastifyInstance) {
  await app.register(websocketPlugin);

  app.get<{ Params: { id: string } }>("/v1/streams/:id/captions", { websocket: true, onRequest: app.requireAuth }, async (conn, req) => {
    const row = await getPool().query(
      `SELECT p.ws_host AS host, p.ws_port AS port
       FROM streams s JOIN stream_pods p ON p.pod_id = s.pod_id
       WHERE s.id=$1 AND s.tenant_id=$2 AND p.status IN ('ready','ingesting')`,
      [req.params.id, (req as any).tenant_id]
    );
    if (row.rowCount === 0) {
      conn.socket.send(JSON.stringify({ event: "error", code: "STREAM_NOT_FOUND" }));
      return conn.socket.close();
    }
    const { host, port } = row.rows[0];
    const upstream = new WebSocket(`ws://${host}:${port}`);
    upstream.on("open",   () => { /* nothing to send upstream */ });
    upstream.on("message", d => { try { conn.socket.send(d.toString()); } catch {} });
    upstream.on("close",  () => conn.socket.close());
    upstream.on("error",  () => conn.socket.close());
    conn.socket.on("close", () => upstream.close());
  });
}
```

Register in `services/api-gateway/src/server.ts`:

```typescript
import { streamsWsRoutes } from "./routes/streams-ws.js";
await app.register(streamsWsRoutes);
```

- [ ] **Step 5: Run tests to verify pass**

```
pnpm --filter @audio-api/api-gateway test -- streams-ws
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
git add services/api-gateway
git commit -m "feat(gateway): WebSocket proxy /v1/streams/:id/captions -> pod"
```

---

## Task 9: End-to-end skeleton smoke test

**Files:**
- Create: `tests/integration/stream-skeleton.test.ts`
- Create: `scripts/submit-stream.sh`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/stream-skeleton.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { WebSocket } from "ws";

const API = process.env.API_URL ?? "http://localhost:8080";
const WS  = process.env.WS_URL  ?? "ws://localhost:8080";
const TOKEN = process.env.DEV_TOKEN ?? "dev-token";

describe("stream skeleton end-to-end", () => {
  it("creates a stream and receives at least 2 stub cues over WS within 20s", async () => {
    // The pod is stubbed in Plan 5; the URL is never opened. Any well-formed https URL
    // satisfies the gateway's validation. Plan 6 replaces this with a real local HLS fixture.
    const r = await fetch(`${API}/v1/streams`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        source: { kind: "hls", url: "https://fixtures.invalid/skeleton.m3u8" },
        source_hint: "fr",
        output: { target_lang: "en" }
      })
    });
    expect(r.status).toBe(201);
    const body = await r.json();
    const id = body.stream_id;

    // wait for status=active (supervisor + pod ready)
    let status = "provisioning";
    for (let i = 0; i < 40; i++) {
      const s = await fetch(`${API}/v1/streams/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      status = (await s.json()).status;
      if (status === "active") break;
      await new Promise(r => setTimeout(r, 500));
    }
    expect(status).toBe("active");

    const cues: any[] = [];
    const ws = new WebSocket(`${WS}/v1/streams/${id}/captions`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    await new Promise<void>((res, rej) => {
      ws.on("message", d => {
        const msg = JSON.parse(d.toString());
        if (msg.event === "cue.finalised") cues.push(msg);
        if (cues.length >= 2) res();
      });
      ws.on("error", rej);
      setTimeout(() => rej(new Error("timed out waiting for cues")), 20_000);
    });
    ws.close();

    expect(cues[0].text).toMatch(/stub cue/);
    expect(cues[1].cue_id).toBeGreaterThan(cues[0].cue_id);

    const del = await fetch(`${API}/v1/streams/${id}`, {
      method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(del.status).toBe(202);
  }, 30_000);
});
```

- [ ] **Step 2: Add the manual demo helper**

Create `scripts/submit-stream.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
API="${API_URL:-http://localhost:8080}"
TOKEN="${DEV_TOKEN:-dev-token}"
SOURCE_KIND="${SOURCE_KIND:-hls}"
SOURCE_URL="${SOURCE_URL:-https://fixtures.invalid/skeleton.m3u8}"
curl -s -X POST "$API/v1/streams" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d "{\"source\":{\"kind\":\"$SOURCE_KIND\",\"url\":\"$SOURCE_URL\"},\"source_hint\":\"fr\",\"output\":{\"target_lang\":\"en\"}}" | tee /tmp/stream.json
ID=$(jq -r .stream_id /tmp/stream.json)
echo "Stream: $ID"
echo "WS:     $(jq -r .outputs.websocket_url /tmp/stream.json)"
```

Make executable: `chmod +x scripts/submit-stream.sh`.

- [ ] **Step 3: Bring the stack up and run the test**

```
make up && make migrate
pnpm --filter @audio-api/integration-tests test -- stream-skeleton
```

Expected: PASS.

- [ ] **Step 4: Manual sanity check**

```
./scripts/submit-stream.sh
```

In another shell, connect with `wscat -c "ws://localhost:8080/v1/streams/<id>/captions" -H "authorization: Bearer dev-token"` and verify stub cues stream in.

- [ ] **Step 5: Commit**

```
git add tests/integration/stream-skeleton.test.ts scripts/submit-stream.sh
git commit -m "test(integration): end-to-end skeleton stream lifecycle with stub cues"
```

---

## Verification at end of Plan 5

After all tasks above are complete, the following must all be true:

- `make up && make migrate` brings the full stack up cleanly.
- `pnpm -r test` passes across all touched workspaces.
- `pnpm --filter @audio-api/integration-tests test -- stream-skeleton` passes.
- Manually: `./scripts/submit-stream.sh` (defaults to a placeholder HLS URL) returns a stream id; status transitions `provisioning → awaiting_ingest → active` within ~3s; WS captions emit a stub cue every 5s; `DELETE` flips status to `ending` and the pod exits. `SOURCE_KIND=mp4 SOURCE_URL=https://fixtures.invalid/clip.mp4 ./scripts/submit-stream.sh` also succeeds (the pod is stubbed; both source kinds are accepted by the gateway).
- `git log --oneline` shows one commit per task (8 commits) on top of the design-spec commit on `main`.

If any of these fail, do not move to Plan 6.

---

## Self-review notes (already addressed inline)

- All proto and schema names match between TypeScript (`SUBJECTS.*`) and Python (`subjects.*`).
- The `streams.pod_id`, `stream_pods.pod_id`, and pod-emitted `pod_id` use the same `p_<ULID>` shape produced by either `podId()` (TS) or the supervisor's `f"p_{sid[2:]}"` mapping (Python). Both formats validate against the regex in the ID test.
- `stream_pods.ws_host` / `ws_port` are added in migration 0003 from the start; the WS proxy test in Task 8 reads them directly. No fast-follow migration needed.
- `source.headers` are stored as plaintext JSONB in this plan. The pod is stubbed and never opens the URL, so there is no leakage surface yet. Plan 6 migrates `source_headers` to AES-GCM encrypted BYTEA in lock-step with the first real ffmpeg pull.
- All endpoints requiring auth use the existing `app.requireAuth` decorator already wired in `services/api-gateway/src/auth.ts`.

---

## Next plan

**Plan 6: Live Subtitles Inference & TTML Archive.** Replaces `StubSourcePull` and `StubCueSource` with real ffmpeg-driven pull from HLS / DASH / MP4 URLs (including SSRF allow/deny enforcement and AES-GCM at rest for `source_headers`), Silero VAD, faster-whisper translate. Adds the rolling WebVTT segment writer, gateway HTTP proxy for VTT, and the `worker-tt-archiver` Node service producing EBU-TT-D files at end of stream. Adds observability metrics and a latency smoke test asserting first-cue-within-8s on the standard local HLS fixture, plus an MP4-file smoke test asserting the archive lands on ffmpeg EOF.
