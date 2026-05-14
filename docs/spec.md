# Audio Processing API: Design Spec

- **Date:** 2026-05-14
- **Owner:** Adam Hewes (AMH Media Limited)
- **Status:** Design approved, ready for implementation planning
- **Positioning:** Internal tool first, productise later. POC must be built to production-grade bones (microservices, composable, observable) so promotion is a config swap, not a rewrite.

## 1. Product summary

An audio analysis API for broadcast media workflows. Single REST API, composable feature set, channel-aware results.

**Features in v1:**

- **Audio detection.** Codec/format/layout from container, presence/silence regions, speech vs non-speech (VAD).
- **Audio layout.** Channel layout detection: mono, stereo, 5.1, 7.1, Atmos beds. Per-channel labels.
- **Language detection.** Per channel, ISO code plus confidence. Right granularity for broadcast deliverables where 5.1, stereo and M&E often carry different languages.
- **Dialog / Music / Effects.** Two modes:
  - **Classify (default):** time-segment tags per channel ("0:00 to 0:32 is music, 0:32 to 1:15 is dialog"). Cheap, runs on CPU.
  - **Separate (opt-in):** actual stem separation into D, M, E audio files. GPU-heavy, behind its own endpoint.

**Non-functional priorities:**

- Composable: clients only pay for what they ask for.
- Scalable: each capability scales independently, horizontal by replica count.
- Observable: every failure has a stable code, every job has one trace end to end.
- Secure: vuln scanning, secret scanning, SBOM and runtime hardening baked into CI from day one.
- Promotable: same images and same configs from laptop POC to rented GPU production.

## 2. Architecture

### 2.1 Approach

Event-driven workers on a message bus (option A from brainstorming). Picked over a workflow engine (Temporal) and direct HTTP composition because it hits the right balance for an internal-first product with a clear scale path. The bus also gives a natural cut-line for shipping the GPU-heavy worker to a rented GPU host later: same queue, different host.

### 2.2 Stack

- **API gateway and orchestration:** Node/TypeScript, Fastify.
- **Workers:** Python (FastAPI for health endpoints, native model libraries for inference).
- **Message bus:** NATS JetStream.
- **State:** Postgres.
- **Object storage:** MinIO locally, Cloudflare R2 in production (S3-compatible, no egress fees).
- **Observability:** OpenTelemetry, Tempo, Loki, Grafana locally; swappable for cloud APM in production.
- **Containers:** Docker, orchestrated by Compose locally, by Fly.io / Railway / Hetzner in production. No Kubernetes at this stage.

### 2.3 Service inventory

```
                      +----------------------+
  client --HTTPS----> |  API Gateway (Node)  |
                      |  auth, validation    |
                      |  sync + async        |
                      |  results retrieval   |
                      +----------+-----------+
                                 | writes job
                  +--------------v--------------+
                  |   Postgres (job + results)  |
                  +--------------^--------------+
                                 |
            +--------------------+--------------------+
            |      Orchestrator (Node service)        |
            |   listens for worker events             |
            |   decides next step in pipeline         |
            |   aggregates results                    |
            +--------------------+--------------------+
                                 |
                +----------------v----------------+
                |   Message Bus (NATS JetStream)  |
                +----------------+----------------+
                                 |
   +----------+----------+-------+---------+--------------+--------------+
   v          v          v                 v              v              v
 fetcher    format     vad/silence      language     dme-classify    dme-separate
 (Node)     (Python)   (Python)         (Python)     (Python)        (Python,GPU)
                                                                       ^
                            +------------------------------+           |
                            | Object Storage (MinIO -> R2) |<----------+
                            +------------------------------+
```

Each service is independently deployable, independently scalable, talks to the bus and the object store only. No service-to-service HTTP.

### 2.4 Service responsibilities

