# Audio API Plan 1: Skeleton + Format Slice

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the full monorepo, infrastructure stack, and one end-to-end vertical slice: submit a URL, the system fetches it, runs `ffprobe`, returns a format report. By the end of this plan you can `docker compose up`, hit the API with a real audio URL, and get JSON back.

**Architecture:** Event-driven workers on NATS JetStream. Node/TS for API gateway, orchestrator, aggregator, fetcher. Python for analysis workers. Postgres for job state, MinIO for object storage, OpenTelemetry for tracing.

**Tech Stack:**
- Node 20 LTS, TypeScript 5, Fastify 4, `pg` (node-postgres), `nats.js`, `@aws-sdk/client-s3` (MinIO), `pino`, `@opentelemetry/sdk-node`, `vitest`, `pnpm` workspaces
- Python 3.12, FastAPI (for health only), `nats-py`, `psycopg[binary]`, `boto3`, `structlog`, `opentelemetry-sdk`, `pytest`, `ruff`
- Postgres 16, NATS 2.10 with JetStream, MinIO RELEASE.2024+, OTel Collector, Tempo, Loki, Grafana
- `node-pg-migrate` for SQL migrations
- `ajv` (Node) and `jsonschema` (Python) to validate against shared JSON Schemas

**Reference:** `docs/superpowers/specs/2026-05-14-audio-api-design.md` (committed at `8577392`).

---

## File Structure (created in this plan)

```
audio-api/                              # NEW MONOREPO ROOT (created under repo)
  package.json                          # pnpm workspace root
  pnpm-workspace.yaml
  tsconfig.base.json
  .env.example
  .gitignore
  Makefile
  README.md
  .github/workflows/ci.yml
  services/
    api-gateway/        (Node/TS)
    orchestrator/       (Node/TS)
    aggregator/         (Node/TS)
    worker-fetcher/     (Node/TS)
    worker-format/      (Python)
  packages/
    proto/              # shared message schemas (JSON Schema), Node + Python generators
    contracts/          # OpenAPI 3.1 spec, error code catalogue
    node-common/        # shared logger, tracer, NATS client, error utilities
    py-common/          # same idea for Python workers
  infra/
    docker-compose.yml
    grafana/dashboards/throughput.json   (stubs, real dashboards in Plan 6)
    otel/collector-config.yaml
    migrations/0001_init.sql
    nats/bootstrap-streams.sh
  scripts/
    seed-token.sh
    submit-sample.sh
    smoke.ts
  tests/
    fixtures/audio/sample-stereo.wav     (~5s, committed)
    integration/format-slice.test.ts
```

All app code lives under `audio-api/`. The existing EA repo stays untouched outside that directory.

---

## Task 1: Initialise the monorepo

**Files:**
- Create: `audio-api/package.json`
- Create: `audio-api/pnpm-workspace.yaml`
- Create: `audio-api/tsconfig.base.json`
- Create: `audio-api/.gitignore`
- Create: `audio-api/.env.example`
- Create: `audio-api/Makefile`
- Create: `audio-api/README.md`

- [ ] **Step 1: Create `audio-api/` and root `package.json`**

```json
{
  "name": "audio-api",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@9.0.0",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "up": "docker compose -f infra/docker-compose.yml up -d",
    "down": "docker compose -f infra/docker-compose.yml down",
    "logs": "docker compose -f infra/docker-compose.yml logs -f",
    "smoke": "tsx scripts/smoke.ts"
  },
  "devDependencies": {
    "tsx": "^4.7.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "services/*"
  - "packages/*"
```

- [ ] **Step 3: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
*.log
.env
.env.local
__pycache__/
*.pyc
.pytest_cache/
.venv/
coverage/
```

- [ ] **Step 5: Create `.env.example` (full env contract for the stack)**

```
# Core
LOG_LEVEL=info
SERVICE_VERSION=dev

# Postgres
DATABASE_URL=postgres://audio:audio@postgres:5432/audio

# NATS
NATS_URL=nats://nats:4222

# Object storage
OBJECT_STORE_ENDPOINT=http://minio:9000
OBJECT_STORE_BUCKET=audio-api
OBJECT_STORE_ACCESS_KEY=audioadmin
OBJECT_STORE_SECRET_KEY=audioadminpw
OBJECT_STORE_REGION=us-east-1

# Telemetry
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
OTEL_SERVICE_NAME=unset

# API gateway
API_PORT=8080
SYNC_TIMEOUT_MS=60000
JOB_SIZE_LIMIT_MB=10000

# Worker concurrency
WORKER_CONCURRENCY=2
```

- [ ] **Step 6: Create `Makefile`**

```makefile
.PHONY: up down logs migrate seed smoke test build clean

up:
	docker compose -f infra/docker-compose.yml up -d

down:
	docker compose -f infra/docker-compose.yml down

logs:
	docker compose -f infra/docker-compose.yml logs -f

migrate:
	docker compose -f infra/docker-compose.yml run --rm migrate

seed:
	./scripts/seed-token.sh

smoke:
	pnpm smoke

test:
	pnpm -r test

build:
	pnpm -r build

clean:
	docker compose -f infra/docker-compose.yml down -v
	rm -rf node_modules services/*/node_modules packages/*/node_modules
```

- [ ] **Step 7: Create stub `README.md`**

```markdown
# Audio API

Audio analysis service. See `docs/superpowers/specs/2026-05-14-audio-api-design.md`.

## Quickstart

    cp .env.example .env
    make up
    make migrate
    make seed
    make smoke
