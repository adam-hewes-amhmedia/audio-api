# Plan 6: Real Transcription (ffmpeg + Whisper Pull) — Design Spec

- **Date:** 2026-06-25
- **Owner:** Adam Hewes (AMH Media Limited)
- **Status:** Design approved; reconciled 2026-06-26 with the task plan and repo reality (see the change note at the end of §3).
- **Parent design:** [`../../live-subtitles-design.md`](../../live-subtitles-design.md) — the live-subtitling design of record. This spec scopes and details the slice that Plan 6 implements; it does not restate the parent.
- **Replaces:** the `StubCueSource` placeholder introduced in Plan 5 (`worker-stream-pod`).

## 1. Goal

Replace the stubbed pod hot path with the real pipeline: pull the client source URL with ffmpeg, decode to audio, gate with VAD, transcribe-and-translate to English with faster-whisper, and emit interim + finalised cues — plus the two persisted artifacts the parent design promises (rolling live WebVTT segments and an end-of-stream EBU-TT-D TTML archive).

After Plan 6, a real HLS/DASH/MP4 source produces real English captions over the existing WebSocket / NATS / DB paths, with no API or contract changes.

## 2. Scope

**In scope (full pod per parent design §4.3–4.5):**

- ffmpeg pull for `hls`, `dash`, `mp4`; decode to 16 kHz mono PCM.
- Silero VAD gating.
- faster-whisper `task=translate` inference (English output).
- Interim cues (`cue.interim`) and finalised cues (`cue.finalised`).
- Rolling HLS-style WebVTT segment writer to object storage (in-pod).
- EBU-TT-D TTML archive on stream end, produced by a separate `worker-tt-archiver` Node service (parent design §2.2/§4.4) — not in-pod.
- Real lifecycle transitions (`active` on first frame; real end reasons) and the parent design's error codes.
- AES-GCM encryption of `source_headers` at rest (parent design §9.1): a gateway-side seal plus migration `0006`.
- SSRF default-deny guard (parent design §9.1) enforced before ffmpeg opens any URL.
- Pod consumes the source headers the supervisor already forwards (so ffmpeg can auth to the source).

**Out of scope (future plans):**

- Output languages other than English (Whisper translate is English-only).
- Burnt-in / re-muxed video output (sidecar captions only).
- Multi-tenant autoscaling beyond the fixed `STREAM_MAX_PODS` pool.
- A shared/multiplexed inference server (per-pod model instance is retained).

## 3. Key decisions

1. **Scope = full pod, minus the TTML archive.** Plan 6 delivers real cues, interim cues, and the in-pod VTT segment writer in one plan, staged internally (see §12). The EBU-TT-D archive runs in a separate `worker-tt-archiver` Node service (see §4), so the live caption path and the end-of-stream archive fail independently and the archive survives a pod crash.
2. **Streaming algorithm = periodic re-infer of the open buffer.** Every `POD_INTERIM_INTERVAL_MS` (default 1000 ms) the assembler re-runs Whisper over audio accumulated since the last commit and broadcasts the result as `cue.interim`. The buffer commits to `cue.finalised` on a VAD silence boundary or when it reaches `POD_MAX_CUE_MS` (default 8000 ms), whichever comes first. Buffer length is bounded by `POD_MAX_CUE_MS`, so per-tick inference cost is bounded.
3. **ASR behind a `Transcriber` interface.** Unit tests inject a deterministic fake; the real `FasterWhisperTranscriber` is exercised only by a single gated E2E (CPU, tiny/small model, short clip) that does **not** run in the default per-PR CI.
4. **Source-failure status semantics.** Source problems are uniformly terminal-`failed`: an open failure (`SOURCE_UNREACHABLE`) and a persistent mid-stream failure (`source_failed`) both set stream status `failed`. Only clean terminations — `source_eof`, `client_delete`, `idle_timeout`, `max_duration` — set status `ended`. (End-reason values match the existing `stream-ingest-ended` enum: `source_eof`, not `eof`.)