| Service | Lang | Role |
|---|---|---|
| `api-gateway` | Node/TS | Public REST API, auth, request validation, OpenAPI spec, sync wait + async submission, results endpoints |
| `orchestrator` | Node/TS | Owns pipeline state machine, dispatches next stage on completion events |
| `aggregator` | Node/TS | Stateless, merges per-analysis results into the canonical report when all analyses complete |
| `worker-fetcher` | Node/TS | Pulls input via URL / multipart / presigned / mount, normalises to MinIO working object |
| `worker-format` | Python | `ffprobe` plus header inspection: codec, sample rate, bit depth, channel count and layout |
| `worker-vad` | Python | Silero VAD. Per-channel speech vs non-speech timeline plus silence regions |
| `worker-language` | Python | fast-langdetect or Whisper-small on speech regions. Per-channel ISO code plus confidence |
| `worker-dme-classify` | Python | PANNs or AST classifier. Per-channel time-segment tags |
| `worker-dme-separate` | Python | Demucs htdemucs. GPU-pinned, on-demand only. CPU mode for POC |

## 3. API surface

REST, JSON, OpenAPI 3.1, auth via `Authorization: Bearer <token>`.

### 3.1 Resource model

One core resource: `Job`. A job wraps one or more `analyses`. Stem separation is a sibling resource, opt-in, behind a separate endpoint to protect against accidental GPU spend.

### 3.2 Endpoints

```
POST   /v1/jobs                              # submit
GET    /v1/jobs/{id}                         # status + per-analysis progress
GET    /v1/jobs/{id}/results                 # aggregated report
GET    /v1/jobs/{id}/results/{analysis}      # single analysis (streams from object store)
GET    /v1/jobs/{id}/events                  # audit log for this job
DELETE /v1/jobs/{id}                         # cancel or purge

POST   /v1/uploads                           # returns presigned URL for client-direct upload
POST   /v1/jobs/{id}/separate                # opt-in GPU stem separation
GET    /v1/jobs/{id}/stems/{stem}            # presigned download for separated stem

GET    /v1/health                            # readiness across services
```

### 3.3 Submission shape

```json
{
  "input": {
    "type": "url",
    "url": "https://...",
    "headers": { "Authorization": "..." }
  },
  "analyses": ["format", "vad", "language", "dme_classify"],
  "options": {
    "language": { "candidates": ["en", "fr", "de"] },
    "dme_classify": { "segment_ms": 1000 }
  },
  "callback_url": "https://client.example.com/hook",
  "mode": "async"
}
```

- `analyses` is the composability lever. Same endpoint, opt-in features.
- `mode: "sync"` blocks the connection up to a configurable timeout (default 60s, max 300s). On timeout, returns `202` with `job_id` so the caller can switch to polling.
- `mode: "async"` (default for files over 50MB or duration over 5min, auto-detected after the format stage) returns immediately.
- Input delivery has four adapters behind one internal interface: URL pull, multipart upload, presigned bucket upload, mounted shared storage.

### 3.4 Result shape (aggregated)

```json
{
  "job_id": "j_01HX...",
  "input": { "duration_s": 3612.4, "size_bytes": 1843200000 },
  "format": {
    "codec": "pcm_s24le", "sample_rate": 48000, "bit_depth": 24,
    "channel_count": 6, "channel_layout": "5.1",
    "channels": [
      { "index": 0, "label": "L" }, { "index": 1, "label": "R" },
      { "index": 2, "label": "C" }, { "index": 3, "label": "LFE" },
      { "index": 4, "label": "Ls" }, { "index": 5, "label": "Rs" }
    ]
  },
  "vad": {
    "per_channel": [
      { "channel": 0, "speech_ratio": 0.12, "segments": [{ "start_ms": 320, "end_ms": 1840 }] }
    ]
  },
  "language": {
    "per_channel": [
      { "channel": 2, "language": "en", "confidence": 0.97 }
    ]
  },
  "dme_classify": {
    "per_channel": [
      { "channel": 0, "timeline": [
        { "start_ms": 0, "end_ms": 32000, "tag": "music" },
        { "start_ms": 32000, "end_ms": 75000, "tag": "dialog" }
      ]}
    ]
  },
  "failures": []
}
```

