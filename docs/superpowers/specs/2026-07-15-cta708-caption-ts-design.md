# CTA-708 Caption TS Output (SMPTE 2038 over SRT)

Design spec. 2026-07-15.

## Summary

Add a fourth live output to the streaming path (`worker-stream-pod`): a
continuous MPEG-TS carrying CEA-708 closed captions as SMPTE ST 2038 ancillary
data, delivered over SRT for a downstream muxer to combine with the real video.

The pod stays audio-only. It does not touch the source video. It emits a
caption-only transport stream that a professional muxer lifts the ancillary
data from and re-inserts into the video elementary stream.

## Decisions locked in brainstorming

- **Output shape:** caption-only TS/ES, not a full remux. Pod remains audio-only.
- **Delivery:** live continuous TS, consumed in real time (not a rolling file or
  post-stream archive).
- **Carriage:** CEA-708 CDP wrapped as SMPTE ST 334 caption ancillary inside a
  SMPTE ST 2038 PID.
- **Sync:** wall-clock timeline plus a fixed latency offset. No source PTS
  extraction in v1 (noted as a future upgrade).
- **Transport:** SRT, pod as listener, muxer as caller.
- **Caption style:** pop-on (recommended, matches the finalised-cue fan-out).
  Roll-up is a possible later mode.
- **Build approach:** in-house encoder for all broadcast bytes (708/CDP/2038/TS),
  ffmpeg for SRT egress. Reuses the ffmpeg dependency the pod already runs for
  ingest; keeps the fussy bytes fully under our control and unit-testable.

## Non-goals (v1)

- Source PTS preservation / frame-accurate alignment to original timeline.
- Full remux of source video+audio.
- Roll-up or paint-on presentation.
- Multiple simultaneous 708 services or languages beyond the single configured
  service.
- Rolling-file or post-stream TS archive.

## Architecture

New Python modules in `services/worker-stream-pod/src/worker_stream_pod/`, each a
small unit testable in isolation, following the existing module style
(`vtt_writer`, `cue_assembler`, etc.).

### `cea708.py`
Turns a finalised `Cue` into a CEA-708 pop-on caption:
- DTVCC service block for the configured service (default service 1, English).
- Window / pen / text commands to render the cue text as a pop-on block.
- CEA-608 compatibility bytes so legacy 608 decoders still show captions.
- Pure function: cue in, caption byte-groups out. No I/O, no timing.

### `cdp.py`
Packs caption byte-groups into CEA-708 Caption Distribution Packets:
- CDP header, framing rate, `cc_data` section, sequence counter, footer and
  checksum.
- One CDP per frame tick. Empty `cc_data` when there is nothing to display
  (keepalive), so 608/708 decoders and the link stay fed.

### `smpte2038.py`
Wraps a CDP as a SMPTE ST 334 caption ancillary packet inside a SMPTE ST 2038
VANC PES payload: DID/SDID, line number, user data words.

### `ts_mux.py`
Minimal MPEG-TS packetiser:
- PAT and PMT declaring the 2038 data PID.
- PCR insertion at the required cadence.
- PES packetisation of the 2038 payload, PTS-stamped.
- Emits 188-byte packets. A tick with no caption still emits PCR/keepalive.
- 33-bit PTS and 27 MHz PCR, both derived from the wall-clock timeline, with
  33-bit wrap handled.

### `caption_ts_muxer.py`
Orchestrator. A background asyncio task that owns:
- A wall-clock frame ticker at `POD_CAPTION_FPS` (default 25, ~40 ms).
- A bounded asyncio queue fed by the fan-out's `add(cue)`.
- The ffmpeg SRT egress subprocess.
- The assembly per tick: current caption state -> `cea708` -> `cdp` ->
  `smpte2038` -> `ts_mux` -> ffmpeg stdin.

Public API: `add(cue)` (non-blocking enqueue), `start()`, `close()`.

### Wiring
`CueFanout` gains a new optional sink `caption_ts`, called exactly where
`vtt.add(cue)` is called today (finalised cues only). The muxer's timing loop
runs independently of cue arrival, so PCR/keepalive flows regardless of whether
anyone is talking.

## Timing and data flow

**Clock.** One monotonic media timeline anchored at muxer start (`t0`, wall
clock). PTS is 33-bit 90 kHz, PCR is 27 MHz, both `(wall_now - t0) * rate` with
33-bit wrap handled. PCR tracks real time, which the SRT link and downstream
muxer expect.

**Per-frame cadence.** No video is available, so the muxer runs a nominal frame
cadence (`POD_CAPTION_FPS`, default 25). Every tick it emits one CDP wrapped in
2038, PTS-stamped for that tick, plus PCR at the required interval. The steady
per-frame CDP stream is also the keepalive: empty `cc_data` when idle. No
separate null-packet path.

**Fixed latency offset.** Caption PTS is stamped ahead of the current tick by
`POD_CAPTION_LATENCY_MS` (default 1000) so the anc lands on an upcoming video
frame the muxer can still place, not one already gone. This is the single knob
to tune per muxer buffer depth.

**Pop-on lifecycle per cue.** On `add(cue)`: build the pop-on caption (define
window, pen, text, plus 608 compat), load the hidden buffer, flip it visible.
Schedule a clear at `start_ms + (end_ms - start_ms)`. A newer cue arriving
before that replaces the current caption (clear, then show new). Screen state
always reflects the latest finalised cue.