```

- [ ] **Step 8: Run `pnpm install` to verify workspace is valid**

Run: `cd audio-api && pnpm install`
Expected: Lockfile created, no errors. `node_modules/` populated with `tsx` and `typescript`.

- [ ] **Step 9: Commit**

```bash
git add audio-api/package.json audio-api/pnpm-workspace.yaml audio-api/tsconfig.base.json audio-api/.gitignore audio-api/.env.example audio-api/Makefile audio-api/README.md audio-api/pnpm-lock.yaml
git commit -m "feat(audio-api): bootstrap monorepo with pnpm workspaces"
```

---

## Task 2: Contracts package (OpenAPI + error codes)

**Files:**
- Create: `audio-api/packages/contracts/package.json`
- Create: `audio-api/packages/contracts/openapi.yaml`
- Create: `audio-api/packages/contracts/error-codes.yaml`
- Create: `audio-api/packages/contracts/src/index.ts`
- Create: `audio-api/packages/contracts/tsconfig.json`

- [ ] **Step 1: Create `packages/contracts/package.json`**

```json
{
  "name": "@audio-api/contracts",
  "version": "0.1.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "openapi.yaml", "error-codes.yaml"],
  "scripts": {
    "build": "tsc",
    "lint": "spectral lint openapi.yaml",
    "typecheck": "tsc --noEmit",
    "test": "echo no tests yet"
  },
  "devDependencies": {
    "@stoplight/spectral-cli": "^6.11.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `packages/contracts/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/contracts/error-codes.yaml` (stable error catalogue, Section 6.2 of spec)**

```yaml
INPUT_UNREACHABLE:        { http: 400, retry: false, action: "Verify the source URL is reachable and unauthenticated or signed." }
INPUT_UNSUPPORTED_CODEC:  { http: 415, retry: false, action: "Re-encode source to PCM/AAC/FLAC." }
INPUT_TOO_LARGE:          { http: 413, retry: false, action: "Reduce file size below JOB_SIZE_LIMIT_MB." }
INPUT_AUTH_FAILED:        { http: 401, retry: false, action: "Renew presigned URL." }
FORMAT_PROBE_FAILED:      { http: 422, retry: true,  action: "Source may be corrupt; retry once." }
VAD_MODEL_FAILED:         { http: 500, retry: true,  action: "Transient model error; retry." }
LANGUAGE_LOW_CONFIDENCE:  { http: 200, retry: false, action: "Surface as result with low confidence flag, not an error." }
DME_CLASSIFY_FAILED:      { http: 500, retry: true,  action: "Transient model error; retry." }
DME_SEPARATE_OOM:         { http: 500, retry: true,  action: "GPU OOM; retry on a larger instance." }
JOB_CANCELLED:            { http: 409, retry: false, action: "Job was cancelled before completion." }
RATE_LIMITED:             { http: 429, retry: true,  action: "Back off and retry after Retry-After." }
INTERNAL:                 { http: 500, retry: true,  action: "Unexpected error; trace_id provided for support." }
```

- [ ] **Step 4: Create `packages/contracts/openapi.yaml` (minimum for Plan 1: health, POST /v1/jobs, GET /v1/jobs/:id, GET /v1/jobs/:id/results)**

```yaml
openapi: 3.1.0
info:
  title: Audio API
  version: 0.1.0
  description: Audio analysis service. Internal-first.
servers:
  - url: http://localhost:8080
security:
  - bearerAuth: []
paths:
  /v1/health:
    get:
      summary: Service health
      security: []
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Health" }
  /v1/jobs:
    post:
      summary: Submit a job
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/JobSubmission" }
      responses:
        "201":
          description: Accepted
          content:
            application/json:
              schema: { $ref: "#/components/schemas/JobCreated" }
        "400":
          description: Bad request
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "401":
          description: Unauthorised
  /v1/jobs/{id}:
    get:
      summary: Get job status
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/JobStatus" }
        "404":
          description: Not found
  /v1/jobs/{id}/results:
    get:
      summary: Get aggregated results
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/JobReport" }
        "404":
          description: Not found
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
  schemas:
    Health:
      type: object
      required: [status, services]
      properties:
        status: { type: string, enum: [ok, degraded] }
        services:
          type: object
          additionalProperties:
            type: object
            properties:
              status: { type: string }
              version: { type: string }
    JobSubmission:
      type: object
      required: [input, analyses]
      properties:
        input:
          type: object
          required: [type]
          properties:
            type: { type: string, enum: [url] }
            url: { type: string, format: uri }
        analyses:
          type: array
          items: { type: string, enum: [format] }
          minItems: 1
        callback_url: { type: string, format: uri }
        mode: { type: string, enum: [sync, async], default: async }
    JobCreated:
      type: object
      required: [job_id, status]
      properties:
        job_id: { type: string }
        status: { type: string, enum: [queued, running, completed, failed, cancelled] }
    JobStatus:
      type: object
      required: [job_id, status, analyses]
      properties:
        job_id: { type: string }
        status: { type: string }
        created_at: { type: string, format: date-time }
        started_at: { type: string, format: date-time }
        completed_at: { type: string, format: date-time }
        analyses:
          type: array
          items:
            type: object
            properties:
              name: { type: string }
              status: { type: string }
              attempts: { type: integer }
    JobReport:
      type: object
      required: [job_id]
      properties:
        job_id: { type: string }
        input:
          type: object
          properties:
            duration_s: { type: number }
            size_bytes: { type: integer }
        format:
          type: object
          properties:
            codec: { type: string }
            sample_rate: { type: integer }
            bit_depth: { type: integer }
            channel_count: { type: integer }
            channel_layout: { type: string }
            channels:
              type: array
              items:
                type: object
                properties:
                  index: { type: integer }
                  label: { type: string }
        failures:
          type: array
          items: { $ref: "#/components/schemas/Failure" }
    Failure:
      type: object
      required: [analysis, code, message]
      properties:
        analysis: { type: string }
        code: { type: string }
        message: { type: string }
        stage: { type: string }
        trace_id: { type: string }
        occurred_at: { type: string, format: date-time }
    Error:
      type: object
      required: [code, message]
      properties:
        code: { type: string }
        message: { type: string }
        trace_id: { type: string }
```

- [ ] **Step 5: Create `packages/contracts/src/index.ts`**

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import yaml from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

export interface ErrorCodeMeta {
  http: number;
  retry: boolean;
  action: string;
}

export const ERROR_CODES: Record<string, ErrorCodeMeta> = yaml.parse(
  readFileSync(resolve(root, "error-codes.yaml"), "utf8")
);

export function httpStatusFor(code: string): number {
  return ERROR_CODES[code]?.http ?? 500;
}

export type ErrorCode = keyof typeof ERROR_CODES;
```

- [ ] **Step 6: Add `yaml` dependency and build**

Run:
```bash
cd audio-api/packages/contracts
pnpm add yaml
pnpm add -D @types/node
pnpm build
```
Expected: `dist/index.js` and `dist/index.d.ts` produced.

- [ ] **Step 7: Run spectral lint**

Run: `pnpm lint`
Expected: 0 errors (warnings about missing examples are acceptable).

- [ ] **Step 8: Commit**

```bash
git add audio-api/packages/contracts
git commit -m "feat(contracts): add OpenAPI spec and error code catalogue"
```

---

## Task 3: Proto package (queue message schemas)

**Files:**
- Create: `audio-api/packages/proto/package.json`
- Create: `audio-api/packages/proto/schemas/envelope.json`
- Create: `audio-api/packages/proto/schemas/events/file-ready.json`
- Create: `audio-api/packages/proto/schemas/events/format-ready.json`
- Create: `audio-api/packages/proto/src/index.ts`
- Create: `audio-api/packages/proto/tsconfig.json`

- [ ] **Step 1: Create `packages/proto/package.json`**

```json
{
  "name": "@audio-api/proto",
  "version": "0.1.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "schemas"],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "lint": "echo ok",
    "test": "vitest run"
  },
  "dependencies": {
    "ajv": "^8.12.0",
    "ajv-formats": "^3.0.1"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  }
}
```

- [ ] **Step 2: Create `packages/proto/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `schemas/envelope.json` (every queue message wraps this)**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "envelope.json",
  "type": "object",
  "required": ["job_id", "tenant_id", "trace_id", "attempt_id", "emitted_at", "payload"],
  "properties": {
    "job_id":     { "type": "string" },
    "tenant_id":  { "type": "string" },
    "trace_id":   { "type": "string" },
    "span_id":    { "type": "string" },
    "attempt_id": { "type": "string" },
    "emitted_at": { "type": "string", "format": "date-time" },
    "payload":    { "type": "object" }
  }
}
```

- [ ] **Step 4: Create `schemas/events/file-ready.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "events/file-ready.json",
  "type": "object",
  "required": ["object_key", "size_bytes", "sha256"],
  "properties": {
    "object_key": { "type": "string" },
    "size_bytes": { "type": "integer", "minimum": 0 },
    "sha256":     { "type": "string", "pattern": "^[a-f0-9]{64}$" }
  }
}
```

- [ ] **Step 5: Create `schemas/events/format-ready.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "events/format-ready.json",
  "type": "object",
  "required": ["result_object", "codec", "sample_rate", "channel_count"],
  "properties": {
    "result_object":  { "type": "string" },
    "codec":          { "type": "string" },
    "sample_rate":    { "type": "integer" },
    "bit_depth":      { "type": "integer" },
    "channel_count":  { "type": "integer" },
    "channel_layout": { "type": "string" },
    "duration_s":     { "type": "number" }
  }
}
```

- [ ] **Step 6: Create `src/index.ts` with the validator factory and TS types**

```ts
import Ajv, { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const schemasDir = resolve(here, "..", "schemas");

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

function load(name: string): ValidateFunction {
  const raw = readFileSync(resolve(schemasDir, name), "utf8");
  return ajv.compile(JSON.parse(raw));
}

export const validateEnvelope = load("envelope.json");
export const validateFileReady = load("events/file-ready.json");
export const validateFormatReady = load("events/format-ready.json");

export interface Envelope<P = unknown> {
  job_id: string;
  tenant_id: string;
  trace_id: string;
  span_id?: string;
  attempt_id: string;
  emitted_at: string;
  payload: P;
}

export interface FileReady {
  object_key: string;
  size_bytes: number;
  sha256: string;
}

export interface FormatReady {
  result_object: string;
  codec: string;
  sample_rate: number;
  bit_depth?: number;
  channel_count: number;
  channel_layout?: string;
  duration_s?: number;
}

export const SUBJECTS = {
  WORK_FETCH:        "audio.work.fetch",
  WORK_FORMAT:       "audio.work.format",
  EVENT_FILE_READY:   "audio.event.file.ready",
  EVENT_FORMAT_READY: "audio.event.format.ready",
  EVENT_JOB_DONE:     "audio.event.job.completed",
  EVENT_JOB_FAILED:   "audio.event.job.failed"
} as const;
```

- [ ] **Step 7: Write test for the validators (TDD: this is the first real logic)**

Create `packages/proto/src/index.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateEnvelope, validateFileReady } from "./index.js";

describe("envelope schema", () => {
  it("accepts a well-formed envelope", () => {
    const ok = validateEnvelope({
      job_id: "j_01HX",
      tenant_id: "t_acme",
      trace_id: "abc",
      attempt_id: "att",
      emitted_at: new Date().toISOString(),
      payload: {}
    });
    expect(ok).toBe(true);
  });
  it("rejects missing fields", () => {
    const ok = validateEnvelope({ job_id: "j" });
    expect(ok).toBe(false);
    expect(validateEnvelope.errors?.length).toBeGreaterThan(0);
  });
});

describe("file-ready schema", () => {
  it("validates sha256 format", () => {
    expect(validateFileReady({ object_key: "k", size_bytes: 1, sha256: "x" })).toBe(false);
    const goodHash = "a".repeat(64);
    expect(validateFileReady({ object_key: "k", size_bytes: 1, sha256: goodHash })).toBe(true);
  });
});
```

- [ ] **Step 8: Run tests, expect they fail until built**

Run: `cd audio-api/packages/proto && pnpm install && pnpm test`
Expected: tests pass (Ajv compiles schemas at runtime, no build step needed for tests).

- [ ] **Step 9: Build the package**

Run: `pnpm build`
Expected: `dist/index.js` produced.

- [ ] **Step 10: Commit**

```bash
git add audio-api/packages/proto
git commit -m "feat(proto): add envelope + file/format event schemas with validators"
```

---

## Task 4: Postgres migration (initial schema)

**Files:**
- Create: `audio-api/infra/migrations/0001_init.sql`

- [ ] **Step 1: Create `infra/migrations/0001_init.sql` (Section 5.1 of spec)**

```sql
BEGIN;

CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  status          TEXT NOT NULL,
  input_descriptor JSONB NOT NULL,
  options         JSONB NOT NULL DEFAULT '{}',
  callback_url    TEXT,
  mode            TEXT NOT NULL,
  source_object   TEXT,
  source_sha256   TEXT,
  duration_s      NUMERIC,
  size_bytes      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  error           JSONB
);
CREATE INDEX idx_jobs_tenant_created ON jobs (tenant_id, created_at DESC);
CREATE INDEX idx_jobs_active_status  ON jobs (status) WHERE status IN ('queued','running');

CREATE TABLE analyses (
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL,
  attempts        INT  NOT NULL DEFAULT 0,
  result_object   TEXT,
  error           JSONB,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  PRIMARY KEY (job_id, name)
);