Conventions: times in milliseconds, IDs are ULIDs, timestamps are RFC 3339, channel-indexed everywhere.

### 3.5 Webhook payload

HMAC-signed via `X-Signature` header, per-tenant secret, retries with backoff (1s, 5s, 30s, 2m, 10m).

```json
{
  "event": "job.completed",
  "job_id": "j_01HX...",
  "status": "completed",
  "results_url": "https://api/.../results",
  "summary": { "duration_s": 3612, "channels": 6, "languages": ["en", "en", "fr"] }
}
```

## 4. Pipeline and data flow

```
submit -> fetcher -> format -> [vad || language || dme_classify] -> aggregator -> webhook / sync return
```

### 4.1 Stage flow

1. **Submit.** Gateway validates against OpenAPI, writes `job` row, one `analysis` row per requested analysis, publishes `fetch.requested`.
2. **Fetcher.** Resolves the input adapter, streams to MinIO under `working/{job_id}/source.<ext>`. Computes SHA-256 in flight. Emits `file.ready`.
3. **Format.** Always runs first. Cheap. Outputs the layout descriptor downstream stages need. Emits `format.ready`.
4. **Fan-out.** Orchestrator dispatches requested analyses in parallel.
5. **Aggregator.** Triggered by each `*.ready`. When count matches expected, merges per-analysis result JSONs from MinIO into the canonical report, writes to Postgres, emits `job.completed`.
6. **Delivery.** Sync caller wakes on Postgres LISTEN/NOTIFY. Async caller polls or receives a webhook.
7. **D/M/E separation.** Separate flow, separate endpoint, separate GPU-pinned queue.

### 4.2 Queue topology (NATS JetStream)

| Stream | Subjects | Consumers | Retention |
|---|---|---|---|
| `AUDIO_WORK` | `audio.work.fetch`, `audio.work.format`, `audio.work.vad`, `audio.work.language`, `audio.work.dme_classify`, `audio.work.separate` | one durable per worker class | 7 days |
| `AUDIO_EVENTS` | `audio.event.file.ready`, `audio.event.*.ready`, `audio.event.job.completed`, `audio.event.job.failed` | orchestrator, aggregator, webhook | 24h |

One subject per worker class. Scale a worker by adding replicas against the same durable consumer. NATS distributes work automatically.

### 4.3 Idempotency, retries, cancellation

- Every message carries `attempt_id = hash(job_id + stage)`. Workers check Postgres first; if the analysis already has a result, ack and skip.
- ACK only after both MinIO and Postgres are committed. Mid-run crash leads to redelivery and rerun.
- Max 3 attempts per stage. After that the analysis is marked `failed`. Aggregator still produces a partial report with `failures` populated.
- A job is only `status=failed` if the fetcher fails or every requested analysis fails. Otherwise it is `status=completed` with partial results.
- `DELETE /v1/jobs/{id}` flips the job to `cancelled` and emits `job.cancelled`. Workers check this before starting expensive work. Mid-stage cancels are not interrupted; the result is discarded.

### 4.4 Concurrency limits

Per-worker env var (`WORKER_CONCURRENCY`). 4 for the language worker, 1 for the GPU separator, etc. No code change to retune.

## 5. Data model and storage

Three storage layers, each with one job.

### 5.1 Postgres (state + final results)

```sql
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
CREATE INDEX ON jobs (tenant_id, created_at DESC);
CREATE INDEX ON jobs (status) WHERE status IN ('queued','running');

CREATE TABLE analyses (
  job_id          TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL,
  attempts        INT NOT NULL DEFAULT 0,
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
CREATE INDEX ON job_events (job_id, ts);

CREATE TABLE api_tokens (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  token_hash      TEXT NOT NULL,
  name            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ
);
CREATE INDEX ON api_tokens (token_hash) WHERE revoked_at IS NULL;
```