**Fan-out and backpressure.** `caption_ts.add(cue)` is a non-blocking enqueue
onto a bounded queue. If the muxer falls behind (ffmpeg stall), the queue drops
the oldest caption rather than blocking the fan-out, because captions must never
back-pressure ASR or the other sinks. Drops are logged and counted.

**Path per cue:** `Cue -> cea708 (pop-on + 608) -> cdp -> smpte2038 -> ts_mux
(PES + PTS) -> ffmpeg stdin -> SRT`.

## API and provisioning

### Opt-in on create
Off by default (heavier: extra ffmpeg + a port). `StreamCreate.output` gains:

```yaml
output:
  target_lang: { type: string, enum: [en] }
  caption_ts: { type: boolean, default: false }
```

### Gateway (`services/api-gateway/src/routes/streams.ts`)
- Persist the flag (new `streams.caption_ts_enabled` column).
- Pass it through the provision payload.
- When enabled, add to the create response:
  `outputs.caption_srt_url: "srt://<SRT_PUBLIC_HOST>:<srt_port>"`.

Unlike WS/VTT/TTML, SRT cannot be HTTP-proxied through the gateway. The muxer
connects directly to the pod host, like the WS port but unproxied. The URL uses
a configured public SRT host base (`SRT_PUBLIC_HOST`) that resolves to the pod's
reachable address. Deployment requirement: the pod's SRT port must be reachable
by the muxer.

### Supervisor (`services/worker-stream-supervisor/src/worker_stream_supervisor/`)
- Add a second `PortPool` for SRT (`STREAM_SRT_PORT_START/END`), allocated only
  when `caption_ts_enabled`.
- When enabled, add spawn env: `POD_CAPTION_TS=1`, `POD_SRT_PORT`,
  `POD_SRT_HOST=0.0.0.0`.
- Persist `srt_port` on `stream_pods` and include it in the `STREAM_READY`
  payload.
- When not enabled, none of this happens; behaviour is unchanged.

### SRT mode
Pod runs ffmpeg as the SRT listener (`srt://0.0.0.0:PORT?mode=listener`), muxer
is the caller. Matches the pull model of the other outputs: the muxer connects
when ready and can reconnect without disturbing the pod.

### Pod config (new env, all with defaults)
- `POD_CAPTION_TS` (off unless `1`)
- `POD_SRT_PORT`
- `POD_SRT_HOST` (default `0.0.0.0`)
- `POD_CAPTION_FPS` (default 25)
- `POD_CAPTION_LATENCY_MS` (default 1000)
- `POD_CAPTION_SERVICE` (708 service number, default 1)

The pod only constructs `Caption708Muxer` when `POD_CAPTION_TS=1`.

### Migrations
- `streams.caption_ts_enabled bool default false`
- `stream_pods.srt_port int null`

## Error handling and lifecycle

- **ffmpeg egress fails to start:** the caption output is best-effort. Log and
  fail the caption output only; the stream and its other three outputs continue.
  Do not fail the whole stream because SRT egress could not start.
- **ffmpeg dies mid-stream:** attempt a bounded restart of the egress
  subprocess. Captions queued during the gap follow the drop-oldest policy.
- **Muxer disconnects:** SRT listener stays up; the muxer can reconnect. Pod
  keeps generating the TS (ffmpeg listener holds).
- **Queue overflow:** drop oldest caption, increment a drop counter/metric.
- **Pod shutdown (SIGTERM / source EOF / delete):** close the muxer cleanly:
  stop the ticker, flush, close ffmpeg stdin, wait for exit. Mirrors how `vtt`
  is closed in the `finally` block of `worker.main()`.
- **Port pool exhausted (SRT):** fail provisioning with a clear code, same
  pattern as the WS `PoolFull` path.

## Observability

- Reuse the existing span/metric patterns in `py_common.obs`.
- Add a caption-drop counter and an egress-subprocess-restart counter.
- Optionally a span attribute on the session span for whether caption TS was
  enabled, to feed the Live Streams dashboard.

## Testing

Unit (pure, no external deps, matching existing pod tests):
- `cea708`: known cue text produces expected DTVCC command bytes and 608 compat.
- `cdp`: byte-groups produce a well-formed CDP with correct sequence counter and
  checksum; idle tick produces a valid empty-`cc_data` CDP.
- `smpte2038`: CDP wraps into a spec-correct 2038 anc payload (DID/SDID, UDW).
- `ts_mux`: PAT/PMT/PCR present, 188-byte alignment, PTS monotonic, 33-bit wrap
  handled, PMT declares the 2038 PID.
- `caption_ts_muxer`: with a fake clock and a fake ffmpeg stdin (injected byte
  sink), a sequence of cues plus idle ticks produces the expected packet stream;
  queue overflow drops oldest; pop-on replace-on-new-cue works; clear fires at
  the right tick.

Integration:
- Enable `caption_ts` on a stub-cue stream, connect a test SRT caller (or
  ffmpeg), pull the TS, and assert it decodes to captions (e.g. ffprobe sees the
  data PID; a 708 decoder recovers the cue text).
- Verify the create response includes `caption_srt_url` only when enabled.
- Verify a stream with the flag off is byte-for-byte unchanged from today.

## Open items to confirm

- `SRT_PUBLIC_HOST` resolution in the target deployment (how the muxer reaches
  the pod).
- Exact SMPTE 2038 line number / DID-SDID convention the downstream muxer
  expects (334 caption anc is standard; confirm no site-specific override).
- Default `POD_CAPTION_LATENCY_MS` against the real muxer's buffer depth.
