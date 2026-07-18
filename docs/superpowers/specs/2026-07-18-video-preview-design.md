# Video preview in the ops console (Video.js + pod HLS)

*Design spec. 2026-07-18.*

## Problem

The ops console shows a stream's live captions (SSE, shipped 2026-07-18) but no
video. To sanity-check that the right video is flowing and that the captions
match what's being said, an operator wants to watch the stream alongside the
subtitles, in the console.

Two things make this non-trivial:

- **Sources aren't browser-playable.** A source can be SRT (a UDP transport a
  browser cannot play at all), or HLS/DASH/MP4 over HTTP. Even for HTTP, the
  admin API redacts the source URL to origin + pathname (`mappers.ts` `redactUrl`)
  because the query string on a signed manifest is a credential, so the URL the
  console holds usually won't play. And a source origin need not allow the
  console's origin (CORS).
- **The pod discards video.** The pod's ffmpeg runs with `-vn`
  (`audio_source.py`), keeping only 16 kHz mono audio for Whisper. Any video
  preview means the pod must stop discarding video and produce a video output.

## Approach

The pod produces a browser-playable **HLS video rendition** of every stream and
serves it on a new HTTP port; the gateway proxies that port under the admin
scope; the console plays it with **Video.js**. The console always plays the
pod's own same-origin HLS, so the source's redaction / CORS / signing never
matter, and one code path covers SRT, HLS, DASH and MP4 alike.

```
source (SRT / HLS / DASH / MP4)
  └─ pod
       ├─ primary ffmpeg: audio (-vn) → Whisper → captions   (unchanged)
       │     └─ (SRT only) extra output: -map 0 -c copy -f mpegts udp://127.0.0.1:RELAY
       └─ preview ffmpeg (ISOLATED, separate process):
       │     pull sources (hls/dash/mp4) → opens the source URL directly
       │     SRT                         → reads udp://127.0.0.1:RELAY
       │     → -map 0:v:0? -c:v copy → rolling HLS on local disk
       └─ pod HLS HTTP server on POD_HLS_PORT (parallel to the captions WS)
            └─ gateway  GET /v1/admin/streams/:id/preview/*   (proxies pod_host:hls_port)
                 └─ Next proxy (same-origin, admin bearer server-side, binary passthrough)
                      └─ console  Video.js  ← /api/admin/streams/:id/preview/index.m3u8
```

The serving half (pod HTTP port → gateway proxy → console) is the captions WS
bridge again, HTTP instead of WebSocket. The generation half runs the preview as
its **own ffmpeg process**, isolated from the audio pipeline that feeds captions.

### Decided tradeoffs (all confirmed in brainstorming)

- **Player:** Video.js.
- **Source:** unified — the console always plays the pod's HLS, for every source
  kind. Not direct-play of the source URL (which reintroduces redaction / CORS /
  signing).
- **SRT:** same pod-HLS path. Not a dedicated media server (that would
  re-architect SRT termination, relocate the SRT passphrase, add a secured
  internet-facing service, and rebuild provisioning — too much blast radius for
  an ops preview whose only win would be sub-second latency).
- **Generation:** always-on, **stream-copy** (`-c:v copy`), produced by an
  **isolated preview ffmpeg** — not a second output on the audio ffmpeg. A shared
  output would couple the preview to captions: a source with no video track
  (audio-only, a legitimate input for a transcription API) fails a mandatory
  video output and would take the whole ffmpeg (and captions) down with it. The
  isolated process guarantees the preview can never break captions. For pull
  sources it opens the source URL independently; for SRT (a single, un-reopenable
  connection) the primary ffmpeg copies the full TS to a local UDP relay
  (`-map 0 -c copy`, so it never fails on audio-only) and the preview ffmpeg reads
  that relay. Copy is cheap for H.264 (the broadcast norm); a rolling window keeps
  disk bounded; non-H.264 or audio-only sources degrade to "no preview."
- **Display:** side-by-side — video player next to the existing live captions
  panel. No overlay, no cue-to-video time-sync (HLS runs seconds behind with its
  own clock; frame-accurate sync is impossible through HLS and not worth it).
- **Serving:** pod HTTP HLS port proxied by the gateway, **not** the object
  store. Mirrors the captions bridge, needs no upload bandwidth or storage
  lifecycle, and is naturally live-only.