- `jobs` and `analyses` separation allows per-feature progress reporting.
- `results.report` is JSONB; schema will evolve. GIN indexes added on hot query paths when needed.
- `job_events` is the canonical audit log. Every transition lands here.
- `input_descriptor` is stored redacted: auth headers and presigned signatures stripped.

### 5.2 Object storage

```
audio-api/
  working/{job_id}/source.<ext>          # source. TTL 7 days post-completion.
  results/{job_id}/{analysis}.json       # per-analysis output. TTL 30 days.
  stems/{job_id}/{stem}.wav              # separation output. TTL 24h unless retained.
```

Lifecycle rules per prefix. Workers always read and write via the object store: zero shared filesystem, zero coupling between hosts.

### 5.3 NATS JetStream (transient state)

In-flight work only. Postgres plus MinIO are enough to rebuild from `analyses WHERE status IN ('running','pending')` if JetStream is wiped.

### 5.4 What does not go in Postgres

- Raw audio, ever.
- Full per-analysis payloads (a 2-hour VAD timeline is a few MB). Those live as MinIO JSON; the `results.report` table holds the merged summary only.

### 5.5 Migrations

`node-pg-migrate`. One migration per change. Runs as a one-shot job before service rollout in production. Never "migrate on startup".

## 6. Error handling and observability

Three principles:

1. Every failure has a stable code, a human message, a trace.
2. Partial success is a first-class outcome.
3. One trace per job, end to end.

### 6.1 Error taxonomy

| Class | Retry? | Caller sees |
|---|---|---|
| Client error (bad URL, unsupported codec, auth fail) | No | 4xx with stable code |
| Transient infra (NATS hiccup, MinIO 503, model load timeout) | Yes, up to 3 attempts with backoff | 2xx, only surfaces if all retries exhausted |
| Stage logic failure (model OOM, no output) | Stage-level retry once; on second failure, mark that analysis failed | Job completes with partial results |

### 6.2 Error code catalogue

```
INPUT_UNREACHABLE
INPUT_UNSUPPORTED_CODEC
INPUT_TOO_LARGE
INPUT_AUTH_FAILED
FORMAT_PROBE_FAILED
VAD_MODEL_FAILED
LANGUAGE_LOW_CONFIDENCE
DME_CLASSIFY_FAILED
DME_SEPARATE_OOM
JOB_CANCELLED
RATE_LIMITED
INTERNAL
```

Each code maps to HTTP status, retryability, and recommended client action. Mapping lives as a constant in the API gateway, listed in the OpenAPI spec.

### 6.3 Logging

Structured JSON only. `pino` in Node, `structlog` in Python: same JSON shape, one ingestion pipeline.

```json
{
  "ts": "2026-05-14T11:42:08.314Z",
  "level": "info",
  "service": "worker-vad",
  "version": "1.4.2",
  "trace_id": "4f8b2e...",
  "span_id": "9a1c...",
  "job_id": "j_01HX...",
  "tenant_id": "t_acme",
  "stage": "vad",
  "event": "stage.completed",
  "duration_ms": 18432,
  "msg": "VAD complete: 6 channels, 412 segments"
}
```

- Levels stingy: `error` means a human looks, `warn` is notable, `info` is stage transitions, `debug` is off by default.
- Secrets redacted at the logger via a deny-list serialiser. Cannot accidentally print a token.

### 6.4 Tracing

OpenTelemetry. Trace ID generated at the API gateway when a job is submitted, propagated via NATS message headers into every worker, every Postgres query, every MinIO call. One trace per job, with spans for each stage and each model inference call (model name and version as attributes).

### 6.5 Metrics

Small, fixed set:

```
audio_jobs_submitted_total{tenant, mode}
audio_jobs_completed_total{tenant, status}
audio_stage_duration_seconds{stage, status}
audio_stage_failures_total{stage, code}
audio_queue_depth{subject}
audio_worker_busy_ratio{worker}
audio_webhook_attempts_total{outcome}
```

Three Grafana dashboards: Throughput, Latency, Failure. That is enough.

### 6.6 Alerting

Three alerts only at the POC stage:

- Queue depth growing for over 5min on any subject.
- Stage failure rate over 10% over 15min.
- Webhook delivery success under 90% over 15min.

### 6.7 Client-facing visibility

```
GET /v1/jobs/{id}/events      # audit log, surfaced through the API
GET /v1/jobs/{id}             # per-analysis progress with durations
```

So a client SDK can show live progress without us building a UI.

## 7. Deployment

### 7.1 Local POC

`docker compose up -d` brings up the full stack. ~6GB RAM idle, ~12GB under a running 2-hour-file job. Runs on a laptop.

Services in compose: gateway, orchestrator, aggregator, fetcher, format, vad, language, dme-classify, dme-separate (CPU mode), nats, postgres, minio, otel-collector, tempo, loki, grafana.

### 7.2 Repo layout (monorepo)

```
audio-api/
  services/
    api-gateway/         # Node/TS
    orchestrator/        # Node/TS
    aggregator/          # Node/TS
    worker-fetcher/      # Node/TS
    worker-format/       # Python
    worker-vad/          # Python
    worker-language/     # Python
    worker-dme-classify/ # Python
    worker-dme-separate/ # Python
  packages/
    proto/               # shared message schemas, generates TS + Python types
    contracts/           # OpenAPI spec, error codes, result schemas
  infra/
    docker-compose.yml
    compose.override.gpu.yml
    grafana/dashboards/
    otel/collector-config.yaml
    migrations/
  scripts/
    seed-token.sh
    submit-sample.sh
    smoke.ts             # per-deploy smoke test runner
  .env.example
  Makefile
```

The `contracts` package is the source of truth for cross-language schemas. One PR updates types in both Node and Python; CI catches drift.

### 7.3 Configuration

Twelve-factor. Every service reads only from env vars. `.env.example` documents every variable.

### 7.4 Production posture

Hybrid: a cheap always-on tier for everything except GPU work; a rented GPU tier for separation.

**Always-on tier (Fly.io / Railway / Hetzner):**

- API gateway, orchestrator, aggregator, fetcher, format, VAD, language, dme-classify
- Postgres: managed (Neon, Supabase, or RDS)
- NATS JetStream: Synadia Cloud, or self-hosted alongside
- Object storage: Cloudflare R2

Rough monthly cost: $40 to $80 for the base tier.

**On-demand GPU tier (RunPod or Vast.ai):**

- `worker-dme-separate` only.
- RunPod serverless mode: worker spins up on first message in `audio.work.separate`, idles down after N seconds. Pay per second of inference.
- Same container image as POC. Differences: `--gpus all`, `WORKER_CONCURRENCY=1`, deployed to the GPU host.
- GPU host kept in the same region as R2 to avoid cross-region multi-GB transfers.

### 7.5 Scaling policy

- CPU workers: horizontal by replica count. NATS distributes work.
- GPU worker: queue-driven autoscaling via RunPod, watching `audio.work.separate` depth.

### 7.6 Promotion path

POC to production is three concrete swaps, all via `.env`:

| Local POC | Production |
|---|---|
| MinIO container | Cloudflare R2 |
| Postgres container | Neon / Supabase / RDS |
| NATS container | Synadia Cloud or self-hosted NATS |
| Tempo/Loki in compose | Honeycomb or Datadog |
| Dev seed tokens | Tokens issued by admin endpoint |
| All on one host | Base tier on VPS, separation on RunPod |