**Change note (reconciled 2026-06-26).** Three points were corrected against the parent design of record and the actual repo state:
- **TTML moves out of the pod** into a `worker-tt-archiver` Node service (parent §2.2/§4.4). The pod keeps only the live VTT writer.
- **`source_headers` are encrypted at rest** (parent §9.1) via a gateway seal + migration `0006`. This supersedes the earlier "no DB-schema changes" success criterion in §13.
- **An SSRF guard is in scope** (parent §9.1), enforced before any ffmpeg open.

The headers handoff in §10 was also corrected: the supervisor already forwards headers from the NATS provision message (env `SOURCE_HEADERS_JSON`); it does not read or decrypt the DB copy, and needs no change in Plan 6.

## 4. Component decomposition

All new modules live in `services/worker-stream-pod/src/worker_stream_pod/`. `worker.py` keeps its role as orchestrator (NATS connect, WS server, DB writes, lifecycle, heartbeat); the pipeline slots behind the same `cues()`-style seam the stub uses today.

| Module | Responsibility | Depends on |
|---|---|---|
| `audio_source.py` | Spawn ffmpeg against `SOURCE_URL` with kind-aware flags and `-headers`; decode to 16 kHz mono s16le PCM on stdout; yield 100 ms frames. Signal first-frame and EOF. Surface ffmpeg open/exit failures with parsed upstream status. | ffmpeg subprocess |
| `vad_gate.py` | Silero VAD over frames; maintain the open buffer; signal `silence_boundary` and `max_window_reached`. | silero (torch) |
| `transcriber.py` | `Transcriber` protocol + `FasterWhisperTranscriber` (`task=translate`, model from `POD_MODEL_SIZE`, device/compute from env). PCM buffer → list of `Segment(text, source_text, start_ms, end_ms, confidence)`. | faster-whisper |
| `cue_assembler.py` | The streaming loop: drive frames → VAD; on each interim tick re-infer the open buffer → interim cue; on commit → finalised cues (honouring Whisper per-segment timestamps; multiple cues per long commit). Yields `(Cue, is_final)`. | `vad_gate`, `transcriber` |
| `vtt_writer.py` | Rolling HLS-style WebVTT: append finalised cues into `POD_VTT_SEGMENT_S` (6 s) segment files + playlist; upload to object store under `streams/{id}/segments/…` and `streams/{id}/playlist.vtt`. | object store (`py_common.storage`) |

The EBU-TT-D archive is **not** a pod module. A separate `worker-tt-archiver` Node service consumes `stream.ingest.ended`, loads the finalised cues from `stream_cues`, renders EBU-TT-D, writes `archives/{id}/captions.ttml`, sets `streams.ttml_object`/`archived_at`, and publishes a new `STREAM_ARCHIVED` subject. The orchestrator already drives the `ended → archived` transition on that event once subscribed. The service reuses `packages/node-common/src/storage.ts`.

`worker.py` changes are additive: load the model before marking `ready`; drive `cue_assembler` instead of `StubCueSource`; branch the fan-out so interim cues go to **WS only** (ephemeral, never persisted, no NATS subject), while finalised cues take the full existing path (WS + NATS `STREAM_CUE_FINALISED` + `stream_cues` insert + `cue_count` bump) **plus** the VTT writer. The pod does not write TTML.

The `Cue` dataclass (`cue_emitter.py`) already carries `source_text` and `confidence`; no schema or contract change. `StubCueSource` is retained for tests/local fallback behind an env flag (`POD_USE_STUB=1`).

## 5. Interfaces

```python
# transcriber.py
@dataclass
class Segment:
    text: str            # English (translate task output)
    source_text: str     # source-language transcript byproduct (internal only)
    start_ms: int
    end_ms: int
    confidence: float | None

class Transcriber(Protocol):
    def transcribe(self, pcm: bytes, *, base_offset_ms: int) -> list[Segment]: ...
```