## Component 1: Pod — isolated preview ffmpeg + HLS server

- **Isolated preview ffmpeg** (a new module, a separate `asyncio.subprocess` from
  the `FfmpegSource` audio process). Output:
  `-map 0:v:0? -c:v copy -c:a aac? -f hls -hls_time 2 -hls_list_size 6 -hls_flags delete_segments+append_list+omit_endlist <dir>/index.m3u8`.
  Its input depends on source kind:
  - **Pull sources (hls/dash/mp4):** `-i <source_url>` (with the same headers/opts
    the audio ffmpeg uses). It re-opens the source independently.
  - **SRT (caller/listener):** it reads a local relay, `-i udp://127.0.0.1:<relay>`.
    The **primary audio ffmpeg** gains one extra output for SRT sources only:
    `-map 0 -c copy -f mpegts udp://127.0.0.1:<relay>` — this maps every stream
    (so it never fails on an audio-only source) and writing to a UDP socket with
    no reader never blocks or fails, so the audio pipeline is unaffected if the
    preview ffmpeg dies. The relay port is loopback-only.
- `-c:v copy` — no re-encode. Non-browser-decodable or audio-only sources make
  only the isolated preview ffmpeg fail; captions are never affected.
  Transcode-to-a-safe-profile is out of scope for v1.
- Rolling window via `delete_segments` (~6 × 2 s = ~12 s on disk). Local disk
  only; no object-store writes for video. The preview ffmpeg's failure/exit is
  logged and left non-fatal to the stream (retry/backoff optional in v1).
- New **HLS HTTP server** in the pod: a small asyncio static file server
  (parallel to the captions WS server) serving the local HLS directory
  (`index.m3u8` + `seg-*.ts`) on `POD_HLS_PORT`, bound to the pod interface like
  the WS server. It serves only the two content types and only files inside the
  HLS dir (no path traversal).

## Component 2: Supervisor + migration

- Migration `infra/migrations/0010_stream_pods_hls_port.sql`:
  `ALTER TABLE stream_pods ADD COLUMN hls_port INT;` (nullable; NULL = pod
  predates the column / no preview). **Numbering note:** `main` is at `0009`; the
  unmerged admin-settings branch (PR #18) already uses `0010_settings.sql`, so if
  that lands first this must be renumbered to the next free value (`0011`). Pick
  the number at implementation time against the current `main`.
- Supervisor
  (`services/worker-stream-supervisor/src/worker_stream_supervisor/worker.py`):
  add an `hls` `PortPool` (env `STREAM_HLS_PORT_START` / `STREAM_HLS_PORT_END`,
  e.g. 10100–10109), allocate one per provision alongside `ws_port`, pass
  `POD_HLS_PORT` into `spawn_env`, and record `hls_port` in the `stream_pods`
  upsert. Free it on teardown / provision failure with the other pools. Mirrors
  `ws_port` exactly.

## Component 3: Gateway — preview proxy routes

- New router `services/api-gateway/src/routes/admin/preview.ts`, registered under
  the admin scope (inherits `requireAdmin` + rate limit):
  - `GET /v1/admin/streams/:id/preview/index.m3u8`
  - `GET /v1/admin/streams/:id/preview/:segment`
- Each looks up the pod (`hls_host`/`hls_port`, cross-tenant, pod
  `ready`/`ingesting`, `hls_port` not null), fetches
  `http://host:hls_port/<path>`, and streams the body back with the upstream
  content type (`application/vnd.apple.mpegurl` for the playlist, `video/mp2t`
  for segments). Binary passthrough — no buffering.
- `:segment` is validated against `^seg-[0-9]+\.ts$` (or the exact ffmpeg
  segment pattern) so the route cannot be used to fetch arbitrary pod paths.
- No live pod / no `hls_port` → `404` JSON `{code:"ADMIN_PREVIEW_NOT_LIVE"}`; the
  console shows "no preview."
- Audit `stream.preview.view` once, on the playlist request only (viewing
  customer video is sensitive; segments are polled and would spam the audit
  table), mirroring `stream.captions.stream`.
- Documented in `packages/contracts/openapi-admin.yaml` (both routes;
  `application/vnd.apple.mpegurl` and `video/mp2t` responses).

## Component 4: Console — Video.js, layout, proxy

- Add the `video.js` dependency (v8 bundles `@videojs/http-streaming`, which
  plays `.m3u8` via MSE on Chromium/Firefox and natively on Safari — no separate
  hls.js).
- New client component `components/VideoPreview.tsx`: mounts a Video.js player on
  `/api/admin/streams/:id/preview/index.m3u8`, gated on **pod readiness** (the
  same `canStream` boolean the captions feed uses), and disposes the player on
  unmount and when the pod goes away. Shows a "no preview" placeholder when not
  streamable or on a load error.
- **Layout** (`app/streams/[id]/page.tsx`): top row = video player (left, wider,
  e.g. md=8) + live captions panel (right, md=4); second row = Source / Pod /
  lifecycle cards. Restructure the existing three-column grid accordingly.
- **Next proxy** (`app/api/admin/[...path]/route.ts`): extend the existing
  streaming branch (added for SSE) to also pass through
  `application/vnd.apple.mpegurl` and `video/*` as streams, instead of buffering
  them with `.text()` (which corrupts binary segments). HLS playlists use
  relative segment names, so `seg-*.ts` requests resolve back through the same
  `/api/admin/streams/:id/preview/` path automatically; the admin bearer stays
  server-side exactly as today.

## Lifecycle / errors

- **Live-only.** The preview exists while the pod is ready. When the stream ends,
  the pod and its HLS server go away, the player stops, and the console shows no
  preview. Ended/archived streams show no video, consistent with captions showing
  history only.
- **Isolation.** The preview is a separate ffmpeg output, a separate pod server,
  and a separate proxy route. A preview failure never affects captions, the audio
  pipeline, NATS, or stream state.

## Scope / non-goals

- Ops console only; no tenant-facing preview.
- Stream-copy only in v1 → non-H.264 sources won't render video (transcode is a
  possible later addition).
