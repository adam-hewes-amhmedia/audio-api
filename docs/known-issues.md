# Known Issues

Running list of known bugs and gaps. Add newest at top.

---

## 1. Killed streams stick at `ending`, never reach `ended`/`archived`

**Status:** open, not started
**Severity:** medium (functional; orphaned rows accumulate, console shows a stuck lifecycle)
**Found:** 2026-07-18, via the ops console "Kill stream" action

### Symptom
Killing a stream from the console (or any `delete_requested`) moves it to `ending`,
the pod is torn down, but the stream never advances to `ended` and then `archived`.
It sits at `ending` indefinitely. Observed 6 streams stuck this way, some 26h old.

### Root cause
`ending -> ended` only fires on the `ingest_ended` event
(`services/orchestrator/src/stream-machine.ts:32`). On a kill:

1. `POST /v1/admin/streams/:id/kill` transitions the stream to `ending`
   (`services/api-gateway/src/routes/admin/streams.ts:134`).
2. The supervisor terminates the pod and sets `pod.status = 'terminated'`.
3. Nothing publishes `ingest_ended` for the stream.

The reaper is the backstop that emits `ingest_ended` for `active`/`ending` streams
(`reaper.py:19-20`), but its stale scan explicitly excludes terminated pods:
`_fetch_stale` has `AND p.status NOT IN ('terminated','dead')`
(`services/worker-stream-supervisor/src/worker_stream_supervisor/reaper.py:89`).
So a killed stream's (terminated) pod is invisible to the reaper, and
`_fetch_orphans` only marks pods dead once the stream is *already* terminal and
publishes no event. No path drives `ending -> ended`.

### Fix direction (not yet decided)
Close the loop on the kill path. Cleanest: the supervisor's pod-delete flow
publishes `STREAM_INGEST_ENDED` after terminating the pod, so the orchestrator
advances `ending -> ended` and the tt-archiver takes `ended -> archived`.
Alternatives: the pod emits `ingest.ended` on clean SIGTERM before exit; or the
reaper also handles `ending` streams whose pod is `terminated` (muddies the
"stale heartbeat" semantics, less clean).

### Repro
Start a live stream, kill it from the console, watch `streams.status` stay `ending`
while `stream_pods.status` is `terminated`.

---

## 2. Console Settings page for pod tuning

**Status:** BUILT + integrated, verified live 2026-07-18. Pushed; PR #21 (audio-api) / #4 (console) open.
**Severity:** resolved

Operators can adjust pod settings (max duration, idle timeout, reconnect window,
model size) from the console. Prior admin-settings work was rebased onto
`feat/video-preview` (migration renumbered `0010` -> `0011_settings.sql`). Live
e2e passed: `GET`/`PUT /v1/admin/settings` work, and a newly spawned pod received
the DB overrides (`POD_MODEL_SIZE=base`, `POD_MAX_DURATION_S=120`, winning over the
container env) proving console -> gateway -> settings table -> supervisor
`spawn_env` -> pod. Both repos on `feat/admin-settings`.

- Spec: `docs/superpowers/specs/2026-07-17-admin-settings-design.md`
