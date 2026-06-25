# Audio API: Live Subtitling (Stream Resource) — Design Spec

- **Date:** 2026-06-24
- **Owner:** Adam Hewes (AMH Media Limited)
- **Status:** Design approved, ready for implementation planning
  - `output.name` convention added to §3.2 — [PR #6](https://github.com/adam-hewes-amhmedia/audio-api/pull/6) (open, docs-only). Code implementation tracked separately.
- **Positioning:** Portfolio / demo capability. Builds the live-streaming foundation flagged on the v1 roadmap (M4) and lands the first piece of speech intelligence (M3) as a side effect. Internal use first; promotable to production via the same env-only path as the rest of the audio-api.
- **Parent spec:** [`spec.md`](./spec.md)

## 1. Product summary

A new top-level `Stream` resource on the audio-api that pulls a video/audio source from a client-supplied URL (HLS, DASH, or MP4) in any source language, transcribes and translates speech to English in near-real time using self-hosted Whisper, and emits English subtitles via two channels:

- **Live consumption:** WebSocket cue events and a rolling WebVTT/HLS subtitle playlist served over HTTP.
- **Archival artifact:** an EBU-TT-D (TTML) file written to object storage when the stream ends.

**Target latency:** 3 to 5 seconds end-to-end (audio in to cue visible) on live HLS/DASH sources with a low-latency edge configuration. Matches broadcast live-captioning norms (BBC, Sky). For recorded MP4 the figure is meaningless; the pod runs as fast as inference allows.

**Concurrency target:** 2 to 5 simultaneous streams.

**Supported source types (v1):**

- `hls` — HLS manifest URL (`.m3u8`). Live or VOD; ffmpeg follows the playlist.
- `dash` — DASH manifest URL (`.mpd`). Live or VOD; standard wrapper for live fragmented MP4.
- `mp4` — single MP4 file URL. Treated as a bounded source; pod terminates naturally on EOF.

**What it deliberately is not:**

- Not a transcription product. The output is translated English captions only. Source-language transcripts are an internal byproduct, not exposed.
- Not multi-tenant scaled. Single tenant, fixed pod pool, manual scale-up.
- Not a substitute for the file-based `Job` pipeline. Lives alongside it, shares nothing on the hot path.
- Not a push-ingest service. The pod always pulls from a URL the client provides; we never run an inbound media ingest endpoint (no SRT, no RTMP, no WebRTC).

## 2. Architecture

### 2.1 Approach

**Stream-pod model.** One Python process per active stream owns the entire hot path: ffmpeg pull from the source URL, audio decode, VAD-gated buffering, faster-whisper inference, WebSocket fan-out, and live WebVTT segment writing. The pod terminates when the stream ends and writes the final TTML archive to object storage.

Picked over decomposed workers (audio frames over NATS) because the 3-5s latency budget cannot absorb message-bus round-trips at 100ms audio cadence, and over a shared-model inference server because per-pod isolation gives a smaller blast radius and a simpler GPU allocation story at 2-5 streams.

NATS is still used, but only for control-plane traffic: stream lifecycle, pod heartbeats, archive completion events. The audio and caption hot path never touches NATS.

### 2.2 Stack additions

| Component | Lang | Role |
|---|---|---|
| `worker-stream-pod` | Python | The pod. One process per active stream. Owns ffmpeg pull (HLS/DASH/MP4), decode, Whisper inference, WS server, VTT segment writer. |
| `worker-stream-supervisor` | Python | Single process per GPU host. Provisions and reaps pods on instruction from the orchestrator. Maintains a fixed pool. |
| `worker-tt-archiver` | Node/TS | On stream end, reads the rolling VTT, converts to EBU-TT-D, writes to object storage. Stateless. |
| `api-gateway` (extended) | Node/TS | New `/v1/streams` endpoints, WS proxy to active pods, HTTP proxy to live VTT segments. |
| `orchestrator` (extended) | Node/TS | New `Stream` state machine alongside `Job` state machine. |

Nothing existing is rewritten. HLS/DASH/MP4 pull uses `ffmpeg` with its built-in HTTP and HLS/DASH demuxers (already in the base image for `worker-format`).

### 2.3 Service inventory (updated)

```
                       +----------------------+
   client --HTTPS----> |  API Gateway (Node)  |
   browser --WSS-----> |  /v1/streams         |
                       |  WS proxy + VTT pass |
                       +----------+-----------+
                                  |
                  +---------------v---------------+
                  |   Postgres (job + stream)     |
                  +---------------^---------------+
                                  |
              +-------------------+--------------------+
              |      Orchestrator (Node service)       |
              |   Job state machine (existing)         |
              |   Stream state machine (new)           |
              +-------------------+--------------------+
                                  |
                +-----------------v-----------------+
                |   Message Bus (NATS JetStream)    |
                |   control plane only              |
                +-----------------+-----------------+
                                  |
                                  v
                 +--------------------------------+
                 |   worker-stream-supervisor     |  one per GPU host
                 |   provisions / reaps pods      |
                 +----------------+---------------+
                                  |
                  forks / monitors pod processes
                                  |
                                  v
        +-------------------------------------------+
        |  worker-stream-pod  (one per active stream)
        |  ffmpeg pulls URL -> VAD -> Whisper       |
        |  -> WS broadcast + rolling VTT segments   |
        +-------------------------------------------+
                  ^                          |
   pull (HTTPS)   |                          |   WS / HTTP out
   from client    |                          v   (proxied via gateway)
   HLS/DASH/MP4
                                  |
                                  v
                  +----------------+---------------+
                  | Object Storage (MinIO -> R2)   |
                  | rolling VTT segments live here |
                  | final TTML written by archiver |
                  +--------------------------------+
```

### 2.4 Source pull topology

The pod is the HTTP client. On provision it receives the source URL (`hls`, `dash`, or `mp4` plus the URL) and an optional set of headers (forwarded verbatim to ffmpeg for client-side auth — typically `Authorization` or a signed query string already on the URL). ffmpeg opens the URL, follows the manifest or reads the file, and feeds decoded PCM into the inference loop.

No inbound media ports are exposed. The supervisor allocates only a WebSocket port per pod (from a configured range, e.g. 10000-10099) so the gateway can proxy live cues out to clients. All upstream connections (pod → source) are outbound HTTPS from the GPU host's egress.

Source reachability and auth are the client's responsibility. The pod surfaces ffmpeg open/connect failures as `SOURCE_UNREACHABLE` with the upstream HTTP status (where available) in the error payload.

## 3. API surface

REST for control, WebSocket for live cues, HTTP for VTT segments. All under the existing gateway auth (`Authorization: Bearer <token>`).

### 3.1 Endpoints

```
POST   /v1/streams                       # create a stream with a source URL, returns output URLs
GET    /v1/streams/{id}                  # status, current cue count, pod health
DELETE /v1/streams/{id}                  # end the stream, triggers archival
GET    /v1/streams/{id}/captions.vtt     # rolling live WebVTT (HLS-style segmented playlist)
GET    /v1/streams/{id}/captions.ttml    # final EBU-TT-D archive (404 until status=archived)
WS     /v1/streams/{id}/captions         # live WebSocket cue feed
GET    /v1/streams/{id}/events           # audit log
```

### 3.2 Create-stream request

```json
{
  "source": {
    "kind": "hls",
    "url": "https://cdn.example.com/event/master.m3u8",
    "headers": { "Authorization": "Bearer encoder-origin-token" }
  },
  "source_hint": "fr",
  "output": { "target_lang": "en", "name": "fri-night-event" },
  "options": {
    "model_size": "medium",
    "max_cue_chars": 80,
    "min_cue_ms": 800
  },
  "callback_url": "https://client.example.com/hook"
}
```

- `source.kind` is `hls`, `dash`, or `mp4`. Required.
- `source.url` must be `https://` (plain `http://` is rejected unless `STREAM_ALLOW_HTTP=1` is set on the gateway — POC only).
- `source.headers` is optional; key/value strings, forwarded to ffmpeg via `-headers`. Maximum 10 entries, total size capped at 4 KiB. Values are stored encrypted at rest and never logged.
- `source_hint` is optional; Whisper auto-detects but a hint speeds first inference.
- `target_lang` is fixed to `en` for v1 (Whisper translate task only goes to English). Kept in the schema for forward compatibility.
- `model_size` accepts `small`, `medium`, `large-v3`, `distil-large-v3`. Default `medium`. Surfaces a quality vs latency lever for the demo.
- `output.name` is optional and matches the batch-job convention (see spec §3.3): the downloadable caption sidecar (`.vtt`/`.ttml`) defaults to the source URL's basename with its extension dropped (e.g. `.../event/master.m3u8` → `master`), overridable here. Internal object-store keys stay `stream_id`-based; if no basename is derivable from the source URL, it falls back to `stream_id`.

### 3.3 Create-stream response

```json
{
  "stream_id": "s_01HX...",
  "status": "provisioning",
  "source": {
    "kind": "hls",
    "url": "https://cdn.example.com/event/master.m3u8"
  },
  "outputs": {
    "websocket_url": "wss://api/v1/streams/s_01HX.../captions",
    "vtt_url": "https://api/v1/streams/s_01HX.../captions.vtt",
    "ttml_url": "https://api/v1/streams/s_01HX.../captions.ttml"
  }
}
```

The response echoes `source.kind` and `source.url` but never the headers. There is no inbound ingest endpoint to return.

### 3.4 WebSocket cue shape

```json
{
  "event": "cue.finalised",
  "stream_id": "s_01HX...",
  "cue_id": 412,
  "start_ms": 184320,
  "end_ms": 187120,
  "text": "We are now approaching the new terminal.",
  "source_text": "Nous approchons maintenant du nouveau terminal.",
  "confidence": 0.94
}
```

Interim (unstable) cues are also emitted as `cue.interim` with the same shape so a player can show "live typing". The spec is opinionated about this: interim cues never go into the VTT or TTML, only finalised cues do.

### 3.5 Webhook payload (stream lifecycle)

Same HMAC scheme as `Job`. Events: `stream.started`, `stream.ended`, `stream.failed`, `stream.archived`.

## 4. Pipeline and data flow

### 4.1 Pod lifecycle

1. **Create.** Gateway writes `streams` row (status `provisioning`) with `source_kind`, `source_url`, and the encrypted headers blob, publishes `stream.provision.requested` on NATS with the stream id and options. The provision message includes the source descriptor so the supervisor never round-trips back to Postgres for it.
2. **Provision.** A supervisor picks up the message (durable consumer), checks GPU capacity, forks a pod process with the source URL/headers in its environment. Pod loads the model, binds its WebSocket port, registers its endpoint in Postgres, sends `stream.ready`. Gateway flips status to `awaiting_ingest`.
3. **Pull.** Pod starts ffmpeg against the source URL. First successfully decoded audio frame flips status to `active` and emits `stream.started`. For `hls`/`dash` live sources this typically lands within one segment duration; for `mp4` files it lands within a second of provision.
4. **Inference loop.** See 4.2.
5. **End.** Triggered by: explicit `DELETE` from client; ffmpeg EOF (recorded MP4 finished, or live playlist signalled end); ffmpeg upstream failure persistent past retry budget; idle timeout (configurable, default 30s of no decoded audio); or max-duration cap. Pod flushes any pending cues, closes the rolling VTT, emits `stream.ingest.ended` with the appropriate `reason`. Gateway flips status to `ended`.
6. **Archive.** Archiver consumes `stream.ingest.ended`, reads the final cue list from Postgres, renders EBU-TT-D, writes `captions.ttml` to object storage. Emits `stream.archived`. Gateway flips status to `archived`.
7. **Reap.** Supervisor terminates the pod process and frees its WebSocket port.

Status transitions: `provisioning` → `awaiting_ingest` → `active` → `ending` → `ended` → `archived`. Terminal alternatives: `failed` from any state.

The `awaiting_ingest` name is preserved from the previous design but now means "pod has opened the source URL and is waiting for the first decoded audio frame", not "waiting for an inbound encoder to connect".

### 4.2 Inference loop (inside the pod)

```
Source URL (HLS/DASH/MP4) --> ffmpeg pull + decode --> 16kHz mono PCM --> 100ms frames
                                                       |
                                                       v
                                            +----------+----------+
                                            |  Rolling buffer     |  configurable, default 5s
                                            +----------+----------+
                                                       |
                                            VAD (Silero) gates buffer
                                            commit on silence boundary
                                            or max-window (e.g. 8s)
                                                       |
                                                       v
                                            +----------+----------+
                                            |  Whisper translate  |  task=translate
                                            |  target=en          |
                                            +----------+----------+
                                                       |
                                            interim cue while buffer grows
                                            finalised cue on commit
                                                       |
                                                       v
                                            WS broadcaster + VTT segment writer
```

**Segmentation strategy:** chunk on VAD silence boundaries when possible; force-commit at `max_cue_ms` (default 8000) to bound worst-case latency. Whisper's own segmentation timestamps are honoured within a committed chunk to produce multiple cues per inference call when the segment is long.

**Interim vs finalised:** every inference produces a candidate result, broadcast as `cue.interim`. The same chunk re-inferred with a larger context can change. Once the buffer commits, the resulting cues are broadcast as `cue.finalised` and that is what gets written to the VTT and ultimately the TTML.

### 4.3 Rolling WebVTT format

HLS-style segmented WebVTT: a playlist (`captions.vtt`) referencing 6-second WebVTT segment files (`segments/000001.vtt`). Gateway serves the playlist with a short cache TTL so HLS players see new segments as they appear. Pod writes segments to MinIO; gateway streams them through to the client (no public bucket access).

### 4.4 Final EBU-TT-D archive

On `stream.ingest.ended`, the archiver:

1. Loads the full ordered list of finalised cues from Postgres (`stream_cues`).
2. Renders an EBU-TT-D XML document with the standard TTML namespace, region, style, and per-cue `<p>` blocks.
3. Writes to `archives/{stream_id}/captions.ttml` in object storage.
4. Updates `streams.ttml_object` and emits `stream.archived`.

EBU-TT-D rather than raw TTML because it is the broadcast-credible profile and produces something demo-able with Subtitle Edit / Sublime EBU-TT-D viewer.

### 4.5 Concurrency and GPU sharing

A single GPU host runs N pods. Each pod loads its own model instance. For the default `medium` model (~5GB VRAM), a 24GB GPU comfortably holds 4 active pods plus headroom. The supervisor enforces this with a `MAX_PODS` env var.

For larger models (`large-v3` at ~10GB), the supervisor either rejects new streams when capacity is reached or returns a smaller-model fallback (configurable). Single-shared-model inference is a future optimisation, not v1.

Capacity is governed by a single env var, `STREAM_MAX_PODS`, applied per supervisor process. The supervisor refuses to fork beyond this regardless of GPU headroom.

### 4.6 Idempotency, retries, cancellation

- **Pod restart mid-stream:** if a pod crashes, the supervisor detects the missing heartbeat and marks the stream `failed`. There is no resume; the client must create a new stream (which will re-pull from the source URL, possibly missing the gap between failure and recreate for live sources). Already-finalised cues persist in Postgres and are still in the archive.
- **NATS replay of provision message:** the supervisor checks Postgres for an existing pod entry before forking. Duplicate provisions are no-ops.
- **Archiver retries:** standard 3-attempt backoff. Archive failure does not invalidate the stream (the live VTT is still in MinIO and downloadable).
- **Cancel:** `DELETE /v1/streams/{id}` flips status to `ending`, supervisor signals the pod, pod flushes and exits, archiver runs as normal.

## 5. Data model

### 5.1 Postgres additions

```sql
CREATE TABLE streams (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  status          TEXT NOT NULL,
  source_kind     TEXT NOT NULL,            -- hls | dash | mp4
  source_url      TEXT NOT NULL,
  source_headers  BYTEA,                    -- AES-GCM encrypted JSON; key from KMS / env
  source_hint     TEXT,
  target_lang     TEXT NOT NULL DEFAULT 'en',
  options         JSONB NOT NULL DEFAULT '{}',
  callback_url    TEXT,
  pod_id          TEXT,
  ttml_object     TEXT,
  cue_count       INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  archived_at     TIMESTAMPTZ,
  error           JSONB
);
CREATE INDEX ON streams (tenant_id, created_at DESC);
CREATE INDEX ON streams (status) WHERE status IN ('provisioning','awaiting_ingest','active','ending');

CREATE TABLE stream_cues (
  stream_id       TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  cue_id          INT NOT NULL,
  start_ms        INT NOT NULL,
  end_ms          INT NOT NULL,
  text            TEXT NOT NULL,
  source_text     TEXT,
  confidence      REAL,
  PRIMARY KEY (stream_id, cue_id)
);

CREATE TABLE stream_pods (
  pod_id          TEXT PRIMARY KEY,
  supervisor_host TEXT NOT NULL,
  ws_host         TEXT NOT NULL,           -- where the gateway connects to proxy live cues
  ws_port         INT  NOT NULL,
  stream_id       TEXT REFERENCES streams(id) ON DELETE SET NULL,
  status          TEXT NOT NULL,
  last_heartbeat  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON stream_pods (status, last_heartbeat);
```

Cues are written to Postgres on finalisation. The volume is small (a 1-hour stream is ~500-1000 cues), so this is fine in the main DB.

### 5.2 Object storage additions

```
audio-api/
  streams/{stream_id}/segments/00000N.vtt    # rolling live segments, TTL 24h after stream end
  streams/{stream_id}/playlist.vtt           # current playlist, TTL 24h
  archives/{stream_id}/captions.ttml         # EBU-TT-D archive, TTL 30d
```

No audio is persisted, consistent with the earlier decision.

## 6. Observability

Reuses the existing OTel + structured-log + Grafana stack.

- One trace per stream, started at `POST /v1/streams`, propagated to the pod, span per inference call.
- New metrics:
  - `audio_stream_active_count`
  - `audio_stream_inference_duration_seconds{model_size}`
  - `audio_stream_audio_to_cue_latency_seconds` (the headline KPI)
  - `audio_stream_pods_busy{supervisor_host}`
  - `audio_stream_ws_subscribers{stream_id}`
- One Grafana dashboard: "Live Streams". Shows the active count, p95 audio-to-cue latency, GPU utilisation, and WS subscriber count.

Alert: p95 audio-to-cue latency over 8s for more than 1 minute. The headline promise is "broadcast-grade", so violating it warrants a page.

## 7. Error handling

Inherits the error taxonomy from the parent spec. New stable codes:

```
STREAM_PROVISION_FAILED        # no GPU capacity or supervisor offline
SOURCE_UNREACHABLE             # ffmpeg could not open the source URL (DNS, TLS, 4xx, 5xx)
SOURCE_UNSUPPORTED             # URL opened but no usable audio track / unknown container
STREAM_INGEST_TIMEOUT          # source opened but no decodable audio frame within provision_ttl
STREAM_INFERENCE_FAILED        # Whisper model error, repeated
STREAM_POD_CRASHED             # supervisor lost heartbeat
STREAM_ARCHIVE_FAILED          # TTML conversion failed (live VTT still available)
```

`SOURCE_UNREACHABLE` and `SOURCE_UNSUPPORTED` carry the upstream HTTP status (when known) and the ffmpeg error class in the `error` JSON, so clients can distinguish "your token expired" from "your CDN is down".

Stream `failed` is terminal. There is no automatic restart of an active stream; clients must create a new one.

## 8. Deployment

### 8.1 Local POC

Adds two services to `docker-compose.yml`:

- `worker-stream-supervisor`: CPU-only, manages pod forks.
- `worker-stream-pod` is not a long-running compose service; it is spawned by the supervisor on demand. In compose-land, the supervisor and pods share the same container image and the supervisor uses `subprocess`.

CPU mode is supported (Whisper `small` model, 10-15s latency, demonstrably worse but functional). Useful for laptop demos without a GPU.

### 8.2 Production posture

- **Always-on tier:** gateway, orchestrator, supervisor (CPU host, cheap).
- **GPU tier:** RunPod or Vast.ai instance with the pod image and `STREAM_MAX_PODS` configured. Same GPU pool can host `worker-dme-separate` (off-hours) and `worker-stream-pod` (live-show hours) by env-var swap.
- **Outbound egress:** Pods make HTTPS requests to client-hosted CDNs (HLS/DASH manifests, MP4 files). No inbound media ports; only the gateway-to-pod WebSocket port range needs to be reachable inside the GPU host's private network.

### 8.3 Promotion

No code changes from POC to production. Three env additions: `STREAM_SUPERVISOR_GPU_HOST`, `STREAM_WS_PORT_START`/`STREAM_WS_PORT_END`, `STREAM_MAX_PODS`.

## 9. Security

### 9.1 Source auth and URL handling

- Source URLs and optional headers are stored in `streams.source_url` and `streams.source_headers` (the latter AES-GCM encrypted at rest with a key from env or KMS).
- Headers are forwarded verbatim to ffmpeg via `-headers` and never written to logs, traces, or webhook payloads.
- `https://` is required; plain `http://` is rejected unless `STREAM_ALLOW_HTTP=1` (POC only).
- Outbound DNS resolution and connection target validation prevent SSRF: the pod refuses to fetch RFC1918, loopback, link-local, or metadata-service addresses (default deny; configurable allow-list for self-hosted CDNs on the same private network).
- Stream IDs are ULIDs and not enumerable.

### 9.2 WebSocket and HTTP auth

- WS connection authenticates with the same bearer token as REST; rejected otherwise.
- VTT segment URLs are served through the gateway (no public MinIO), so they inherit token auth.

### 9.3 Resource exhaustion

- Per-tenant cap on concurrent streams (default 2) enforced at `POST /v1/streams`.
- Per-stream max duration (default 4 hours) enforced by the pod; auto-ends at the limit.
- WebSocket subscriber cap per stream (default 50) to keep fan-out bounded.

## 10. Testing strategy

### 10.1 Unit

- Pod: VAD chunker (silence-boundary detection on fixture audio), TTML renderer (cues in, XML out), WS broadcaster (subscribe/unsubscribe semantics).
- Supervisor: pod allocation, heartbeat reaping.

### 10.2 Integration

Compose-driven, real stack.

1. End-to-end happy path (HLS live): a local nginx-rtmp-hls fixture serves a 30s French clip as a low-latency HLS playlist; assert ≥1 `cue.text` contains expected English token within 8s.
2. End-to-end happy path (MP4 file): pod is given a URL to a 30s French MP4 fixture served by a local HTTP server; assert cues stream until ffmpeg hits EOF, then stream auto-ends and archive lands.
3. Provision failure: cap MAX_PODS at 0, assert 503 + `STREAM_PROVISION_FAILED`.
4. Source unreachable: bogus URL, assert stream flips to `failed` with `SOURCE_UNREACHABLE` and the upstream HTTP status in the error payload.
5. Cancel mid-stream: `DELETE`, assert pod exits cleanly and partial archive lands.
6. Two concurrent streams (one HLS, one MP4): assert no cue cross-contamination, both archives correct.

### 10.3 Quality benchmark (one-shot, manual)

- Fixed 5-minute French news fixture with a known-good reference English translation.
- Compute BLEU or chrF against the reference for `small`, `medium`, `large-v3`.
- Publish numbers in the README. Not a CI gate; a sanity check before demos.

### 10.4 Latency benchmark (in smoke)

Smoke test adds a "live" check: start a stream pointed at the local HLS fixture endpoint, measure first-cue-received-at minus first-segment-published-at. Assert under 8s. Records the median to a Grafana metric for trend visibility.

## 11. Open questions

1. **HLS low-latency edge.** Whether stock ffmpeg HLS demuxer hits the 3-5s target on LL-HLS sources, or whether we need `-hls_init_time`/`-live_start_index` tweaks, needs a measurement spike before tuning is committed.
2. **Distil-Whisper viability for French translate.** Distil-Whisper is officially English-focused; whether the FR→EN translate task quality is acceptable needs measuring, not assuming.
3. **Restart semantics.** Current spec says "no resume". A future enhancement could let a new stream pick up at a known offset of the same source URL (`?start_offset=...`). Out of scope for now.
4. **SSRF allow-list shape.** Default deny on private ranges is right; whether per-tenant CIDR allow-lists are worth building for self-hosted CDNs on the same VPC is open.

## 12. Out of scope (and why)

| Item | Why |
|---|---|
| Source languages other than French in v1 | Whisper translate handles all source languages; we just don't advertise it. Documentation choice, not engineering. Can be unlocked by changing the marketing copy. |
| Output languages other than English | Whisper task=translate is hard-wired to English. True multi-target needs a separate translation step (NLLB or Marian) post-transcribe. Roadmap. |
| Speaker labels in cues | Diarisation is a different model family. Aligned with parent spec roadmap M3/M4. |
| Burnt-in subtitles on a re-muxed video output | Out of scope per the original brainstorm; sidecar only. |
| Push ingest (SRT, RTMP, WebRTC) | We pull from a URL the client provides. Push ingest needs an inbound media tier (SRT proxy, RTMP server, SFU) and changes the operational shape considerably. |
| Resume / reconnect mid-stream | See open question 3. |
| Multi-tenant scaling | Parent spec roadmap M5. |
| Speech-to-text exposed as a transcript endpoint | Adjacent product; deliberately not in scope to keep focus. |

## 13. Assumptions

- Demo GPU host has at least one NVIDIA card with 16GB+ VRAM. 24GB recommended to comfortably run 4 `medium` pods.
- ffmpeg with HTTPS, HLS, and DASH demuxer support is available in the base Python worker image (true of the stock Debian/Ubuntu ffmpeg packages used by `worker-format`).
- The parent audio-api is deployed (gateway, orchestrator, Postgres, NATS, MinIO) and this feature is additive.

## 14. Success criteria

- One end-to-end smoke run: a French fixture clip served as HLS on the local network is consumed by the deployed POC and produces English cues over WebSocket within 8 seconds of the first segment publishing, with a valid EBU-TT-D archive after stream end. A second smoke run with the same fixture served as an MP4 file URL produces a complete archive once ffmpeg hits EOF.
- p95 audio-to-cue latency under 5s on the `medium` model with a single active stream on the demo GPU host.
- Four concurrent streams sustainable for 10 minutes on the demo GPU host without queue depth growth.
- New worker added (`worker-stream-pod` plus supervisor) following the existing worker template; no edits to existing services beyond the gateway and orchestrator.
- Same security gate set as the parent spec passes on every PR.