- No overlay / cue-to-video sync, no recording, no seek/DVR beyond the ~12 s
  rolling buffer.
- No change to captions, the object store, or NATS.

## Testing

- **Pod:** unit tests that the preview ffmpeg argv is built correctly per source
  kind (pull → `-i <url>`; SRT → `-i udp://127.0.0.1:<relay>`) with the HLS output
  flags; that the primary audio ffmpeg gains the relay output for SRT only and is
  unchanged for pull sources (so an audio-only source can't break captions); and
  that the HLS server serves a file from its dir and rejects paths outside it.
  TDD.
- **Supervisor:** `hls_port` allocated, passed as env, written to `stream_pods`,
  freed on teardown and on provision failure; exhausted pool degrades gracefully
  (no `hls_port`, stream still starts).
- **Gateway:** preview routes proxy the playlist and a segment from a fake pod
  HLS server (mirrors `streams-ws.test`); not-live → 404
  `ADMIN_PREVIEW_NOT_LIVE`; segment name validation rejects traversal; auth sweep
  and openapi contract cover the new routes.
- **Console:** typecheck + lint; live e2e watching both an SRT and an HLS stream.

## Files touched

**audio-api** (`C:\dev\audio-api`)

- `services/worker-stream-pod/.../audio_source.py` — SRT-only relay output on the
  primary ffmpeg (`-map 0 -c copy -f mpegts udp://127.0.0.1:<relay>`).
- `services/worker-stream-pod/.../` new isolated preview-ffmpeg module (URL for
  pull sources, relay for SRT) + new HLS HTTP server module + wiring in
  `worker.py`.
- `infra/migrations/0010_stream_pods_hls_port.sql` — new column (or next free number; see numbering note).
- `services/worker-stream-supervisor/.../worker.py` — `hls` port pool + env +
  `stream_pods` write.
- `services/api-gateway/src/routes/admin/preview.ts` — new proxy router.
- `services/api-gateway/src/routes/admin/index.ts` — register it.
- `services/api-gateway/tests/admin-preview.test.ts` — new.
- `packages/contracts/openapi-admin.yaml` — document the routes.

**audio-api-console** (`C:\dev\audio-api-console`)

- `package.json` — add `video.js`.
- `components/VideoPreview.tsx` — new player component.
- `app/streams/[id]/page.tsx` — layout + mount the player.
- `app/api/admin/[...path]/route.ts` — stream HLS/binary bodies through.

Both repos on `main`; do the work on `feat/video-preview` in each. Don't merge or
push without Adam's say-so.