No source code changes.

### 7.7 Secrets

- Local: `.env`, gitignored, `.env.example` committed.
- Production: host platform secret manager. Never checked in. Token hashes only in Postgres, never raw tokens.

## 8. CI/CD and security gates

### 8.1 Per-PR gates

| Gate | Tool | Catches |
|---|---|---|
| Static analysis | `eslint` + `@typescript-eslint`, `ruff` + `bandit` | unsafe idioms (eval, shell=true, unsafe deserialisation) |
| Dependency vulns | `npm audit --omit=dev`, `pip-audit`, Dependabot | known CVEs in deps; fails build at severity >= medium |
| License audit | `license-checker`, `pip-licenses` | GPL/AGPL creeping in via transitive deps |
| Secret scanning | `gitleaks` pre-commit + GitHub secret scanning | tokens and keys accidentally committed |
| Container image scan | `trivy` against built images | OS package CVEs, known-bad libs |
| SBOM generation | `syft` per image | bill of materials archived per build |
| Dockerfile lint | `hadolint` | running as root, `:latest`, missing flags |
| OpenAPI lint | `spectral` against `packages/contracts/openapi.yaml` | schema breakage, missing auth on new endpoints |
| Migration safety | `squawk` against new SQL | non-concurrent indexes, dropping columns, lock-heavy migrations |

### 8.2 Per-deploy gates

Run after image rollout, before traffic flips:

- All workers boot, register with NATS, pass `/health` and `/ready`.
- Migration job completes.
- Smoke test suite passes (Section 9 Tier 4).
- Trivy re-scans the running image (catches zero-days published since the build).

### 8.3 Runtime hardening (enforced by image lint)

- Containers run as non-root UID.
- Read-only root filesystem; writes only to mounted volumes.
- No shell in production images (distroless or `scratch` for Node, `python:slim` minimum for workers).
- No build tools in final image (multi-stage builds).
- Base images pinned by digest, not by tag.

### 8.4 API-layer security

- Rate limiting per token (Redis-backed token bucket), caps request count and total audio minutes per window.
- Input URL allowlist option per tenant. Default deny: RFC1918, link-local, loopback, AWS metadata IPs. Prevents SSRF.
- Presigned URL TTL caps (24h max).
- HMAC webhook signing, rotatable per-tenant secret.
- API tokens hashed at rest, redacted at the logger.

### 8.5 Quarterly

- `npm audit` and `pip-audit` run on a schedule; new findings open issues even on unchanged services.
- Manual review of SBOM diff vs. last quarter.

### 8.6 Override policy

Any gate failing blocks the deploy. Overrides require a `security-override` label on the PR plus a logged reason. No silent overrides.

## 9. Testing strategy

Five active tiers plus a continuous security tier. None optional.

### 9.1 Tier 1: Unit tests (every commit)

- Node: `vitest`. 80% coverage threshold on contract-touching services (gateway, orchestrator, aggregator).
- Python: `pytest`. Each worker tests model-handling code against fixture audio clips (silent, speech, music, mixed, multi-channel, unsupported codec).
- Mocks are explicit and use the same interfaces as production clients, exported from `packages/proto`.

### 9.2 Tier 2: Contract tests (every PR)

- API gateway request/response: OpenAPI 3.1 schema, fuzzed with `schemathesis` against the running gateway.
- Queue messages: JSON Schema in `packages/proto`. Producer asserts conformance, consumer asserts handling of every valid example.
- DB schema: migration up + down + idempotency on an ephemeral Postgres in CI.

### 9.3 Tier 3: Integration tests (every PR)

Compose-driven, real stack, no mocks below the test harness. Target wall-clock under 5 minutes.

Canonical scenarios:

1. Happy path async, all four analyses on a 30s clip.
2. Happy path sync, small clip.
3. Sync timeout fallback (long file with `mode=sync` returns 202).
4. Partial failure (intentionally corrupted segment, assert other analyses succeed).
5. Cancellation mid-pipeline.
6. Webhook delivery with HMAC verification.
7. Idempotency (replay queue message, assert no double-processing).
8. Auth: missing, revoked, valid.
9. SSRF defence: submit URL pointing at metadata IP, assert rejection.
10. Separation flow: classify then separate, assert stem download URLs work.

### 9.4 Tier 4: Smoke tests (every deploy)

The per-deploy tester. Runs against the live deployed environment after rollout, before declaring success.

- ~8 fast checks, under 60s total.
- Real token, real audio clips from a fixed bucket, real end-to-end assertions.
- On fail: automatic rollback to previous image SHA. Deploy job exits non-zero.
- Aggregate goes to Slack with the deploy SHA attached.

Checks:

1. `GET /v1/health` reports green.
2. `GET /v1/jobs/nonexistent` returns 404 with structured error.
3. Invalid auth returns 401.
4. `POST /v1/jobs` with a tiny sample completes within 30s and matches the golden report.
5. `POST /v1/jobs/{id}/separate` completes; stem URLs resolve to non-empty files.
6. Webhook delivery: signed payload arrives within 60s, signature verifies.
7. NATS queue depth under 100 on every subject.
8. Postgres migration version matches expected for this deploy SHA.

Implementation: `scripts/smoke.ts`. Same script runs in CI and ad-hoc by any developer.

### 9.5 Tier 5: Load and soak (pre-release of major versions)

- `k6` ramp test: 0 to 50 concurrent jobs over 5 minutes, hold for 15 minutes. Watch p95 latency and queue depth.
- Soak test: 24 hours at 1 job/min. Catches slow leaks, file handle growth, lifecycle misbehaviour.
- Output report pinned in the release PR. Regressions surface as red lines.

### 9.6 Tier 6: Security verification (continuous + per release)

- All Section 8 gates on every PR.
- SBOM and Trivy report archived per release tag.
- Pre-release: manual review of new dependencies added since last tag.
- Quarterly informal pen test: SSRF, auth bypass, presigned URL abuse, NATS subject leakage between tenants. `scripts/security-probe.ts` automates the boring parts.

### 9.7 Test data

- 8 reference clips in `tests/fixtures/audio/`: mono dialog, stereo music, 5.1 mixed, 5.1 M&E split, multi-language stereo, silent, 24-bit 96kHz edge case. ~50MB total.
- Larger fixtures (10min+) live in an R2 bucket; tests pull via presigned URL. Repo only holds hashes.

## 10. Open questions

1. **Model licensing.** Demucs is MIT (fine). PANNs is commercially permissive but worth a re-check. Whisper-small is MIT. Document the licence for each model before shipping commercially.
2. **GPU vendor choice.** RunPod recommended for serverless GPU; Vast.ai cheaper but interruptible. Worth running a 2-week side-by-side on real workloads before committing in production.
3. **Tenant model when productising.** Token per tenant works today; full tenant isolation (separate Postgres schemas? row-level security?) is a decision for the productisation milestone, not the POC.

## 11. Out of scope (and why), with roadmap

We deliberately stopped short on several things. Each is captured here both to show the trade-offs were considered and to seed the future roadmap.

### 11.1 Out of scope for v1