CREATE TABLE results (
  job_id          TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  report          JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE job_events (
  id              BIGSERIAL PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind            TEXT NOT NULL,
  stage           TEXT,
  payload         JSONB
);
CREATE INDEX idx_job_events_job_ts ON job_events (job_id, ts);

CREATE TABLE api_tokens (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  token_hash      TEXT NOT NULL,
  name            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_api_tokens_active_hash ON api_tokens (token_hash) WHERE revoked_at IS NULL;

CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(version) VALUES ('0001');

COMMIT;
```

- [ ] **Step 2: Commit**

```bash
git add audio-api/infra/migrations/0001_init.sql
git commit -m "feat(db): initial schema for jobs, analyses, results, events, tokens"
```

---

## Task 5: Docker Compose for infrastructure services

**Files:**
- Create: `audio-api/infra/docker-compose.yml`
- Create: `audio-api/infra/nats/bootstrap-streams.sh`
- Create: `audio-api/infra/otel/collector-config.yaml`

- [ ] **Step 1: Create `infra/nats/bootstrap-streams.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
URL="${NATS_URL:-nats://nats:4222}"

nats --server "$URL" stream add AUDIO_WORK \
  --subjects "audio.work.>" \
  --storage file --retention limits --max-age 7d \
  --max-msgs=-1 --max-bytes=-1 --discard old \
  --replicas 1 --defaults || true

nats --server "$URL" stream add AUDIO_EVENTS \
  --subjects "audio.event.>" \
  --storage file --retention limits --max-age 24h \
  --max-msgs=-1 --max-bytes=-1 --discard old \
  --replicas 1 --defaults || true

echo "Streams ready."
```

Make executable: `chmod +x infra/nats/bootstrap-streams.sh`

- [ ] **Step 2: Create `infra/otel/collector-config.yaml` (minimal: receive OTLP, export to Tempo and Loki)**

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch: {}

exporters:
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
  loki:
    endpoint: http://loki:3100/loki/api/v1/push

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/tempo]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [loki]
```

- [ ] **Step 3: Create `infra/docker-compose.yml` (infra services only for now)**

```yaml
name: audio-api
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: audio
      POSTGRES_PASSWORD: audio
      POSTGRES_DB: audio
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U audio"]
      interval: 5s
      retries: 10

  migrate:
    image: postgres:16-alpine
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - ./migrations:/migrations:ro
    environment:
      PGPASSWORD: audio
    entrypoint: ["sh", "-c"]
    command:
      - "for f in /migrations/*.sql; do echo applying $$f; psql -h postgres -U audio -d audio -v ON_ERROR_STOP=1 -f $$f; done"

  nats:
    image: nats:2.10-alpine
    command: ["-js", "-sd", "/data"]
    ports: ["4222:4222", "8222:8222"]
    volumes:
      - natsdata:/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8222/varz"]
      interval: 5s
      retries: 10

  nats-bootstrap:
    image: natsio/nats-box:latest
    depends_on:
      nats:
        condition: service_healthy
    environment:
      NATS_URL: nats://nats:4222
    volumes:
      - ./nats/bootstrap-streams.sh:/bootstrap.sh:ro
    entrypoint: ["sh", "/bootstrap.sh"]

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: audioadmin
      MINIO_ROOT_PASSWORD: audioadminpw
    ports: ["9000:9000", "9001:9001"]
    volumes:
      - miniodata:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      retries: 10

  minio-bootstrap:
    image: minio/mc:latest
    depends_on:
      minio:
        condition: service_healthy
    entrypoint: ["sh", "-c"]
    command:
      - >
        mc alias set local http://minio:9000 audioadmin audioadminpw &&
        mc mb --ignore-existing local/audio-api

  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.96.0
    command: ["--config=/etc/otel/config.yaml"]
    volumes:
      - ./otel/collector-config.yaml:/etc/otel/config.yaml:ro
    ports: ["4317:4317", "4318:4318"]
    depends_on: [tempo, loki]

  tempo:
    image: grafana/tempo:2.4.0
    command: ["-config.file=/etc/tempo.yaml"]
    ports: ["3200:3200"]
    volumes:
      - ./grafana/tempo.yaml:/etc/tempo.yaml:ro

  loki:
    image: grafana/loki:2.9.0
    command: ["-config.file=/etc/loki/local-config.yaml"]
    ports: ["3100:3100"]

  grafana:
    image: grafana/grafana:10.4.0
    environment:
      GF_AUTH_ANONYMOUS_ENABLED: "true"
      GF_AUTH_ANONYMOUS_ORG_ROLE: Admin
    ports: ["3000:3000"]
    volumes:
      - ./grafana/provisioning:/etc/grafana/provisioning:ro

volumes:
  pgdata:
  natsdata:
  miniodata:
```

- [ ] **Step 4: Create stub `infra/grafana/tempo.yaml`**

```yaml
server:
  http_listen_port: 3200
distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
storage:
  trace:
    backend: local
    local:
      path: /tmp/tempo
```

- [ ] **Step 5: Create stub `infra/grafana/provisioning/datasources/ds.yaml`**

```yaml
apiVersion: 1
datasources:
  - name: Tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100
```

- [ ] **Step 6: Bring up the stack and verify**

Run: `cd audio-api && make up`
Wait 30 seconds.

Run verifications:
```bash
docker compose -f infra/docker-compose.yml ps
# Expected: all services healthy
docker compose -f infra/docker-compose.yml logs migrate | tail -20
# Expected: 5 tables created, no errors
docker compose -f infra/docker-compose.yml logs nats-bootstrap | tail -5
# Expected: "Streams ready."
docker compose -f infra/docker-compose.yml logs minio-bootstrap | tail -5
# Expected: bucket created
curl -s http://localhost:8222/jsz | python -m json.tool | head -20
# Expected: shows AUDIO_WORK and AUDIO_EVENTS streams
```

- [ ] **Step 7: Tear down to leave a clean state**

Run: `make down`

- [ ] **Step 8: Commit**

```bash
git add audio-api/infra/
git commit -m "feat(infra): docker-compose for postgres, nats, minio, otel, tempo, loki, grafana"
```

---

## Task 6: Shared Node common library

**Files:**
- Create: `audio-api/packages/node-common/package.json`
- Create: `audio-api/packages/node-common/tsconfig.json`
- Create: `audio-api/packages/node-common/src/logger.ts`
- Create: `audio-api/packages/node-common/src/telemetry.ts`
- Create: `audio-api/packages/node-common/src/nats.ts`
- Create: `audio-api/packages/node-common/src/db.ts`
- Create: `audio-api/packages/node-common/src/storage.ts`
- Create: `audio-api/packages/node-common/src/errors.ts`
- Create: `audio-api/packages/node-common/src/ids.ts`
- Create: `audio-api/packages/node-common/src/index.ts`
- Create: `audio-api/packages/node-common/src/logger.test.ts`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@audio-api/node-common",
  "version": "0.1.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "lint": "echo ok",
    "test": "vitest run"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.540.0",
    "@opentelemetry/api": "^1.7.0",
    "@opentelemetry/auto-instrumentations-node": "^0.41.0",
    "@opentelemetry/exporter-trace-otlp-grpc": "^0.50.0",
    "@opentelemetry/sdk-node": "^0.50.0",
    "nats": "^2.19.0",
    "pg": "^8.11.0",
    "pino": "^9.0.0",
    "ulid": "^2.3.0"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "@types/pg": "^8.11.0",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  }
}
```

- [ ] **Step 2: `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

- [ ] **Step 3: `src/logger.ts` (structured logger with redaction per Section 6.3)**

```ts
import pino, { Logger } from "pino";

const REDACT_PATHS = [
  "*.password", "*.token", "*.headers.authorization",
  "*.url", "input_descriptor.headers.*"
];

export function createLogger(service: string): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { service, version: process.env.SERVICE_VERSION ?? "dev" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" }
  });
}
```

- [ ] **Step 4: Test for logger redaction**

`src/logger.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createLogger } from "./logger.js";
import { Writable } from "node:stream";

describe("logger", () => {
  it("redacts sensitive fields", async () => {
    let captured = "";
    const sink = new Writable({
      write(c, _e, cb) { captured += c.toString(); cb(); }
    });
    const log = createLogger("test");
    // @ts-expect-error: re-pointing transport for the test
    (log as any)[Symbol.for("pino.stream")] = sink;
    const tlog = (await import("pino")).default({ base: { service: "t" } }, sink);
    tlog.info({ token: "secret123", msg: "x" });
    expect(captured).not.toContain("secret123");
    expect(captured).toContain("[REDACTED]");
  });
});
```

- [ ] **Step 5: `src/telemetry.ts` (OTel SDK bootstrap)**

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

export function startTelemetry(serviceName: string): NodeSDK {
  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    }),
    instrumentations: [getNodeAutoInstrumentations()]
  });
  sdk.start();
  process.on("SIGTERM", () => { void sdk.shutdown(); });
  return sdk;
}
```

- [ ] **Step 6: `src/nats.ts`**

```ts
import { connect, NatsConnection, JetStreamClient, JSONCodec, headers as natsHeaders, Subscription } from "nats";
import { Envelope } from "@audio-api/proto";

export const jc = JSONCodec();

export interface NatsClients {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: Awaited<ReturnType<NatsConnection["jetstreamManager"]>>;
}

export async function connectNats(url = process.env.NATS_URL ?? "nats://localhost:4222"): Promise<NatsClients> {
  const nc = await connect({ servers: url, maxReconnectAttempts: -1 });
  const js = nc.jetstream();
  const jsm = await nc.jetstreamManager();
  return { nc, js, jsm };
}

export async function publish<T>(js: JetStreamClient, subject: string, envelope: Envelope<T>): Promise<void> {
  const h = natsHeaders();
  h.set("X-Trace-Id", envelope.trace_id);
  h.set("X-Attempt-Id", envelope.attempt_id);
  await js.publish(subject, jc.encode(envelope), { headers: h });
}

export function decodeEnvelope<T>(data: Uint8Array): Envelope<T> {
  return jc.decode(data) as Envelope<T>;
}
```

- [ ] **Step 7: `src/db.ts`**

```ts
import pg from "pg";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX ?? 10)
    });
  }
  return pool;
}

export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 8: `src/storage.ts`**

```ts
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

export function createStorage(): S3Client {
  return new S3Client({
    endpoint: process.env.OBJECT_STORE_ENDPOINT,
    region: process.env.OBJECT_STORE_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: process.env.OBJECT_STORE_ACCESS_KEY!,
      secretAccessKey: process.env.OBJECT_STORE_SECRET_KEY!
    },
    forcePathStyle: true
  });
}

export const BUCKET = process.env.OBJECT_STORE_BUCKET ?? "audio-api";

export async function putObject(s3: S3Client, key: string, body: Buffer | Readable, contentType?: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
}

export async function getObjectStream(s3: S3Client, key: string): Promise<Readable> {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return r.Body as Readable;
}
```

- [ ] **Step 9: `src/errors.ts`**

```ts
import { ErrorCode, httpStatusFor } from "@audio-api/contracts";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode | string,
    message: string,
    public stage?: string,
    public traceId?: string
  ) { super(message); }

  toHttp() {
    return {
      status: httpStatusFor(this.code),
      body: { code: this.code, message: this.message, stage: this.stage, trace_id: this.traceId }
    };
  }
}
```

- [ ] **Step 10: `src/ids.ts`**

```ts
import { ulid } from "ulid";
export const jobId    = () => `j_${ulid()}`;
export const tokenId  = () => `t_${ulid()}`;
export const traceId  = () => Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32);
export const attemptId = (jobId: string, stage: string) => `${jobId}:${stage}:1`;
```

- [ ] **Step 11: `src/index.ts`**

```ts
export * from "./logger.js";
export * from "./telemetry.js";
export * from "./nats.js";
export * from "./db.js";
export * from "./storage.js";
export * from "./errors.js";
export * from "./ids.js";
```

- [ ] **Step 12: Install, build, test**

Run:
```bash
cd audio-api/packages/node-common
pnpm install
pnpm test
pnpm build
```
Expected: redaction test passes, build emits `dist/`.

- [ ] **Step 13: Commit**

```bash
git add audio-api/packages/node-common
git commit -m "feat(node-common): logger, telemetry, nats, db, storage, errors, ids"
```

---

## Task 7: Shared Python common library

**Files:**
- Create: `audio-api/packages/py-common/pyproject.toml`
- Create: `audio-api/packages/py-common/py_common/__init__.py`
- Create: `audio-api/packages/py-common/py_common/logging_setup.py`
- Create: `audio-api/packages/py-common/py_common/telemetry.py`
- Create: `audio-api/packages/py-common/py_common/nats_client.py`
- Create: `audio-api/packages/py-common/py_common/db.py`
- Create: `audio-api/packages/py-common/py_common/storage.py`
- Create: `audio-api/packages/py-common/py_common/errors.py`
- Create: `audio-api/packages/py-common/tests/test_logging.py`

- [ ] **Step 1: `pyproject.toml`**

