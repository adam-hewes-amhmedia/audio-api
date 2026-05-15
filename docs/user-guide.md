# Audio Processing API — User Guide

For consumers calling the API. If you're running the system, see [`technical-guide.md`](./technical-guide.md).

## Quick example

```bash
TOKEN="your-api-token"

# Submit
curl -X POST http://localhost:8080/v1/jobs \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "input": { "type": "url", "url": "https://example.com/audio.wav" },
    "analyses": ["format", "vad", "language", "dme_classify"]
  }'
# → { "job_id": "j_01KRNV...", "status": "queued" }

# Poll
curl -H "authorization: Bearer $TOKEN" \
  http://localhost:8080/v1/jobs/j_01KRNV...

# Fetch report once status="completed"
curl -H "authorization: Bearer $TOKEN" \
  http://localhost:8080/v1/jobs/j_01KRNV.../results
```

## Authentication

Every endpoint except `/v1/health` requires a Bearer token:

```
Authorization: Bearer <token>
```

Tokens are issued per-tenant and stored hashed (SHA-256) server-side. Treat the token like a password — it identifies the tenant and authorises everything it can do. Token rotation is a re-seed operation (see technical guide).

## Endpoints

### `GET /v1/health`

No auth. Returns service status.

```json
{ "status": "ok", "services": { "api-gateway": { "status": "ok", "version": "dev" } } }
```

### `POST /v1/jobs`

Submit a new analysis job.

**Request body:**

```json
{
  "input":   { "type": "url", "url": "https://example.com/audio.wav" },
  "analyses": ["format", "vad", "language", "dme_classify"],
  "callback_url": "https://your-server.example.com/audio-webhook",
  "mode": "async"
}
```

| Field | Required | Notes |
|---|---|---|
| `input.type` | yes | Only `"url"` supported. |
| `input.url` | yes | HTTP(S) URL. Must be reachable from the worker network. Presigned URLs OK. |
| `analyses` | yes | Non-empty array. See *Available analyses* below. |
| `callback_url` | no | URL to POST the report to when the job finishes. See *Webhooks*. |
| `mode` | no | `"async"` (default) returns immediately. `"sync"` blocks up to `SYNC_TIMEOUT_MS` (default 60s) and returns the final report inline. |

**Response (async, 201):**

```json
{ "job_id": "j_01KRNV...", "status": "queued" }
```

**Response (sync, 200):** the full report (same shape as `/results`).

**Response (sync timeout, 202):** `{ "job_id": "...", "status": "running" }` — switch to polling.

### `GET /v1/jobs/:id`

Job status and per-analysis state.

```json
{
  "job_id": "j_01KRNV...",
  "status": "completed",
  "created_at": "2026-05-15T12:51:27.391Z",
  "started_at": "2026-05-15T12:51:27.877Z",
  "completed_at": "2026-05-15T12:51:56.437Z",
  "analyses": [
    { "name": "format", "status": "completed", "attempts": 0 },
    { "name": "vad", "status": "completed", "attempts": 0 },
    { "name": "language", "status": "completed", "attempts": 0 }
  ]
}
```

`status` ∈ `queued`, `running`, `completed`, `failed`.
Per-analysis `status` ∈ `pending`, `running`, `completed`, `failed`.

### `GET /v1/jobs/:id/results`

The final report. 404 until the job is `completed` or `failed`.

```json
{
  "job_id": "j_01KRNV...",
  "input": { "duration_s": 3.196, "size_bytes": 0 },
  "format": {
    "codec": "pcm_s16le",
    "sample_rate": 44100,
    "channel_count": 2,
    "channel_layout": "stereo",
    "bit_depth": null,
    "channels": [{ "index": 0, "label": "ch0" }, { "index": 1, "label": "ch1" }]
  },
  "vad": {
    "per_channel": [
      { "channel": 0, "speech_ratio": 0.0, "segments": [] },
      { "channel": 1, "speech_ratio": 0.0, "segments": [] }
    ]
  },
  "language": {
    "per_channel": [
      { "channel": 0, "language": "en", "confidence": 0.2649 },
      { "channel": 1, "language": "en", "confidence": 0.2649 }
    ]
  },
  "dme_classify": {
    "per_channel": [
      { "channel": 0, "timeline": [{ "start_ms": 0, "end_ms": 3000, "tag": "music", "confidence": 0.812 }] },
      { "channel": 1, "timeline": [{ "start_ms": 0, "end_ms": 3000, "tag": "dialog", "confidence": 0.755 }] }
    ]
  },
  "failures": []
}
```

Only requested analyses appear. `failures[]` lists per-stage errors when the job partially succeeded.

### `GET /v1/jobs/:id/events`