| Item | Why not now | Where it lands |
|---|---|---|
| Loudness analysis (EBU R128, true-peak, dialnorm) | Distinct domain, separate model and library set. Not in the answered feature list. | Roadmap M2 |
| Per-segment language detection (code-switching) | Heavier compute, less common need. Per-channel covers 90% of broadcast cases. | Roadmap M3 |
| Streaming / live audio | Big jump in complexity (WebSocket / gRPC streaming, partial results, model state). File-based covers the addressable market for now. | Roadmap M4 |
| Multi-tenant billing and quotas | Internal-first means single-tenant POC. Quota plumbing exists (token, rate limit) but billing integration is not. | Roadmap M5 |
| Speech-to-text (full transcript) | Adjacent product; deliberately not in scope to keep the API focused. Whisper is used internally for language detect but not exposed. | Roadmap M3 |
| Subjective quality scoring (PEAQ, POLQA) | Specialist licensing required, niche demand from delivery QC houses only. | Roadmap M6 only if a client asks |
| Speaker diarisation (who-spoke-when) | Often paired with audio analysis but a different model family. | Roadmap M4 |
| Music identification / fingerprinting (ACR) | Different domain again; licensing of reference databases is a project on its own. | Not on roadmap |
| Workflow engine (Temporal) | Overkill for POC; correct answer when scale demands it. | Migration path noted, no v1 work |
| Kubernetes | Compose plus Fly/Railway/Hetzner suffices until ~20 services or multi-region. | Migration path noted, no v1 work |
| Multi-region deployment | Single region until a client demands otherwise. | Roadmap M5 |
| Auto-scaling the base tier | Manual replica count is fine until usage proves a pattern. | Roadmap M4 |
| Chaos engineering, mutation testing | Premature; comes after the first paying client. | Roadmap M6 |
| Cross-tenant fuzz testing | Single-tenant today; add when multi-tenant lands. | Roadmap M5 |
| Sentry / SaaS error tracking | OTel traces + structured logs cover it. Adding Sentry early just splits attention. | Roadmap, optional, only if useful |
| Replay / re-run from event log | Tempting but not needed until someone asks. | Backlog |
| In-API UI / dashboard | Not the product. Grafana for ops; clients build their own UIs over the API. | Not on roadmap |

### 11.2 Roadmap milestones

Indicative grouping, sequenced by likely commercial demand. Each milestone is its own brainstorm-design-implement cycle when reached.

**M1: v1 release.** Everything in this spec. Internal use first.

**M2: Broadcast QC pack.**
- Loudness analysis (EBU R128, true-peak, integrated, short-term, momentary).
- Dialnorm validation.
- Configurable QC profile per tenant (e.g., "Channel 4 deliverable: integrated -23 LUFS ± 1, true-peak ≤ -1 dBTP").

**M3: Speech intelligence pack.**
- Speech-to-text transcript endpoint (Whisper-large, GPU).
- Per-segment language detection (code-switching).
- Optional speaker diarisation as part of transcript.

**M4: Real-time and scale.**
- Streaming endpoint (chunked input, partial results over WebSocket).
- Auto-scaling base tier.
- Speaker diarisation as an offline analysis.
- Workflow engine migration (Temporal) if scale demands it.

**M5: Productisation.**
- Multi-tenant isolation, quotas, billing integration.
- Multi-region deployment.
- Cross-tenant fuzz testing in CI.
- Public docs, SDKs in TS and Python.

**M6: Premium and resilience.**
- Subjective quality scoring (PEAQ / POLQA) if licensable and demanded.
- Chaos engineering and mutation testing.
- Optional SaaS error tracking integration.

## 12. Assumptions

- Local POC machine has at least 16GB RAM and ~40GB free disk for object storage and model weights.
- An R2 (or S3) account is available before promoting to production.
- A GPU rental provider account (RunPod recommended) is available before stem separation is needed in production.
- Audio inputs are file-based, not live streams, in v1.
- All audio is mixed-down distribution-ready content, not raw multi-mic recordings.

## 13. Success criteria

- All v1 features available via the API and reachable through a single end-to-end smoke test.
- p95 latency under 2x real-time for analysis-only jobs (a 60-minute file analysed in under 120 minutes wall-clock).
- Per-deploy smoke tests pass automatically and roll back on failure.
- A new analysis worker can be added in under one day by following the worker template.
- All Section 8 security gates pass on every PR.
- One trace per job, end to end, queryable in under 10 seconds in Grafana.