- `FasterWhisperTranscriber` implements `transcribe` with `task="translate"`, `language=source_hint or None`, returning segments offset by `base_offset_ms` (the open buffer's start time within the stream).
- The fake transcriber returns scripted segments keyed to fixture audio length, deterministic for unit tests.

The VAD gate, VTT writer, and TTML renderer are likewise plain classes with narrow inputs (frames in / boundary signals out; cues in / segment bytes out; cues in / XML out) so each is testable without ffmpeg or a model.

## 6. Data flow

```
ffmpeg(SOURCE_URL, -headers) → PCM 16kHz mono → 100ms frames
  → VadGate (accumulate until silence_boundary | max_window_reached)
  → CueAssembler:
       every POD_INTERIM_INTERVAL_MS → transcribe(open_buffer) → cue.interim
       on commit boundary            → transcribe(committed)   → cue.finalised(s)
  → worker.py fan-out:
       interim   → WS broadcast only (ephemeral; no NATS, no DB)
       finalised → WS broadcast + NATS STREAM_CUE_FINALISED + stream_cues INSERT + cue_count++ + VttWriter.append
  → on end → STREAM_INGEST_ENDED
                → worker-tt-archiver (Node) renders EBU-TT-D from stream_cues → archives/{id}/captions.ttml → STREAM_ARCHIVED
```

## 7. Lifecycle integration

- **Model warm before `ready`.** Load the faster-whisper model first; only then set `stream_pods.status='ready'` and emit `stream.ready`. A load failure fails provisioning (`STREAM_PROVISION_FAILED`).
- **`active` on first real frame.** `audio_source`'s first decoded PCM frame triggers `reporter.mark_started()` → `active` + `stream.started`. The Plan 5 `FIRST_PACKET_DELAY_S` sleep is removed.
- **End reasons** (replace the hardcoded `client_delete`): `client_delete` (SIGTERM), `source_eof` (mp4 finished / live playlist end), `idle_timeout` (default `POD_IDLE_TIMEOUT_S=30` s with no decoded audio), `max_duration` (`POD_MAX_DURATION_S` cap), `source_failed` (persistent ffmpeg failure past retry budget). On any end the pod: flushes pending finalised cues → finalises/uploads the current VTT segment + playlist → `mark_ended(reason, cue_count)` (which emits `STREAM_INGEST_ENDED`). The TTML archive is then produced asynchronously by `worker-tt-archiver`, not the pod.

## 8. Error handling

| Condition | Behaviour | Status |
|---|---|---|
| ffmpeg cannot open URL (DNS/TLS/4xx/5xx) | Parse upstream status + ffmpeg error class → `SOURCE_UNREACHABLE` in payload → `stream.failed` | `failed` |
| Unsupported codec/container | `SOURCE_UNSUPPORTED` | `failed` |
| ffmpeg dies mid-stream | hls/dash: reconnect within retry budget; mp4: EOF = success. Persistent past budget → `source_failed` | `failed` (if exhausted) |
| Whisper inference throws | Retry once; repeated → `STREAM_INFERENCE_FAILED` | `failed` |
| Idle (no decoded audio) past `POD_IDLE_TIMEOUT_S` | Clean stop, `idle_timeout` | `ended` |
| Source headers | Forwarded to ffmpeg via `-headers`; never logged, traced, or echoed (asserted in tests) | — |

## 9. Config / env (pod)

All defaulted; per-stream values (`model_size`, `source_hint`, headers) arrive from the supervisor.

| Var | Default | Purpose |
|---|---|---|
| `WHISPER_DEVICE` | `cuda` (prod) / `cpu` (dev) | Inference device |
| `WHISPER_COMPUTE_TYPE` | `float16` / `int8` | Precision per device |
| `MODEL_CACHE_DIR` | image path | Model download cache |
| `POD_MODEL_SIZE` | `medium` | faster-whisper model (`small`/`medium`/`large-v3`/`distil-large-v3`) |
| `POD_INTERIM_INTERVAL_MS` | `1000` | Interim re-infer cadence |
| `POD_MAX_CUE_MS` | `8000` | Force-commit window (latency bound) |
| `POD_IDLE_TIMEOUT_S` | `30` | No-audio end trigger |
| `POD_MAX_DURATION_S` | (unset = no cap) | Hard duration cap |
| `POD_VTT_SEGMENT_S` | `6` | WebVTT segment length |
| `POD_USE_STUB` | `0` | Fall back to `StubCueSource` (tests/local) |
| Silero VAD thresholds | sensible defaults | Speech/silence detection tuning |

## 10. Source-headers handoff and encryption at rest

The supervisor **already** forwards the source headers to the pod: it reads them from the NATS provision message (not the DB) and sets the pod env `SOURCE_HEADERS_JSON`. So no supervisor change is needed in Plan 6. Plan 6's pod work is to **consume** `SOURCE_HEADERS_JSON` and forward it to ffmpeg via `-headers` (CRLF-joined).

Encryption at rest is a gateway concern: the gateway seals `source.headers` with AES-256-GCM (`STREAM_HEADERS_KEY`) and stores the ciphertext in `streams.source_headers` (`BYTEA`, migration `0006`). The supervisor and pod never read that column, so neither decrypts anything — the message-borne headers are the only copy they touch.

Headers are never written to logs, traces, status rows, or webhook payloads (asserted in tests).

## 11. Testing

- **Unit (default CI, fast, deterministic):**
  - `vad_gate`: silence-boundary and max-window detection over fixture PCM.
  - `cue_assembler`: interim/commit logic with the **fake** `Transcriber` — asserts interim cadence, commit on silence vs `max_cue_ms`, monotonically increasing `cue_id`, and that interims never persist.
  - `vtt_writer`: cues in → valid WebVTT segments + playlist.
  - `audio_source`: ffmpeg invocation/flags and error-status parsing (ffmpeg stubbed/short fixture); headers never logged.
  - SSRF guard: private/loopback/link-local/metadata targets rejected; public + allow-listed CIDRs pass.
  - `worker-tt-archiver` (Node): `renderEbuTtD` cues in → valid EBU-TT-D XML; archive handler writes TTML + emits `STREAM_ARCHIVED`, with 3-attempt retry on store failure.
- **Integration (default CI):** drive the pod with the fake transcriber against a short fixture audio file end-to-end (provision → active → cues → VTT written → ended → `worker-tt-archiver` writes TTML → archived), reusing the existing test DB/NATS setup.
- **Gated real E2E (manual / scheduled, not per-PR):** a local nginx-hls (or file) fixture serves a ~30 s French clip; run the pod with `FasterWhisperTranscriber` on CPU tiny/small; assert ≥1 finalised cue contains an expected English token within the latency budget. Guarded by a workflow input / pytest marker so it never gates normal PRs.

## 12. Staged implementation outline (for writing-plans to expand)

1. `Transcriber` interface + fake; `cue_assembler` interim/commit loop (unit-tested against the fake). No ffmpeg/model yet.
2. `audio_source` (ffmpeg pull + decode + frames + first-frame/EOF/error parsing).
3. `vad_gate` (Silero) wired into the assembler.
4. `FasterWhisperTranscriber` (real model, device/compute config) behind the interface.
5. `vtt_writer` sink; `worker.py` fan-out branch (interim WS-only vs finalised) and lifecycle/end-reason rework; pod consumes `SOURCE_HEADERS_JSON` → ffmpeg `-headers`.
6. Header encryption at rest (gateway seal + migration `0006`) and the SSRF guard. These precede the first real fetch in (2).
7. `worker-tt-archiver` Node service (EBU-TT-D) + `STREAM_ARCHIVED` subject + orchestrator subscription; gateway VTT/TTML HTTP proxy.
8. Gated real-model E2E + dev/compose wiring (CPU model, fixture).

## 13. Success criteria

- A real `mp4`/`hls`/`dash` source produces English `cue.finalised` events over WS and NATS, persisted to `stream_cues`, with a readable rolling `captions.vtt` and a final `archive.ttml` in object storage.
- `active` reflects the first decoded frame; end reason reflects the real cause; source failures surface as `failed` with the documented error codes; headers never leak.
- Default CI stays fast and deterministic (fake transcriber); the real model path is covered by the gated E2E.
- `source_headers` are encrypted at rest (`BYTEA`, migration `0006`) and never leak; the SSRF guard blocks private/metadata targets.
- No public REST API changes. The only contract/schema additions are migration `0006` (header encryption) and the `STREAM_ARCHIVED` NATS subject (for `worker-tt-archiver`); interim cues stay WS-only and add no subject.
