# Audio Processing API — Technical Guide

For operators and contributors. If you just want to call the API, see [`user-guide.md`](./user-guide.md). If you want the design rationale, see [`spec.md`](./spec.md).

Diagrams in [`diagrams/`](./diagrams/) — open the `.excalidraw` files at [excalidraw.com](https://excalidraw.com).

## Local bring-up

```bash
cp .env.example .env
make up               # docker compose up -d
make migrate          # apply SQL migrations
make seed             # creates an api_token, prints TOKEN=...
make smoke            # end-to-end test
```

`make` is a thin wrapper around `docker compose`. On Windows where `make` isn't installed, run the commands directly:

```bash
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml run --rm migrate
./scripts/seed-token.sh
API_TOKEN=<from seed> pnpm smoke
```

The compose file brings up postgres, NATS, MinIO, otel-collector, tempo, prometheus, loki, grafana, then the seven application containers (api-gateway, orchestrator, six workers).

## Architecture overview

See [`diagrams/architecture.excalidraw`](./diagrams/architecture.excalidraw) for the picture.

**Three layers:**

- **Edge** — `api-gateway` (Fastify, Node). Single ingress for clients. Bearer auth, request validation, persists job to Postgres, publishes `audio.work.fetch` to start the pipeline.
- **Engine** — `orchestrator` (Node) plus six workers. Orchestrator owns the state machine; workers do the actual analysis.
- **Storage** — Postgres for state and metadata, MinIO (S3-compatible) for audio sources and per-stage result JSONs, NATS JetStream for inter-service messages.

Everything emits OTel traces to the collector → Tempo → Grafana on `:3000`. Tempo's metrics-generator derives RED span metrics from those traces and remote-writes them to Prometheus, which backs the throughput / error-rate / latency dashboards.

## Job lifecycle

See [`diagrams/job-lifecycle.excalidraw`](./diagrams/job-lifecycle.excalidraw).

Short version:

1. Client `POST /v1/jobs`.
2. Gateway: auth, INSERT job, publish `audio.work.fetch`.
3. `worker-fetcher`: download URL → MinIO `sources/<job>.bin`, publish `audio.event.file.ready`.
4. `orchestrator` on `file.ready`: dispatch `audio.work.format`.
5. `worker-format`: ffprobe → `results/<job>/format.json`, publish `audio.event.format.ready`.
6. `orchestrator` on `format.ready`: fan out `work.{vad,language,dme_classify}` for the requested analyses.
7. Workers run in parallel, each publishes `audio.event.<stage>.ready`.
8. `orchestrator` on each `*.ready`: UPDATE `analyses`, run `isComplete` check. When all done: read result JSONs from MinIO, build report, INSERT `results`, UPDATE `jobs.status='completed'`, publish `audio.event.job.completed`.
9. `worker-webhook` on `job.completed`: POST `callback_url` with HMAC SHA-256 signature.

The orchestrator owns finalisation directly (it used to be a separate `aggregator` service, but that race-conditioned with the orchestrator's own DB writes — see commit `cbdfead`).

## Services

| Service | Lang | Role |
|---|---|---|
| `api-gateway` | Node/Fastify | Ingress, auth, job submit/read |
| `orchestrator` | Node | State machine, dispatch, finalise, report build |
| `worker-fetcher` | Node | Download source → MinIO |
| `worker-format` | Python | ffprobe — codec/channels/sample rate |
| `worker-vad` | Python | Silero VAD — speech segments |
| `worker-language` | Python | faster-whisper — per-channel language |
| `worker-dme-classify` | Python | PANNs Cnn14 — dialog/music/effects |
| `worker-webhook` | Node | HMAC-signed callback POST |
| `worker-stream-supervisor` | Python | Spawns stream pods, allocates WS/SRT ports |
| `worker-stream-pod` | Python | Per-stream live captions: WS, VTT, TTML, caption TS |

Shared code: `packages/node-common` (NATS, Postgres pool, S3 helpers, logger, OTel, errors), `packages/py-common` (same set for Python), `packages/proto` (event schemas + subject constants), `packages/contracts` (error code catalogue).

## NATS subjects

Two streams, both `audio.event.>` and `audio.work.>` patterns:

- **AUDIO_WORK** — request queue, retention `limits`, max-age 7d, discard old.
  - `audio.work.fetch`
  - `audio.work.format`
  - `audio.work.vad`
  - `audio.work.language`
  - `audio.work.dme_classify`
- **AUDIO_EVENTS** — event stream, retention `limits`, max-age 24h, discard old.
  - `audio.event.file.ready`
  - `audio.event.format.ready`
  - `audio.event.vad.ready`
  - `audio.event.language.ready`
  - `audio.event.dme_classify.ready`
  - `audio.event.job.completed`
  - `audio.event.job.failed`

Streams are bootstrapped by `infra/nats/bootstrap-streams.sh`, run by the `nats-bootstrap` compose service. Application services have `depends_on: nats-bootstrap (service_completed_successfully)` so they don't race stream creation.

Consumers (one per service) are created idempotently at startup with explicit ack and 30s ack-wait. Names: `orchestrator`, `worker-fetcher`, `worker-format`, `worker-vad`, `worker-language`, `worker-dme-classify`, `worker-webhook`.

## Database

Postgres 16. Schema in `infra/migrations/`. Apply with `docker compose run --rm migrate` (the migrate service runs every `*.sql` file in lexical order).

| Table | Purpose |
|---|---|
| `jobs` | One row per submitted job. Status, timing, source object key, callback. |
| `analyses` | One row per (job, analysis). Per-stage status, result_object key, error. PK `(job_id, name)`. |
| `results` | Final aggregated report JSON per job. PK `job_id`. |
| `job_events` | Audit log of state transitions. Append-only. |
| `api_tokens` | Bearer tokens, hashed (SHA-256). PK `id`, unique partial index on `token_hash` where not revoked. |
| `tenant_secrets` | Per-tenant `webhook_secret` for HMAC signing. PK `tenant_id`. |
| `admin_tokens` | Ops console tokens, hashed (SHA-256). Same shape as `api_tokens` but with **no `tenant_id` column** — see below. |
| `admin_audit` | Append-only record of admin actions (kills, token issuance, cue views). No FK to `admin_tokens`: the audit outlives the token. |

There is no `tenants` table. A tenant is a string that appears on a job, a stream or a token, which is why `GET /v1/admin/tenants` derives the list by UNION-ing those columns, and why issuing a token for an unknown tenant is effectively tenant creation.

Migrations are not idempotent — re-running on existing tables errors with `relation already exists`. To wipe and reapply: `docker compose down -v && make up && make migrate`.

## MinIO layout

Bucket `audio-api`, layout:

```
sources/<job_id>.bin              ← worker-fetcher writes
results/<job_id>/format.json      ← worker-format writes
results/<job_id>/vad.json         ← worker-vad writes
results/<job_id>/language.json    ← worker-language writes
results/<job_id>/dme_classify.json ← worker-dme-classify writes
```

Bucket bootstrapped by the `minio-bootstrap` compose service.

## Configuration

All services read `.env` (via compose `env_file: ../.env`). Defaults in `.env.example`.

| Var | Used by | Default |
|---|---|---|
| `DATABASE_URL` | api-gateway, orchestrator, worker-webhook | `postgres://audio:audio@postgres:5432/audio` |
| `NATS_URL` | all | `nats://nats:4222` |
| `OBJECT_STORE_ENDPOINT` | all that touch MinIO | `http://minio:9000` |
| `OBJECT_STORE_BUCKET` | same | `audio-api` |
| `OBJECT_STORE_ACCESS_KEY` / `SECRET_KEY` | same | `audioadmin` / `audioadminpw` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | all | `http://otel-collector:4317` |
| `OTEL_SERVICE_NAME` | per-service in compose | service name |
| `API_PORT` | api-gateway | `8080` |
| `SYNC_TIMEOUT_MS` | api-gateway | `60000` |
| `JOB_SIZE_LIMIT_MB` | api-gateway | `10000` |
| `WORKER_CONCURRENCY` | workers | `2` |
| `LOG_LEVEL` | all | `info` |
| `SERVICE_VERSION` | all | `dev` |
| `POD_CAPTION_TS` | worker-stream-pod | unset (`1` enables the caption TS output) |
| `POD_SRT_HOST` / `POD_SRT_PORT` | worker-stream-pod | `0.0.0.0` / set by the supervisor |
| `POD_CAPTION_FPS` | worker-stream-pod | `25` |
| `POD_CAPTION_LATENCY_MS` | worker-stream-pod | `1000` |
| `POD_CAPTION_SERVICE` | worker-stream-pod | `1` (CEA-708 service number) |
| `STREAM_SRT_PORT_START` / `_END` | worker-stream-supervisor | `11000` / `11009` |
| `SRT_PUBLIC_HOST` | api-gateway | host in `caption_srt_url` |
| `STREAM_INGEST_PORT_START` / `_END` | worker-stream-supervisor | `9100` / `9109` (inbound, UDP) |
| `INGEST_PUBLIC_HOST` | api-gateway | host in `ingest.url` |
| `STREAM_ALLOW_UNAUTH_INGEST` | api-gateway | unset (`1` allows a listener with no passphrase; dev only) |
| `POD_PROVISION_TTL_S` | worker-stream-pod | `15` (first frame from a pull source) |
| `POD_INGEST_WAIT_S` | worker-stream-pod | `300` (first frame from a pushing encoder) |
| `POD_RECONNECT_WINDOW_S` | worker-stream-pod | `60` (how long a dropped srt source has to come back; 0 disables) |

### SRT sources

`source.kind: srt` in two directions, per stream (see `docs/live-subtitles-design.md` §3):

- **caller** -- the pod dials out to the client's SRT server. Operationally identical to the hls/dash/mp4 pull: outbound only, no new ports. SSRF-guarded like any other URL we dial.
- **listener** -- the client's encoder pushes into the pod, which binds a port from the inbound range. This is the only inbound media path in the system.

Both use ffmpeg's libsrt. The passphrase is passed as a `-passphrase` argv token rather than a URL query param, because ffmpeg echoes the input URL in its errors and that stderr becomes both a log line and a NATS `stream.failed` message. `audio_source._redact` scrubs held secrets and any URL query string out of that stderr before it escapes.

Listener deployment, which the pull-only model did not require:
- The ingest range must be published as **UDP** and reachable from the encoder through firewall/NAT; `INGEST_PUBLIC_HOST` must resolve to the pod host.
- The passphrase is the only auth on that port, so it is mandatory unless `STREAM_ALLOW_UNAUTH_INGEST=1`.
- One port per stream caps concurrent listeners; an abandoned one holds its pod for `POD_INGEST_WAIT_S`, and `STREAM_MAX_PODS` (4 in compose) bites first.
- **Reconnects are handled.** Both srt directions survive a drop: the listener re-accepts, the caller redials, within `POD_RECONNECT_WINDOW_S` (60s, 0 disables). A stream waiting on a reconnect still holds its pod and port, so the window trades recovery against how long an abandoned stream wedges a `STREAM_MAX_PODS` slot.
- Cue timestamps are frame-counted, so the source measures each outage and emits a `Gap`; `VadGate.advance` finalises the cue cut off mid-word and moves the clock over the hole. Without that, every cue after a reconnect would be stamped early by the length of the drop and drift from the wall-clock caption TS.

### Caption TS output

Opt-in per stream via `output.caption_ts` (see `docs/live-subtitles-design.md` §3).
A fourth output alongside WS, VTT and TTML: a caption-only MPEG-TS carrying
CEA-708 (+608 compat) as SMPTE ST 2038 ancillary data, for a downstream muxer.

Pipeline, all in-process inside the pod: `cea708 -> cdp -> smpte2038 -> ts_mux`,
driven by a wall-clock frame ticker in `Caption708Muxer`. `CueFanout` feeds it
finalised cues; the muxer pipes raw TS into an ffmpeg subprocess that does the
SRT egress. PTS/PCR are wall-clock plus `POD_CAPTION_LATENCY_MS`. Every frame
carries a CDP, an idle one being all-padding, so the TS never goes silent.

The output is best-effort by design: a failure to start or run SRT egress logs
and is swallowed, never failing the stream or its other outputs. The cue queue
is bounded and drops oldest, so captions cannot back-pressure ASR
(`Caption708Muxer.dropped` / `.frames_emitted` expose the counters).

Deployment: the pod is the SRT **listener** and the downstream muxer connects as
caller, so the supervisor's SRT port range must be reachable from the muxer, and
`SRT_PUBLIC_HOST` must resolve to the pod host. The supervisor allocates one
port per caption-enabled stream from that range, so it caps how many can run
concurrently. Byte-level design notes:
`docs/superpowers/plans/2026-07-15-cta708-caption-ts.md`.

## Issuing tokens

```bash
./scripts/seed-token.sh                 # auto-generates a dev token
./scripts/seed-token.sh "my-token"      # uses your token
```

Sets per-tenant webhook secret separately:

```sql
INSERT INTO tenant_secrets (tenant_id, webhook_secret)
VALUES ('tenant_dev', 'replace-with-random-32-bytes-base64')
ON CONFLICT (tenant_id) DO UPDATE SET
  webhook_secret = EXCLUDED.webhook_secret,
  rotated_at = now();
```

Revoke a token:

```sql
UPDATE api_tokens SET revoked_at = now() WHERE id = 't_dev';
```

## Admin API (ops console)

`/v1/admin/*` is the cross-tenant surface the ops console runs on. It is **off unless `ADMIN_API_ENABLED=1`**. It can read and kill any tenant's streams and issue tokens for any tenant, so leave it off anywhere that does not need it.

### Bootstrap

```bash
make seed-admin                 # generates and prints an admin token
./scripts/seed-admin-token.sh "ad_my-token"
```

This is the only way an admin token comes into existence. There is deliberately no `ADMIN_TOKEN` env fallback: a shared env secret cannot be revoked and makes every `admin_audit` row say "somebody".

### Why admin tokens are a separate table

`admin_tokens` has no `tenant_id` column, so "which tenant is this admin" is structurally unanswerable rather than answerable-but-wrong. `requireAdmin` never sets `req.tenant_id`. An `is_admin` flag on `api_tokens` was rejected: one stray `UPDATE` would turn a customer token into a cross-tenant reader.

The guard is a **scope-level `onRequest` hook** in `routes/admin/index.ts`, not a per-route opt-in, so a new admin route is guarded by construction. That file must never be wrapped in `fastify-plugin` — `fp` breaks encapsulation and would hoist the hook to the root instance, 401-ing the entire customer API.

`tests/admin-auth.test.ts` enumerates the real router via an `onRoute` sweep and asserts every admin route rejects both an anonymous caller and a valid *tenant* token. New routes are covered without anyone remembering.

### Show-once tokens

`POST /v1/admin/tokens` returns the plaintext exactly once; only the SHA-256 hash is stored. Losing it means revoke and reissue — there is no recovery.

Issuing a token for a tenant with no existing rows **creates that tenant**, so it requires `allow_new_tenant: true`. Without that guard a typo'd `tenant_id` silently forks a permanent phantom tenant nobody can find. New tenants also get a `tenant_secrets` row in the same transaction: without one, `worker-webhook` silently no-ops and the tenant's webhooks would never fire and never error.

### What admin never exposes

`source_headers`, `source_passphrase`, `token_hash`, `webhook_secret`, and — the ones that get missed — raw `jobs.input_descriptor.url` and raw `callback_url`. Presigned URLs *are* credentials. Guaranteed in layers: named column lists (`routes/admin/sql.ts`, never `SELECT *`), explicit field-by-field mappers (`routes/admin/mappers.ts`), `redactUrl()` keeping only `origin + pathname`, and `tests/admin-redaction.test.ts` seeding real secrets and scanning every admin response for the literals.

Cue text *is* exposed, deliberately and admin-only: reading the captions is the point of the console. Cue views are audited.

## Adding an analysis

1. Add the type to `packages/proto/src/index.ts`: a new `*Ready` interface, a new `EVENT_*_READY` and `WORK_*` subject in the `SUBJECTS` const, and a JSON schema under `packages/proto/schemas/events/`.
2. Add the analysis name to `VALID_ANALYSES` in `services/api-gateway/src/routes/jobs.ts`.
3. Add it to `FANOUT_AFTER_FORMAT` in `services/orchestrator/src/pipeline.ts` (or wherever it fits in the dependency graph).
4. Add a handler branch in `services/orchestrator/src/index.ts` mirroring the `EVENT_VAD_READY` block: UPDATE the analysis row, INSERT a `stage_completed` event, then call `maybeFinalize`.
5. Add the field to `services/orchestrator/src/aggregate.ts` `buildReport`.
6. Create `services/worker-<name>/` with a Dockerfile, pyproject (or package.json), and worker that consumes `WORK_<NAME>` and publishes `EVENT_<NAME>_READY`.
7. Add the worker to `infra/docker-compose.yml` with the standard `depends_on: { nats-bootstrap, minio-bootstrap }` block.

## Testing

```bash
pnpm -r test            # all Node tests
pnpm smoke              # end-to-end (needs API_TOKEN env var, see make seed)
```

The smoke script (`scripts/smoke.ts`) runs three jobs against a live stack: format-only, format+vad+webhook (with HMAC verify), and the full four-analysis suite. It expects `audio-api-postgres-1` to be reachable for the inline `tenant_secrets` seed.

For Python workers, each has its own `tests/` with pytest. Worker tests that need an audio fixture skip when `tests/fixtures/audio/sample-speech.wav` is missing — drop one in there for full coverage.

## Observability

Grafana on http://localhost:3000 (anonymous admin). Pre-provisioned datasources:

- **Prometheus** — RED metrics (rate, errors, duration) per service, derived from traces by Tempo's metrics-generator. Metric family is `traces_spanmetrics_*`, labelled by `service`, `span_name`, `span_kind`, `status_code`.
- **Tempo** — distributed traces. Search by `service.name`, `trace.id`, or `job.id` if it's set as a span attribute.
- **Loki** — structured logs (Pino on Node, structlog on Python). Filter `{service="orchestrator"}` etc. **Note:** nothing currently ships container stdout into Loki, so this datasource is empty until a log shipper (promtail / OTLP log export) is added.

Pre-provisioned dashboards (folder **Audio API**):

- **Overview (RED)** — per-service throughput, error rate, p95 latency, and a calls-by-operation table.
- **Per-worker detail** — same cut filtered by a `$service` variable, broken down by operation (`span_name`), for drilling into a single worker.

These are populated by Tempo span metrics, so they only show data for services that are actively producing traces. The `trace_id` returned in error responses matches the OTel trace id — use it to find the failing span in Tempo.

## Troubleshooting

**`make migrate` fails with `relation already exists`** — migrations aren't idempotent and you've already run them. The DB is fine. To wipe: `docker compose down -v && make up && make migrate`.

**A worker exits immediately with `stream not found`** — the NATS bootstrap hasn't run. Check `docker compose ps --all` for `audio-api-nats-bootstrap-1` exit code 0. If it failed, check NATS healthcheck (the `-m 8222` monitoring port must be enabled — see compose).

**Job stuck in `running` forever** — the orchestrator merge fixed the original deadlock cause. Look at `job_events` for the latest stage — usually a worker crashed or a `*.ready` event never made it. `docker logs audio-api-<worker>-1` and `nats consumer info AUDIO_EVENTS <worker>` (via `nats-box`) tell you which.

**Webhook never arrives** — confirm `tenant_secrets` row exists for the job's tenant. The worker silently no-ops if the secret is missing. Also check `worker-webhook` logs and that `callback_url` is reachable from inside Docker (use `host.docker.internal` for host-only listeners on Mac/Windows; on Linux you need to add an `extra_hosts` entry).

**`worker-dme-classify` won't start** — needs `class_labels_indices.csv` and `Cnn14_mAP=0.431.pth` baked into the image. The Dockerfile pulls them from the HF mirror at `thelou1s/panns-inference` (Zenodo, the canonical source, is too flaky). If the build hangs, that mirror is down — wait or find another `.pth` mirror.

**`pnpm install` warns about peer dep `vite`** — vitest 4 requires vite 6+ as a peer; the root `package.json` declares `vite` as a devDep so the peer resolves. Don't remove it or audits will flag transitive vite vulns again.

## Repo layout

```
infra/
  docker-compose.yml         all services
  migrations/*.sql           Postgres schema
  nats/bootstrap-streams.sh  JetStream stream creation
  otel/                      collector config
  prometheus/                prometheus.yml (remote-write target for span metrics)
  grafana/                   datasource + dashboard provisioning, tempo config
packages/
  contracts/                 error code catalogue, OpenAPI lint config
  node-common/               shared Node helpers (NATS, DB, S3, OTel, logger)
  py-common/                 shared Python helpers
  proto/                     event schemas + NATS subject constants
services/
  api-gateway/               Fastify ingress
  orchestrator/              state machine + finaliser
  worker-fetcher/            Node — pull source to MinIO
  worker-format/             Python — ffprobe
  worker-vad/                Python — Silero VAD
  worker-language/           Python — faster-whisper
  worker-dme-classify/       Python — PANNs Cnn14
  worker-webhook/            Node — HMAC POST
scripts/
  smoke.ts                   end-to-end test
  seed-token.sh              issue an api_token
docs/
  spec.md                    design spec
  user-guide.md              for API consumers
  technical-guide.md         this file
  diagrams/                  excalidraw architecture + lifecycle
```