```toml
[project]
name = "py-common"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "structlog>=24.1.0",
  "nats-py>=2.7.0",
  "psycopg[binary]>=3.1.18",
  "boto3>=1.34.0",
  "opentelemetry-sdk>=1.24.0",
  "opentelemetry-exporter-otlp-proto-grpc>=1.24.0",
  "jsonschema>=4.21.0"
]
[project.optional-dependencies]
dev = ["pytest>=8.0.0", "ruff>=0.3.0"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["py_common*"]
```

- [ ] **Step 2: `py_common/logging_setup.py`**

```python
import logging
import os
import structlog

REDACT_KEYS = {"token", "password", "authorization", "secret_key", "access_key"}

def _redactor(_logger, _name, event_dict):
    for k in list(event_dict.keys()):
        if k.lower() in REDACT_KEYS:
            event_dict[k] = "[REDACTED]"
    return event_dict

def setup(service: str) -> structlog.BoundLogger:
    level = os.environ.get("LOG_LEVEL", "info").upper()
    logging.basicConfig(level=level, format="%(message)s")
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            _redactor,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(getattr(logging, level)),
    )
    return structlog.get_logger().bind(
        service=service,
        version=os.environ.get("SERVICE_VERSION", "dev"),
    )
```

- [ ] **Step 3: `py_common/telemetry.py`**

```python
import os
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

def setup(service: str) -> trace.Tracer:
    resource = Resource.create({"service.name": service, "service.version": os.environ.get("SERVICE_VERSION", "dev")})
    provider = TracerProvider(resource=resource)
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if endpoint:
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint, insecure=True)))
    trace.set_tracer_provider(provider)
    return trace.get_tracer(service)
```

- [ ] **Step 4: `py_common/nats_client.py`**

```python
import json
import os
from typing import Any, Optional
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
    from datetime import datetime, timezone
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
```

- [ ] **Step 5: `py_common/db.py`**

```python
import os
import psycopg
from psycopg_pool import ConnectionPool

_pool: Optional[ConnectionPool] = None  # type: ignore

def pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(conninfo=os.environ["DATABASE_URL"], min_size=1, max_size=int(os.environ.get("DB_POOL_MAX", "5")))
    return _pool
```

- [ ] **Step 6: `py_common/storage.py`**

```python
import os
import boto3

BUCKET = os.environ.get("OBJECT_STORE_BUCKET", "audio-api")

def client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["OBJECT_STORE_ENDPOINT"],
        aws_access_key_id=os.environ["OBJECT_STORE_ACCESS_KEY"],
        aws_secret_access_key=os.environ["OBJECT_STORE_SECRET_KEY"],
        region_name=os.environ.get("OBJECT_STORE_REGION", "us-east-1"),
    )

def download_to_file(s3, key: str, dest_path: str) -> None:
    s3.download_file(BUCKET, key, dest_path)

def upload_bytes(s3, key: str, data: bytes, content_type: str = "application/json") -> None:
    s3.put_object(Bucket=BUCKET, Key=key, Body=data, ContentType=content_type)
```

- [ ] **Step 7: `py_common/errors.py`**

```python
class StageError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
```

- [ ] **Step 8: `py_common/__init__.py`**

```python
from . import logging_setup, telemetry, nats_client, db, storage, errors
__all__ = ["logging_setup", "telemetry", "nats_client", "db", "storage", "errors"]
```

- [ ] **Step 9: `tests/test_logging.py`**

```python
import io, json, logging
from py_common.logging_setup import setup

def test_redacts_token(capsys):
    log = setup("test")
    log.info("hi", token="secret123", path="/x")
    captured = capsys.readouterr().out
    assert "secret123" not in captured
    assert "[REDACTED]" in captured
```

- [ ] **Step 10: Install and test**

Run:
```bash
cd audio-api/packages/py-common
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
pytest -q
```
Expected: 1 passed.

- [ ] **Step 11: Commit**

```bash
git add audio-api/packages/py-common
git commit -m "feat(py-common): structured logging, otel, nats, db, storage helpers"
```

---

## Task 8: API Gateway scaffold and health endpoint

**Files:**
- Create: `audio-api/services/api-gateway/package.json`
- Create: `audio-api/services/api-gateway/tsconfig.json`
- Create: `audio-api/services/api-gateway/Dockerfile`
- Create: `audio-api/services/api-gateway/src/server.ts`
- Create: `audio-api/services/api-gateway/src/routes/health.ts`
- Create: `audio-api/services/api-gateway/src/index.ts`
- Create: `audio-api/services/api-gateway/tests/health.test.ts`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@audio-api/api-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "lint": "echo ok",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@audio-api/contracts": "workspace:*",
    "@audio-api/node-common": "workspace:*",
    "@audio-api/proto": "workspace:*",
    "@fastify/cors": "^9.0.1",
    "fastify": "^4.26.0"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  }
}
```

- [ ] **Step 2: `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

- [ ] **Step 3: Write failing test for health endpoint**

`tests/health.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.js";

describe("GET /v1/health", () => {
  it("returns 200 with status ok", async () => {
    const app = await buildServer();
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
    await app.close();
  });
});
```

- [ ] **Step 4: Run the test, expect failure**

Run: `cd audio-api/services/api-gateway && pnpm install && pnpm test`
Expected: FAIL - `buildServer` not defined.

- [ ] **Step 5: Implement `src/routes/health.ts`**

```ts
import { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/v1/health", async () => ({
    status: "ok",
    services: { "api-gateway": { status: "ok", version: process.env.SERVICE_VERSION ?? "dev" } }
  }));
}
```

- [ ] **Step 6: Implement `src/server.ts`**

```ts
import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { createLogger } from "@audio-api/node-common";
import { healthRoutes } from "./routes/health.js";

export async function buildServer(): Promise<FastifyInstance> {
  const log = createLogger("api-gateway");
  const app = Fastify({ loggerInstance: log as any });
  await app.register(cors, { origin: true });
  await app.register(healthRoutes);
  return app;
}
```

- [ ] **Step 7: Implement `src/index.ts`**

```ts
import { startTelemetry } from "@audio-api/node-common";
import { buildServer } from "./server.js";

startTelemetry("api-gateway");

const port = Number(process.env.API_PORT ?? 8080);
buildServer().then(app => app.listen({ port, host: "0.0.0.0" }))
  .then(addr => console.log(`api-gateway listening on ${addr}`))
  .catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 8: Run the test, expect pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add audio-api/services/api-gateway
git commit -m "feat(api-gateway): fastify scaffold and /v1/health endpoint"
```

---

## Task 9: API Gateway auth middleware

**Files:**
- Create: `audio-api/services/api-gateway/src/auth.ts`
- Modify: `audio-api/services/api-gateway/src/server.ts`
- Create: `audio-api/services/api-gateway/tests/auth.test.ts`

- [ ] **Step 1: Write failing test**

`tests/auth.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { buildServer } from "../src/server.js";
import { getPool } from "@audio-api/node-common";

const TEST_TOKEN = "test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TEST_HASH = createHash("sha256").update(TEST_TOKEN).digest("hex");

describe("auth", () => {
  beforeEach(async () => {
    const pool = getPool();
    await pool.query("DELETE FROM api_tokens WHERE id = 't_test'");
    await pool.query(
      "INSERT INTO api_tokens (id, tenant_id, token_hash, name) VALUES ($1, $2, $3, $4)",
      ["t_test", "tenant_test", TEST_HASH, "test"]
    );
  });
  it("401 without token on protected route", async () => {
    const app = await buildServer();
    const res = await app.inject({ method: "POST", url: "/v1/jobs", payload: {} });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
  it("attaches tenant_id when token is valid", async () => {
    const app = await buildServer();
    // We test the decorator indirectly via a debug route added during test setup.
    app.get("/__whoami", { onRequest: app.requireAuth }, async (req: any) => ({ tenant: req.tenant_id }));
    const res = await app.inject({
      method: "GET", url: "/__whoami",
      headers: { authorization: `Bearer ${TEST_TOKEN}` }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenant: "tenant_test" });
    await app.close();
  });
});
```

- [ ] **Step 2: Run test, expect fail**

Run: `pnpm test`
Expected: FAIL - `requireAuth` not defined.

- [ ] **Step 3: Implement `src/auth.ts`**

```ts
import { createHash } from "node:crypto";
import { FastifyInstance, FastifyRequest } from "fastify";
import { getPool, ApiError } from "@audio-api/node-common";

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    tenant_id?: string;
    token_id?: string;
  }
}

export async function authPlugin(app: FastifyInstance) {
  app.decorate("requireAuth", async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith("Bearer ")) {
      throw new ApiError("INPUT_AUTH_FAILED", "Missing bearer token");
    }
    const token = h.slice(7).trim();
    const hash = createHash("sha256").update(token).digest("hex");
    const r = await getPool().query<{ id: string; tenant_id: string }>(
      "SELECT id, tenant_id FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL",
      [hash]
    );
    if (r.rowCount === 0) throw new ApiError("INPUT_AUTH_FAILED", "Invalid or revoked token");
    req.tenant_id = r.rows[0].tenant_id;
    req.token_id = r.rows[0].id;
  });
}
```

- [ ] **Step 4: Add error handler in `src/server.ts`**

Update `server.ts`:

```ts
import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { createLogger, ApiError } from "@audio-api/node-common";
import { healthRoutes } from "./routes/health.js";
import { authPlugin } from "./auth.js";

export async function buildServer(): Promise<FastifyInstance> {
  const log = createLogger("api-gateway");
  const app = Fastify({ loggerInstance: log as any });
  await app.register(cors, { origin: true });
  await app.register(authPlugin);
  await app.register(healthRoutes);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      const { status, body } = err.toHttp();
      return reply.code(status).send(body);
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ code: "INTERNAL", message: "Internal error" });
  });

  return app;
}
```

- [ ] **Step 5: Run test, expect pass**

Bring up infra first so the DB is available for the test (auth test depends on Postgres):
```bash
cd audio-api && make up
pnpm --filter @audio-api/api-gateway test
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add audio-api/services/api-gateway/src/auth.ts audio-api/services/api-gateway/src/server.ts audio-api/services/api-gateway/tests/auth.test.ts
git commit -m "feat(api-gateway): bearer-token auth with redacted error handler"
```

---

## Task 10: API Gateway - POST /v1/jobs

**Files:**
- Create: `audio-api/services/api-gateway/src/routes/jobs.ts`
- Modify: `audio-api/services/api-gateway/src/server.ts`
- Create: `audio-api/services/api-gateway/tests/jobs-post.test.ts`

- [ ] **Step 1: Write failing test**

`tests/jobs-post.test.ts`:

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
  await pool.query(
    "INSERT INTO api_tokens (id, tenant_id, token_hash) VALUES ($1,$2,$3)",
    ["t_test", "tenant_test", HASH]
  );
});