Audit log of state transitions. Useful for debugging.

```json
{
  "events": [
    { "ts": "2026-05-15T12:51:27.456Z", "kind": "submitted", "stage": null, "payload": { "analyses": ["format","vad"] } },
    { "ts": "2026-05-15T12:51:27.890Z", "kind": "stage_started", "stage": "format", "payload": {} },
    { "ts": "2026-05-15T12:51:30.110Z", "kind": "stage_completed", "stage": "format", "payload": { ... } },
    { "ts": "2026-05-15T12:51:56.437Z", "kind": "stage_completed", "stage": "aggregate", "payload": { "status": "completed" } }
  ]
}
```

## Available analyses

| Name | Returns |
|---|---|
| `format` | Codec, sample rate, channel count, channel layout. Always cheap. |
| `vad` | Per-channel speech segments and `speech_ratio`. Silero model. |
| `language` | Per-channel ISO language code + confidence. faster-whisper-small. |
| `dme_classify` | Per-channel timeline of dialog / music / effects / silence segments. PANNs Cnn14. |

Pricing (when productised) will track these separately. Submit only what you need.

## Webhooks

If you pass `callback_url` on submit, the API POSTs the final report to that URL once the job reaches a terminal state (`completed` or `failed`). The body is the same payload as `GET /v1/jobs/:id/results`, wrapped:

```json
{
  "event": "job.completed",
  "job_id": "j_01KRNV...",
  "status": "completed",
  "report": { /* same as /results */ }
}
```

### HMAC verification

The POST carries an `X-Signature` header:

```
X-Signature: sha256=<hex>
```

Where the hex is `HMAC-SHA256(webhook_secret, raw_request_body)`. Always verify before trusting the payload.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyWebhook(rawBody, headerSignature, secret) {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(headerSignature ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

```python
import hmac, hashlib

def verify_webhook(raw_body: bytes, header_signature: str, secret: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(header_signature or "", expected)
```

The `webhook_secret` is set per-tenant by your administrator (see technical guide). Never accept callbacks without verifying — `callback_url` is in the job submission so anyone with your public webhook URL can spoof posts otherwise.

## Error responses

All errors are JSON with a stable `code` field:

```json
{ "code": "INPUT_UNREACHABLE", "message": "input.url must be reachable", "stage": "fetch", "trace_id": "..." }
```

| Code | HTTP | Retry? | What to do |
|---|---|---|---|
| `INPUT_AUTH_FAILED` | 401 | no | Bad token, or your presigned source URL expired. |
| `INPUT_UNREACHABLE` | 400 | no | Source URL didn't resolve / 4xx / 5xx. |
| `INPUT_UNSUPPORTED_CODEC` | 415 | no | Re-encode to PCM, AAC, or FLAC. |
| `INPUT_TOO_LARGE` | 413 | no | Reduce below `JOB_SIZE_LIMIT_MB`. |
| `FORMAT_PROBE_FAILED` | 422 | yes (once) | Source may be corrupt. |
| `VAD_MODEL_FAILED` | 500 | yes | Transient — retry with backoff. |
| `LANGUAGE_LOW_CONFIDENCE` | 200 | n/a | Not an error — surfaced in the report with low confidence. |
| `DME_CLASSIFY_FAILED` | 500 | yes | Transient model error. |
| `RATE_LIMITED` | 429 | yes | Honour `Retry-After`. |
| `JOB_CANCELLED` | 409 | no | Job was cancelled before it finished. |
| `INTERNAL` | 500 | yes | Unexpected — file the `trace_id` with support. |

## Patterns

### Async with webhook (recommended for files >1MB)

1. POST `/v1/jobs` with `callback_url`.
2. Get back `{ job_id, status: "queued" }`.
3. Continue your work.
4. Webhook arrives — verify HMAC, store report.

### Sync (small files, latency-sensitive)

1. POST `/v1/jobs` with `mode: "sync"`.
2. Wait up to `SYNC_TIMEOUT_MS` (default 60s) for the report inline.
3. If you get a 202 instead, switch to polling.

### Polling fallback

```bash
while true; do
  status=$(curl -s -H "authorization: Bearer $TOKEN" \
    http://localhost:8080/v1/jobs/$JOB_ID | jq -r .status)
  [ "$status" = "completed" ] && break
  [ "$status" = "failed" ] && exit 1
  sleep 2
done
curl -s -H "authorization: Bearer $TOKEN" \
  http://localhost:8080/v1/jobs/$JOB_ID/results
```

Use exponential backoff in production. `dme_classify` and `language` add ~5–15 seconds for short clips, more for long ones.

## Rate limits

Not enforced in v1 (POC). When productised, expect a per-tenant cap with `429` + `Retry-After` headers.