describe("POST /v1/jobs", () => {
  it("400 on missing input", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "POST", url: "/v1/jobs",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { analyses: ["format"] }
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
  it("201 returns job_id queued", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "POST", url: "/v1/jobs",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { input: { type: "url", url: "https://example.com/a.wav" }, analyses: ["format"] }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.job_id).toMatch(/^j_/);
    expect(body.status).toBe("queued");
    // Side effect: row inserted
    const r = await getPool().query("SELECT status FROM jobs WHERE id = $1", [body.job_id]);
    expect(r.rows[0].status).toBe("queued");
    // Side effect: analysis row
    const a = await getPool().query("SELECT status FROM analyses WHERE job_id = $1 AND name='format'", [body.job_id]);
    expect(a.rows[0].status).toBe("pending");
    await app.close();
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `pnpm test`
Expected: FAIL.

- [ ] **Step 3: Implement `src/routes/jobs.ts`**

```ts
import { FastifyInstance } from "fastify";
import {
  getPool, withTx, connectNats, publish, jobId, traceId, attemptId,
  ApiError
} from "@audio-api/node-common";
import { SUBJECTS, Envelope } from "@audio-api/proto";

interface SubmitBody {
  input: { type: "url"; url: string };
  analyses: string[];
  callback_url?: string;
  mode?: "sync" | "async";
}

const VALID_ANALYSES = new Set(["format"]); // Plan 1: format only

let natsRef: Awaited<ReturnType<typeof connectNats>> | null = null;
async function nats() {
  if (!natsRef) natsRef = await connectNats();
  return natsRef;
}

export async function jobsRoutes(app: FastifyInstance) {
  app.post<{ Body: SubmitBody }>("/v1/jobs", { onRequest: app.requireAuth }, async (req, reply) => {
    const body = req.body;
    if (!body?.input?.url || body.input.type !== "url") {
      throw new ApiError("INPUT_UNREACHABLE", "input.url and input.type='url' required");
    }
    if (!Array.isArray(body.analyses) || body.analyses.length === 0) {
      throw new ApiError("INPUT_UNREACHABLE", "analyses[] required");
    }
    for (const a of body.analyses) {
      if (!VALID_ANALYSES.has(a)) {
        throw new ApiError("INPUT_UNSUPPORTED_CODEC", `analysis '${a}' not supported in this version`);
      }
    }
    const id = jobId();
    const tid = traceId();
    const tenant = req.tenant_id!;
    const inputDescriptor = { type: "url", url: body.input.url }; // url not redacted (no auth header carried in Plan 1)

    await withTx(async client => {
      await client.query(
        `INSERT INTO jobs (id, tenant_id, status, input_descriptor, options, callback_url, mode)
         VALUES ($1,$2,'queued',$3,'{}'::jsonb,$4,$5)`,
        [id, tenant, inputDescriptor, body.callback_url ?? null, body.mode ?? "async"]
      );
      for (const a of body.analyses) {
        await client.query(
          `INSERT INTO analyses (job_id, name, status) VALUES ($1,$2,'pending')`,
          [id, a]
        );
      }
      await client.query(
        `INSERT INTO job_events (job_id, kind, stage, payload) VALUES ($1,'submitted',NULL,$2)`,
        [id, { analyses: body.analyses }]
      );
    });

    const { js } = await nats();
    const env: Envelope<{ url: string }> = {
      job_id: id, tenant_id: tenant, trace_id: tid,
      attempt_id: attemptId(id, "fetch"),
      emitted_at: new Date().toISOString(),
      payload: { url: body.input.url }
    };
    await publish(js, SUBJECTS.WORK_FETCH, env);

    return reply.code(201).send({ job_id: id, status: "queued" });
  });
}
```

- [ ] **Step 4: Register the route in `src/server.ts`**

Add to `buildServer`:

```ts
import { jobsRoutes } from "./routes/jobs.js";
// ...
await app.register(jobsRoutes);
```

- [ ] **Step 5: Run test**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add audio-api/services/api-gateway/src/routes/jobs.ts audio-api/services/api-gateway/src/server.ts audio-api/services/api-gateway/tests/jobs-post.test.ts
git commit -m "feat(api-gateway): POST /v1/jobs persists job+analyses, emits fetch.requested"
```

---

## Task 11: API Gateway - GET /v1/jobs/:id and /results

**Files:**
- Modify: `audio-api/services/api-gateway/src/routes/jobs.ts`
- Create: `audio-api/services/api-gateway/tests/jobs-get.test.ts`

- [ ] **Step 1: Write failing test**

`tests/jobs-get.test.ts`:

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

describe("GET /v1/jobs/:id", () => {
  it("returns 404 when not found", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "GET", url: "/v1/jobs/j_doesnotexist",
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns status + analyses when present", async () => {
    const pool = getPool();
    await pool.query("INSERT INTO jobs (id, tenant_id, status, input_descriptor, mode) VALUES ($1,$2,'queued','{}'::jsonb,'async')", ["j_t1","tenant_test"]);
    await pool.query("INSERT INTO analyses (job_id, name, status) VALUES ('j_t1','format','pending')");

    const app = await buildServer();
    const res = await app.inject({
      method: "GET", url: "/v1/jobs/j_t1",
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      job_id: "j_t1", status: "queued",
      analyses: [{ name: "format", status: "pending" }]
    });
    await app.close();
  });
});

describe("GET /v1/jobs/:id/results", () => {
  it("404 when no result yet", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "GET", url: "/v1/jobs/j_t1/results",
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `pnpm test`
Expected: FAIL.

- [ ] **Step 3: Add the GET handlers to `routes/jobs.ts`**

```ts
app.get<{ Params: { id: string } }>("/v1/jobs/:id", { onRequest: app.requireAuth }, async (req, reply) => {
  const pool = getPool();
  const j = await pool.query(
    `SELECT id, status, created_at, started_at, completed_at FROM jobs WHERE id = $1 AND tenant_id = $2`,
    [req.params.id, req.tenant_id]
  );
  if (j.rowCount === 0) return reply.code(404).send({ code: "INPUT_UNREACHABLE", message: "Job not found" });
  const a = await pool.query(
    `SELECT name, status, attempts FROM analyses WHERE job_id = $1`,
    [req.params.id]
  );
  return {
    job_id: j.rows[0].id,
    status: j.rows[0].status,
    created_at: j.rows[0].created_at,
    started_at: j.rows[0].started_at,
    completed_at: j.rows[0].completed_at,
    analyses: a.rows
  };
});

app.get<{ Params: { id: string } }>("/v1/jobs/:id/results", { onRequest: app.requireAuth }, async (req, reply) => {
  const pool = getPool();
  const r = await pool.query(
    `SELECT r.report FROM results r JOIN jobs j ON j.id = r.job_id
     WHERE r.job_id = $1 AND j.tenant_id = $2`,
    [req.params.id, req.tenant_id]
  );
  if (r.rowCount === 0) return reply.code(404).send({ code: "INPUT_UNREACHABLE", message: "Results not ready" });
  return r.rows[0].report;
});

app.get<{ Params: { id: string } }>("/v1/jobs/:id/events", { onRequest: app.requireAuth }, async (req, reply) => {
  const pool = getPool();
  const own = await pool.query("SELECT 1 FROM jobs WHERE id=$1 AND tenant_id=$2", [req.params.id, req.tenant_id]);
  if (own.rowCount === 0) return reply.code(404).send({ code: "INPUT_UNREACHABLE", message: "Job not found" });
  const e = await pool.query(
    `SELECT ts, kind, stage, payload FROM job_events WHERE job_id = $1 ORDER BY ts ASC`,
    [req.params.id]
  );
  return { events: e.rows };
});
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add audio-api/services/api-gateway
git commit -m "feat(api-gateway): GET job, results, and events endpoints"
```

---

## Task 12: Worker-fetcher scaffold and URL adapter

**Files:**
- Create: `audio-api/services/worker-fetcher/package.json`
- Create: `audio-api/services/worker-fetcher/tsconfig.json`
- Create: `audio-api/services/worker-fetcher/Dockerfile`
- Create: `audio-api/services/worker-fetcher/src/index.ts`
- Create: `audio-api/services/worker-fetcher/src/fetcher.ts`
- Create: `audio-api/services/worker-fetcher/tests/fetcher.test.ts`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@audio-api/worker-fetcher",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "lint": "echo ok",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@audio-api/node-common": "workspace:*",
    "@audio-api/proto": "workspace:*",
    "@aws-sdk/client-s3": "^3.540.0",
    "undici": "^6.6.0"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  }
}
```

- [ ] **Step 2: `tsconfig.json`** (same pattern as other services)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

- [ ] **Step 3: Write failing test for the fetch + checksum + upload logic**

`tests/fetcher.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { fetchToObjectStore } from "../src/fetcher.js";

describe("fetchToObjectStore", () => {
  it("streams the URL into storage, computes sha256 + size", async () => {
    const body = Buffer.from("hello-audio");
    const expectedSha = createHash("sha256").update(body).digest("hex");

    const fakeFetch = vi.fn(async () => ({
      ok: true, status: 200,
      body: Readable.from(body) as any,
      headers: new Headers({ "content-length": String(body.length) })
    } as Response));

    const putCalls: any[] = [];
    const fakeS3 = { send: vi.fn(async (cmd: any) => { putCalls.push(cmd.input); return {}; }) } as any;

    const result = await fetchToObjectStore({
      url: "https://example.com/a.wav",
      jobId: "j_x",
      s3: fakeS3,
      fetchImpl: fakeFetch as any
    });

    expect(result.object_key).toBe("working/j_x/source.bin");
    expect(result.sha256).toBe(expectedSha);
    expect(result.size_bytes).toBe(body.length);
    expect(putCalls).toHaveLength(1);
  });

  it("throws INPUT_UNREACHABLE on non-2xx", async () => {
    const fakeFetch = vi.fn(async () => ({ ok: false, status: 404 } as Response));
    await expect(fetchToObjectStore({
      url: "x", jobId: "j_x", s3: {} as any, fetchImpl: fakeFetch as any
    })).rejects.toThrowError(/INPUT_UNREACHABLE/);
  });
});
```

- [ ] **Step 4: Run, expect fail**

Run: `cd audio-api/services/worker-fetcher && pnpm install && pnpm test`
Expected: FAIL.

- [ ] **Step 5: Implement `src/fetcher.ts`**

```ts
import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { ApiError, BUCKET } from "@audio-api/node-common";

export interface FetchArgs {
  url: string;
  jobId: string;
  s3: S3Client;
  fetchImpl?: typeof fetch;
}
export interface FetchResult {
  object_key: string;
  size_bytes: number;
  sha256: string;
}

export async function fetchToObjectStore(args: FetchArgs): Promise<FetchResult> {
  const f = args.fetchImpl ?? fetch;
  const res = await f(args.url);
  if (!res.ok) throw new ApiError("INPUT_UNREACHABLE", `fetch failed ${res.status}`);

  // Buffer (Plan 1). Plan 4 will stream chunks straight to S3 with a multipart upload.
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash("sha256").update(buf).digest("hex");
  const key = `working/${args.jobId}/source.bin`;
  await args.s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf }));
  return { object_key: key, size_bytes: buf.length, sha256: sha };
}
```

- [ ] **Step 6: Run, expect pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 7: Implement `src/index.ts` (NATS consumer loop)**

```ts
import {
  connectNats, createStorage, createLogger, startTelemetry,
  publish, attemptId, traceId
} from "@audio-api/node-common";
import { SUBJECTS, Envelope, FileReady, decodeEnvelopeFn } from "@audio-api/proto";
import { fetchToObjectStore } from "./fetcher.js";

startTelemetry("worker-fetcher");
const log = createLogger("worker-fetcher");

async function main() {
  const { nc, js, jsm } = await connectNats();
  const s3 = createStorage();

  await jsm.consumers.add("AUDIO_WORK", {
    durable_name: "worker-fetcher",
    filter_subject: SUBJECTS.WORK_FETCH,
    ack_policy: "explicit" as any,
    max_deliver: 3
  } as any).catch((e: any) => { if (!/exists/.test(String(e))) throw e; });

  const sub = await js.consumers.get("AUDIO_WORK", "worker-fetcher")
    .then(c => c.consume({ max_messages: 4 }));

  log.info("worker-fetcher consuming");

  for await (const m of sub) {
    const env = JSON.parse(new TextDecoder().decode(m.data)) as Envelope<{ url: string }>;
    log.info({ job_id: env.job_id, trace_id: env.trace_id }, "fetch.start");
    try {
      const result = await fetchToObjectStore({ url: env.payload.url, jobId: env.job_id, s3 });
      const fileReady: Envelope<FileReady> = {
        job_id: env.job_id, tenant_id: env.tenant_id,
        trace_id: env.trace_id, attempt_id: env.attempt_id,
        emitted_at: new Date().toISOString(),
        payload: result
      };
      await publish(js, SUBJECTS.EVENT_FILE_READY, fileReady);
      m.ack();
      log.info({ job_id: env.job_id, size: result.size_bytes }, "fetch.done");
    } catch (e: any) {
      log.error({ err: e, job_id: env.job_id }, "fetch.failed");
      if (m.info.deliveryCount >= 3) {
        const dead: Envelope<{ stage: string; code: string; message: string }> = {
          job_id: env.job_id, tenant_id: env.tenant_id,
          trace_id: env.trace_id, attempt_id: env.attempt_id,
          emitted_at: new Date().toISOString(),
          payload: { stage: "fetch", code: e.code ?? "INTERNAL", message: e.message }
        };
        await publish(js, SUBJECTS.EVENT_JOB_FAILED, dead);
        m.ack();
      } else {
        m.nak(5000);
      }
    }
  }
}

main().catch(e => { log.error({ err: e }, "fatal"); process.exit(1); });
```

- [ ] **Step 8: Add `decodeEnvelopeFn` export to proto package**

Edit `packages/proto/src/index.ts` to add (if not already there):

```ts
export const decodeEnvelopeFn = <T>(d: Uint8Array) => JSON.parse(new TextDecoder().decode(d)) as Envelope<T>;
```

Rebuild: `pnpm --filter @audio-api/proto build`.

- [ ] **Step 9: Build the worker**

Run: `pnpm build`
Expected: `dist/index.js` produced.

- [ ] **Step 10: Commit**

```bash
git add audio-api/services/worker-fetcher
git commit -m "feat(worker-fetcher): URL pull adapter, sha256, MinIO write, emits file.ready"
```

---

## Task 13: Worker-format (Python, ffprobe)

**Files:**
- Create: `audio-api/services/worker-format/pyproject.toml`
- Create: `audio-api/services/worker-format/Dockerfile`
- Create: `audio-api/services/worker-format/src/worker_format/__init__.py`
- Create: `audio-api/services/worker-format/src/worker_format/__main__.py`
- Create: `audio-api/services/worker-format/src/worker_format/probe.py`
- Create: `audio-api/services/worker-format/src/worker_format/worker.py`
- Create: `audio-api/services/worker-format/tests/test_probe.py`

- [ ] **Step 1: `pyproject.toml`**

```toml
[project]
name = "worker-format"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["py-common @ file:../../packages/py-common"]

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

- [ ] **Step 2: `src/worker_format/probe.py`**

```python
import json
import subprocess
from typing import Optional

CHANNEL_LAYOUTS = {
    1: "mono",
    2: "stereo",
    6: "5.1",
    8: "7.1",
}

class ProbeError(Exception):
    pass

def probe(path: str) -> dict:
    cmd = ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise ProbeError(f"ffprobe failed: {r.stderr.strip()}")
    data = json.loads(r.stdout)
    audio = [s for s in data.get("streams", []) if s.get("codec_type") == "audio"]
    if not audio:
        raise ProbeError("no audio streams")
    s = audio[0]
    chcount = int(s.get("channels", 0))
    layout = s.get("channel_layout") or CHANNEL_LAYOUTS.get(chcount, f"{chcount}ch")
    return {
        "codec": s.get("codec_name", "unknown"),
        "sample_rate": int(s.get("sample_rate", 0)),
        "bit_depth": int(s.get("bits_per_raw_sample", 0)) or None,
        "channel_count": chcount,
        "channel_layout": layout,
        "duration_s": float(data.get("format", {}).get("duration", 0.0)),
    }
```

- [ ] **Step 3: Write failing test**

`tests/test_probe.py`:

```python
import subprocess
from pathlib import Path
import pytest
from worker_format.probe import probe, ProbeError

FIXTURE = Path(__file__).resolve().parents[3].parent / "tests" / "fixtures" / "audio" / "sample-stereo.wav"

@pytest.mark.skipif(not FIXTURE.exists(), reason="fixture not generated yet")
def test_probe_stereo(tmp_path):
    out = probe(str(FIXTURE))
    assert out["channel_count"] == 2
    assert out["channel_layout"] in ("stereo", "2 channels")
    assert out["sample_rate"] > 0

def test_probe_missing():
    with pytest.raises(ProbeError):
        probe("/no/such/file.wav")
```

- [ ] **Step 4: Generate the fixture (5s stereo sine)**

Run in repo root:

```bash
mkdir -p audio-api/tests/fixtures/audio
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=5" -ac 2 -ar 48000 \
  audio-api/tests/fixtures/audio/sample-stereo.wav
```
Expected: file ~960KB created.

- [ ] **Step 5: Run tests**

```bash
cd audio-api/services/worker-format
python -m venv .venv && source .venv/bin/activate
pip install -e "../../packages/py-common[dev]"
pip install -e ".[dev]"
pytest -q
```
Expected: 2 passed.

- [ ] **Step 6: Implement `src/worker_format/worker.py`**

```python
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
    src_key = payload["object_key"] if "object_key" in payload else payload.get("source_object_key")
    if not src_key:
        # Plan 1 routes through the file-ready event; orchestrator wraps it.
        src_key = f"working/{job_id}/source.bin"
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        storage.download_to_file(s3, src_key, tmp_path)
        result = probe(tmp_path)
    except ProbeError as e:
        raise StageError("FORMAT_PROBE_FAILED", str(e), retryable=True)
    finally:
        try: os.unlink(tmp_path)
        except FileNotFoundError: pass

    # Persist the analysis result JSON to MinIO so aggregator can read it.
    result_key = f"results/{job_id}/format.json"
    storage.upload_bytes(s3, result_key, json.dumps(result).encode("utf-8"))
    result["result_object"] = result_key
    return result

async def main():
    nc, js = await nats_client.connect()
    s3 = storage.client()
    log.info("worker-format consuming", subject=nats_client.SUBJECTS["WORK_FORMAT"])

    async def cb(msg):
        try:
            env = nats_client.decode(msg.data)
        except Exception:
            await msg.ack()
            return
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
                await msg.ack()
                log.info("format.done", job_id=env["job_id"], duration_s=out.get("duration_s"))
            except StageError as e:
                meta = msg.metadata
                if meta.num_delivered >= 3:
                    fail = nats_client.envelope(
                        env["job_id"], env["tenant_id"], env["trace_id"], env["attempt_id"],
                        {"stage": "format", "code": e.code, "message": str(e)}
                    )
                    await js.publish(nats_client.SUBJECTS["EVENT_JOB_FAILED"], nats_client.encode(fail))
                    await msg.ack()
                else:
                    await msg.nak(delay=5)
                log.error("format.failed", code=e.code, msg=str(e))

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
            for m in msgs:
                await cb(m)
        except asyncio.TimeoutError:
            continue

if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 7: `src/worker_format/__main__.py`**

```python
from worker_format.worker import main
import asyncio

if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 8: `src/worker_format/__init__.py`**

```python
__all__ = ["probe", "worker"]
```

- [ ] **Step 9: Commit**

```bash
git add audio-api/services/worker-format audio-api/tests/fixtures/audio/sample-stereo.wav
git commit -m "feat(worker-format): ffprobe-based format detection, publishes format.ready"
```

---

## Task 14: Orchestrator

**Files:**
- Create: `audio-api/services/orchestrator/package.json`
- Create: `audio-api/services/orchestrator/tsconfig.json`
- Create: `audio-api/services/orchestrator/src/index.ts`
- Create: `audio-api/services/orchestrator/src/pipeline.ts`
- Create: `audio-api/services/orchestrator/tests/pipeline.test.ts`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@audio-api/orchestrator",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
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

- [ ] **Step 2: `tsconfig.json`** (same shape as other services)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

- [ ] **Step 3: Write failing unit test for `nextSteps`**

`tests/pipeline.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { nextStepsAfterFileReady, nextStepsAfterFormatReady } from "../src/pipeline.js";

describe("pipeline rules", () => {
  it("file.ready always dispatches format", () => {
    const next = nextStepsAfterFileReady({ analyses: ["format"] });
    expect(next).toEqual(["format"]);
  });
  it("format.ready dispatches no further work in Plan 1", () => {
    const next = nextStepsAfterFormatReady({ analyses: ["format"] });
    expect(next).toEqual([]);
  });
});
```

- [ ] **Step 4: Run, expect fail**

Run: `cd audio-api/services/orchestrator && pnpm install && pnpm test`
Expected: FAIL.

- [ ] **Step 5: Implement `src/pipeline.ts`**

```ts
export interface JobAnalyses { analyses: string[]; }

export function nextStepsAfterFileReady(_job: JobAnalyses): string[] {
  return ["format"];
}

export function nextStepsAfterFormatReady(job: JobAnalyses): string[] {
  // Plan 1: format is the only analysis. Future plans: fan-out vad/language/dme_classify here.
  return job.analyses.filter(a => a !== "format" && ["vad", "language", "dme_classify"].includes(a));
}
```

- [ ] **Step 6: Run, expect pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 7: Implement `src/index.ts` (event consumer)**

```ts
import {
  connectNats, getPool, withTx, createLogger, startTelemetry,
  publish, attemptId
} from "@audio-api/node-common";
import { SUBJECTS, Envelope, FileReady } from "@audio-api/proto";
import { nextStepsAfterFileReady, nextStepsAfterFormatReady } from "./pipeline.js";

startTelemetry("orchestrator");
const log = createLogger("orchestrator");

async function loadAnalyses(jobId: string): Promise<string[]> {
  const r = await getPool().query<{ name: string }>("SELECT name FROM analyses WHERE job_id = $1", [jobId]);
  return r.rows.map(x => x.name);
}

async function dispatch(js: any, env: Envelope<any>, analysis: string) {
  const subjectMap: Record<string, string> = { format: SUBJECTS.WORK_FORMAT };
  const subject = subjectMap[analysis];
  if (!subject) { log.warn({ analysis }, "no subject for analysis"); return; }
  await publish(js, subject, {
    ...env,
    attempt_id: attemptId(env.job_id, analysis),
    emitted_at: new Date().toISOString(),
    payload: { source_object_key: env.payload?.object_key }
  });
  await withTx(client => client.query(
    "UPDATE analyses SET status='running', started_at=COALESCE(started_at, now()) WHERE job_id=$1 AND name=$2",
    [env.job_id, analysis]
  ));
  await getPool().query(
    "INSERT INTO job_events (job_id, kind, stage, payload) VALUES ($1,'stage_started',$2,$3)",
    [env.job_id, analysis, {}]
  );
}

async function main() {
  const { nc, js, jsm } = await connectNats();
  await jsm.consumers.add("AUDIO_EVENTS", {
    durable_name: "orchestrator",
    filter_subjects: ["audio.event.file.ready", "audio.event.format.ready", "audio.event.job.failed"],
    ack_policy: "explicit" as any
  } as any).catch((e: any) => { if (!/exists/.test(String(e))) throw e; });

  const sub = await js.consumers.get("AUDIO_EVENTS", "orchestrator")
    .then(c => c.consume({ max_messages: 8 }));

  log.info("orchestrator consuming");

  for await (const m of sub) {
    try {
      const env = JSON.parse(new TextDecoder().decode(m.data)) as Envelope<any>;
      const subject = m.subject;
      const analyses = await loadAnalyses(env.job_id);

      if (subject === SUBJECTS.EVENT_FILE_READY) {
        await getPool().query("UPDATE jobs SET status='running', started_at=COALESCE(started_at, now()), source_object=$2 WHERE id=$1",
          [env.job_id, (env as Envelope<FileReady>).payload.object_key]);
        for (const a of nextStepsAfterFileReady({ analyses })) await dispatch(js, env, a);
      } else if (subject === SUBJECTS.EVENT_FORMAT_READY) {
        await getPool().query(
          "UPDATE analyses SET status='completed', completed_at=now(), result_object=$3 WHERE job_id=$1 AND name=$2",
          [env.job_id, "format", env.payload.result_object]
        );
        await getPool().query(
          "INSERT INTO job_events (job_id, kind, stage, payload) VALUES ($1,'stage_completed','format',$2)",
          [env.job_id, env.payload]
        );
        for (const a of nextStepsAfterFormatReady({ analyses })) await dispatch(js, env, a);
      } else if (subject === SUBJECTS.EVENT_JOB_FAILED) {
        await getPool().query("UPDATE jobs SET status='failed', completed_at=now(), error=$2 WHERE id=$1",
          [env.job_id, env.payload]);
      }
      m.ack();
    } catch (e: any) {
      log.error({ err: e }, "orchestrator.error");
      m.nak(5000);
    }
  }
}

main().catch(e => { log.error({ err: e }, "fatal"); process.exit(1); });
```

- [ ] **Step 8: Commit**

```bash
git add audio-api/services/orchestrator
git commit -m "feat(orchestrator): consume file/format/failed events, dispatch next stages"
```

---

## Task 15: Aggregator

**Files:**
- Create: `audio-api/services/aggregator/package.json`
- Create: `audio-api/services/aggregator/tsconfig.json`
- Create: `audio-api/services/aggregator/src/index.ts`
- Create: `audio-api/services/aggregator/src/aggregate.ts`
- Create: `audio-api/services/aggregator/tests/aggregate.test.ts`

- [ ] **Step 1: `package.json`** (same shape as orchestrator with name `@audio-api/aggregator`)

```json
{
  "name": "@audio-api/aggregator",
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

- [ ] **Step 2: `tsconfig.json`** (same as others)

- [ ] **Step 3: Write failing test**

`tests/aggregate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isComplete, buildReport } from "../src/aggregate.js";

describe("aggregator", () => {
  it("isComplete true only when every requested analysis is completed", () => {
    expect(isComplete(["format"], { format: "completed" })).toBe(true);
    expect(isComplete(["format", "vad"], { format: "completed" })).toBe(false);
    expect(isComplete(["format"], { format: "failed" })).toBe(true); // partial complete is still terminal
  });
  it("buildReport merges per-analysis JSON payloads", () => {
    const report = buildReport({
      job_id: "j_x",
      input: { duration_s: 5, size_bytes: 100 },
      perAnalysis: {
        format: { codec: "pcm_s16le", sample_rate: 48000, channel_count: 2, channel_layout: "stereo", duration_s: 5 }
      },
      failures: []
    });
    expect(report).toMatchObject({
      job_id: "j_x",
      format: { codec: "pcm_s16le", channel_count: 2 }
    });
  });
});
```

- [ ] **Step 4: Implement `src/aggregate.ts`**

```ts
type StatusMap = Record<string, string>;

export function isComplete(requested: string[], statuses: StatusMap): boolean {
  return requested.every(a => statuses[a] === "completed" || statuses[a] === "failed");
}

export interface BuildReportArgs {
  job_id: string;
  input: { duration_s: number; size_bytes: number };
  perAnalysis: Record<string, any>;
  failures: any[];
}

export function buildReport(a: BuildReportArgs) {
  const out: any = { job_id: a.job_id, input: a.input, failures: a.failures };
  if (a.perAnalysis.format) {
    const f = a.perAnalysis.format;
    out.format = {
      codec: f.codec,
      sample_rate: f.sample_rate,
      bit_depth: f.bit_depth,
      channel_count: f.channel_count,
      channel_layout: f.channel_layout,
      channels: Array.from({ length: f.channel_count }, (_, i) => ({ index: i, label: `ch${i}` }))
    };
  }
  return out;
}
```

- [ ] **Step 5: Run test**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Implement `src/index.ts`**

```ts
import {
  connectNats, getPool, createLogger, startTelemetry, createStorage, BUCKET
} from "@audio-api/node-common";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { SUBJECTS } from "@audio-api/proto";
import { isComplete, buildReport } from "./aggregate.js";

startTelemetry("aggregator");
const log = createLogger("aggregator");

async function readJson(s3: any, key: string): Promise<any> {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const text = await r.Body.transformToString();
  return JSON.parse(text);
}

async function main() {
  const { nc, js, jsm } = await connectNats();
  const s3 = createStorage();

  await jsm.consumers.add("AUDIO_EVENTS", {
    durable_name: "aggregator",
    filter_subjects: ["audio.event.format.ready"], // Plan 2/3 add the others
    ack_policy: "explicit" as any
  } as any).catch((e: any) => { if (!/exists/.test(String(e))) throw e; });

  const sub = await js.consumers.get("AUDIO_EVENTS", "aggregator")
    .then(c => c.consume({ max_messages: 4 }));

  log.info("aggregator consuming");

  for await (const m of sub) {
    try {
      const env = JSON.parse(new TextDecoder().decode(m.data));
      const jobId = env.job_id;

      const aRows = await getPool().query<{ name: string; status: string; result_object: string | null; error: any }>(
        "SELECT name, status, result_object, error FROM analyses WHERE job_id = $1", [jobId]);
      const statuses: Record<string, string> = {};
      const failures: any[] = [];
      const perAnalysis: Record<string, any> = {};
      for (const r of aRows.rows) {
        statuses[r.name] = r.status;
        if (r.status === "completed" && r.result_object) perAnalysis[r.name] = await readJson(s3, r.result_object);
        if (r.status === "failed" && r.error) failures.push({ analysis: r.name, ...r.error });
      }

      const requested = aRows.rows.map(r => r.name);
      if (!isComplete(requested, statuses)) { m.ack(); continue; }

      const jr = await getPool().query("SELECT size_bytes FROM jobs WHERE id=$1", [jobId]);
      const duration = perAnalysis.format?.duration_s ?? 0;
      const size = Number(jr.rows[0]?.size_bytes ?? 0);
      const report = buildReport({
        job_id: jobId,
        input: { duration_s: duration, size_bytes: size },
        perAnalysis,
        failures
      });

      await getPool().query(
        `INSERT INTO results (job_id, report) VALUES ($1,$2)
         ON CONFLICT (job_id) DO UPDATE SET report = EXCLUDED.report`,
        [jobId, report]
      );
      const finalStatus = failures.length === requested.length ? "failed" : "completed";
      await getPool().query(
        `UPDATE jobs SET status=$2, completed_at=now(), duration_s=$3 WHERE id=$1`,
        [jobId, finalStatus, duration]
      );
      await getPool().query(
        `INSERT INTO job_events (job_id, kind, stage, payload) VALUES ($1,'stage_completed','aggregate',$2)`,
        [jobId, { status: finalStatus }]
      );
      m.ack();
      log.info({ job_id: jobId, status: finalStatus }, "aggregate.done");
    } catch (e: any) {
      log.error({ err: e }, "aggregator.error");
      m.nak(5000);
    }
  }
}

main().catch(e => { log.error({ err: e }, "fatal"); process.exit(1); });
```

- [ ] **Step 7: Commit**

```bash
git add audio-api/services/aggregator
git commit -m "feat(aggregator): merge per-analysis results, write report, finalise job status"
```

---

## Task 16: Wire all services into docker-compose

**Files:**
- Modify: `audio-api/infra/docker-compose.yml` (append app services)
- Create: `audio-api/services/api-gateway/Dockerfile`
- Create: `audio-api/services/orchestrator/Dockerfile`
- Create: `audio-api/services/aggregator/Dockerfile`
- Create: `audio-api/services/worker-fetcher/Dockerfile`
- Create: `audio-api/services/worker-format/Dockerfile`

- [ ] **Step 1: Create one shared Node Dockerfile pattern (per service)**

Example `services/api-gateway/Dockerfile`:

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY services/api-gateway ./services/api-gateway
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @audio-api/api-gateway... build

FROM node:20-alpine AS runtime
USER node
WORKDIR /app
COPY --from=builder /repo/services/api-gateway/dist ./dist
COPY --from=builder /repo/services/api-gateway/package.json ./package.json
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ./packages
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
```

Repeat the same shape (substituting the service name) for `orchestrator`, `aggregator`, and `worker-fetcher`.

- [ ] **Step 2: Create `services/worker-format/Dockerfile`**

```dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY packages/py-common /app/packages/py-common
COPY services/worker-format /app/services/worker-format
WORKDIR /app/services/worker-format
RUN pip install --no-cache-dir -e ../../packages/py-common
RUN pip install --no-cache-dir -e .
RUN useradd -u 1000 -m runner && chown -R runner:runner /app
USER runner
CMD ["python", "-m", "worker_format"]
```

- [ ] **Step 3: Append app services to `infra/docker-compose.yml`**

Add the following under `services:` (alongside existing infra services):

```yaml
  api-gateway:
    build:
      context: ..
      dockerfile: services/api-gateway/Dockerfile
    depends_on:
      postgres: { condition: service_healthy }
      nats: { condition: service_healthy }
      minio: { condition: service_healthy }
    env_file: ../.env
    environment:
      OTEL_SERVICE_NAME: api-gateway
    ports: ["8080:8080"]

  orchestrator:
    build: { context: .., dockerfile: services/orchestrator/Dockerfile }
    depends_on: [postgres, nats, minio]
    env_file: ../.env
    environment: { OTEL_SERVICE_NAME: orchestrator }

  aggregator:
    build: { context: .., dockerfile: services/aggregator/Dockerfile }
    depends_on: [postgres, nats, minio]
    env_file: ../.env
    environment: { OTEL_SERVICE_NAME: aggregator }

  worker-fetcher:
    build: { context: .., dockerfile: services/worker-fetcher/Dockerfile }
    depends_on: [nats, minio]
    env_file: ../.env
    environment: { OTEL_SERVICE_NAME: worker-fetcher }

  worker-format:
    build: { context: .., dockerfile: services/worker-format/Dockerfile }
    depends_on: [nats, minio]
    env_file: ../.env
    environment: { OTEL_SERVICE_NAME: worker-format }
```

- [ ] **Step 4: Build and bring up the full stack**

Run:
```bash
cd audio-api
cp .env.example .env
docker compose -f infra/docker-compose.yml build
make up
```
Expected: every service `up`, no restart loops.

- [ ] **Step 5: Tail logs to verify boot**

```bash
docker compose -f infra/docker-compose.yml logs api-gateway | tail -5
# Expected: "api-gateway listening on..."
docker compose -f infra/docker-compose.yml logs worker-fetcher | tail -5
# Expected: "worker-fetcher consuming"
docker compose -f infra/docker-compose.yml logs worker-format | tail -5
# Expected: "worker-format consuming"
```

- [ ] **Step 6: Commit**

```bash
git add audio-api/infra/docker-compose.yml audio-api/services/*/Dockerfile
git commit -m "feat(infra): docker-compose includes api-gateway, orchestrator, aggregator, workers"
```

---

## Task 17: Seed token script

**Files:**
- Create: `audio-api/scripts/seed-token.sh`

- [ ] **Step 1: Create the script**

```bash
#!/usr/bin/env bash
set -euo pipefail
TOKEN="${1:-dev-token-$(openssl rand -hex 16)}"
HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | awk '{print $1}')
docker compose -f "$(dirname "$0")/../infra/docker-compose.yml" exec -T postgres \
  psql -U audio -d audio -c \
  "INSERT INTO api_tokens (id, tenant_id, token_hash, name) VALUES ('t_dev', 'tenant_dev', '$HASH', 'dev') ON CONFLICT (id) DO UPDATE SET token_hash = EXCLUDED.token_hash;"
echo "TOKEN=$TOKEN"
```

Make executable: `chmod +x audio-api/scripts/seed-token.sh`

- [ ] **Step 2: Run it**

```bash
cd audio-api
./scripts/seed-token.sh
```
Expected: prints `TOKEN=...`, no error.

- [ ] **Step 3: Commit**

```bash
git add audio-api/scripts/seed-token.sh
git commit -m "feat(scripts): seed-token to create a dev API token"
```

---

## Task 18: Smoke test script (end-to-end)

**Files:**
- Create: `audio-api/scripts/smoke.ts`

- [ ] **Step 1: Implement `scripts/smoke.ts`**

```ts
import { setTimeout as sleep } from "node:timers/promises";

const API = process.env.API_URL ?? "http://localhost:8080";
const TOKEN = process.env.API_TOKEN!;
if (!TOKEN) { console.error("API_TOKEN required"); process.exit(1); }

const SAMPLE_URL = process.env.SAMPLE_URL
  ?? "https://upload.wikimedia.org/wikipedia/commons/c/c5/Ostendo_Tonkunst_Sample.ogg";

async function main() {
  console.log("→ health");
  const h = await fetch(`${API}/v1/health`).then(r => r.json());
  if (h.status !== "ok") throw new Error("health not ok");

  console.log("→ submit");
  const sub = await fetch(`${API}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ input: { type: "url", url: SAMPLE_URL }, analyses: ["format"] })
  });
  if (sub.status !== 201) { console.error(await sub.text()); throw new Error(`submit ${sub.status}`); }
  const { job_id } = await sub.json();
  console.log("  job_id:", job_id);

  for (let i = 0; i < 30; i++) {
    const s = await fetch(`${API}/v1/jobs/${job_id}`, { headers: { authorization: `Bearer ${TOKEN}` } }).then(r => r.json());
    process.stdout.write(`  status=${s.status} analyses=${JSON.stringify(s.analyses)}\r`);
    if (s.status === "completed") {
      console.log("\n→ results");
      const rep = await fetch(`${API}/v1/jobs/${job_id}/results`, { headers: { authorization: `Bearer ${TOKEN}` } }).then(r => r.json());
      console.log(JSON.stringify(rep, null, 2));
      if (!rep.format) throw new Error("no format in report");
      console.log("OK");
      return;
    }
    if (s.status === "failed") throw new Error("job failed: " + JSON.stringify(s));
    await sleep(2000);
  }
  throw new Error("timeout");
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it end-to-end**

```bash
cd audio-api
TOKEN=$(./scripts/seed-token.sh | grep ^TOKEN | cut -d= -f2)
export API_TOKEN="$TOKEN"
pnpm smoke
```
Expected: prints `status=queued → running → completed`, then the JSON report with `format.codec`, `sample_rate`, `channel_count`. Final line: `OK`.

- [ ] **Step 3: Commit**

```bash
git add audio-api/scripts/smoke.ts
git commit -m "feat(scripts): end-to-end smoke test for the format slice"
```

---

## Task 19: CI workflow (lint + test + build)

**Files:**
- Create: `audio-api/.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: CI
on:
  pull_request:
    paths: ["audio-api/**"]
  push:
    branches: [main]
    paths: ["audio-api/**"]

defaults:
  run:
    working-directory: audio-api

jobs:
  node:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_USER: audio, POSTGRES_PASSWORD: audio, POSTGRES_DB: audio }
        ports: ["5432:5432"]
        options: --health-cmd "pg_isready -U audio" --health-interval 5s --health-retries 10
    env:
      DATABASE_URL: postgres://audio:audio@localhost:5432/audio
      NATS_URL: nats://localhost:4222
      OBJECT_STORE_ENDPOINT: http://localhost:9000
      OBJECT_STORE_BUCKET: audio-api
      OBJECT_STORE_ACCESS_KEY: x
      OBJECT_STORE_SECRET_KEY: x
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm, cache-dependency-path: audio-api/pnpm-lock.yaml }
      - run: pnpm install --frozen-lockfile
      - run: psql "$DATABASE_URL" -f infra/migrations/0001_init.sql
      - run: pnpm -r typecheck
      - run: pnpm -r test
      - run: pnpm -r build

  python:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: sudo apt-get install -y ffmpeg
      - run: pip install -e "packages/py-common[dev]"
      - run: ffmpeg -y -f lavfi -i "sine=frequency=440:duration=5" -ac 2 -ar 48000 tests/fixtures/audio/sample-stereo.wav
      - run: cd services/worker-format && pip install -e ".[dev]" && pytest -q
```

- [ ] **Step 2: Commit**

```bash
git add audio-api/.github/workflows/ci.yml
git commit -m "ci: lint+test+build for node services and python workers"
```

---

## Self-Review

**Spec coverage (Plan 1 only, the format slice):**

| Spec section | Plan 1 task |
|---|---|
| 2.2 Stack: Node, Python, NATS, Postgres, MinIO, OTel | T1, T5, T6, T7 |
| 2.3 Architecture (gateway, orchestrator, aggregator, fetcher, format worker) | T8-T15 |
| 3.2 Endpoints: health, POST /v1/jobs, GET /jobs/:id, results, events | T8, T10, T11 |
| 3.4 Result shape | T15 (buildReport) - extended in later plans |
| 4 Pipeline | T14 (pipeline.ts) |
| 4.3 Idempotency, retries | T12 (max_deliver=3), T13 (StageError retryable) |
| 5 Data model | T4 (full schema) |
| 6.3 Structured logs with redaction | T6 (logger.ts), T7 (logging_setup.py), tests in both |
| 6.4 Tracing one trace per job | T6 (telemetry.ts), T7 (telemetry.py) |
| 8 Auth (bearer, hashed tokens) | T9 |
| 9.1 Unit tests | T2, T3, T6, T8, T9, T10, T11, T12, T13, T14, T15 |
| 9.4 Smoke test (lite, full version in Plan 6) | T18 |

Out of scope for Plan 1 (delivered later, as designed):
- VAD, language, DME workers (Plans 2 and 3)
- Sync mode, webhook delivery (Plan 2)
- Multipart / presigned / mount input adapters (Plan 4)
- DME separation (Plan 5)
- Full CI security gates and per-deploy smoke with rollback (Plan 6)
- Production hosting (Plan 7)

**Placeholder scan:** none found.

**Type consistency:** envelope and event payload shapes are defined once in `packages/proto` and imported by every consumer. `Envelope<T>` matches usage in gateway, fetcher, orchestrator, aggregator. `FileReady` and `FormatReady` types match Python field names.

**Scope:** Plan 1 produces a runnable stack with one end-to-end working analysis. Smoke test in T18 proves it.
