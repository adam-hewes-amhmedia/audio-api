# Live captions in the ops console (SSE bridge)

*Design spec. 2026-07-17.*

## Problem

The admin ops console shows a stream's caption feed on the detail screen
(`app/streams/[id]/page.tsx`) by polling `GET /v1/admin/streams/:id/cues`
every 2 seconds. Two costs:

- **Latency.** A finalised cue can be up to 2s stale before it appears.
- **No interim cues.** Only finalised cues are persisted and served by the
  cues endpoint. The partial "still being spoken" line an operator sees on the
  tenant caption view never reaches the console at all.

Adam wants captions to appear as soon as they are ready, interim included.

## Why polling, and why it has to change

The tenant API already has a live path: `GET /v1/streams/:id/captions`
(`services/api-gateway/src/routes/streams-ws.ts`) is a Fastify WebSocket that
looks up the stream's pod, opens `ws://pod_host:pod_port` server-side, and
forwards every pod message to the caller. The pod's `CueFanout`
(`services/worker-stream-pod/src/worker_stream_pod/fanout.py`) sends **both**
interim (`event: cue.interim`) and finalised (`event: cue.finalised`) cues to
that WebSocket broadcaster. Interim cues go **nowhere else** — not NATS, not
Postgres, not VTT.

So the live, interim-inclusive feed exists; it is only reachable over a
WebSocket. The console cannot use it because **Next.js route handlers cannot
proxy a WebSocket upgrade**, and the admin token must never reach the browser
(audio-api sets CORS `origin: true`, so a leaked admin bearer is replayable
cross-tenant from any origin — see the comment block in
`app/api/admin/[...path]/route.ts`). The browser therefore has to go through
the same-origin Next proxy, which can only speak HTTP.

**Server-Sent Events** is the fix: an SSE response is a long-lived HTTP
response, not an upgrade, so it passes through the Next proxy unchanged while
the admin token stays server-side.

## Approach

Add an admin SSE endpoint on the gateway that reuses the proven
`streams-ws.ts` bridge pattern — look up the pod, open the pod WS server-side —
and re-emits each pod message as an SSE event. Teach the Next proxy to stream
an `text/event-stream` body through instead of buffering it. Replace the
console's 2s cue poll with an `EventSource`.

```
pod WS (interim + finalised)
  └─ gateway  GET /v1/admin/streams/:id/captions/stream   (SSE, requireAdmin)
       opens ws://pod_host:pod_port, re-emits each cue as an SSE data event
       └─ Next proxy  /api/admin/streams/:id/captions/stream
            streams the text/event-stream body through, cookie-auth,
            attaches admin bearer server-side
            └─ browser  EventSource
                 appends finalised cues, replaces the single live interim line
```

Two data sources on the page, by design:

- **History backfill** — one-shot `GET /v1/admin/streams/:id/cues` (existing
  endpoint, Postgres, finalised only) to show what happened before the operator
  opened the page.
- **Live** — the SSE stream, for everything from connect time onward (interim +
  finalised).

Dedupe by `cue_id` where the two overlap.

## Component 1: Gateway SSE endpoint

New file `services/api-gateway/src/routes/admin/captions-stream.ts`, registered
in `services/api-gateway/src/routes/admin/index.ts` alongside the other admin
routers. It inherits the rate-limit + `requireAdmin` scope hooks by
construction — no per-route auth. A long-lived SSE connection counts as one
request against the rate-limit bucket, which is fine.

Route: `GET /v1/admin/streams/:id/captions/stream`

1. **Pod lookup.** Same query as `streams-ws.ts` but **cross-tenant** (admin,
   no `tenant_id` filter) and also selecting `tenant_id` for the audit row:

   ```sql
   SELECT p.ws_host AS host, p.ws_port AS port, s.tenant_id AS tenant_id
   FROM streams s JOIN stream_pods p ON p.pod_id = s.pod_id
   WHERE s.id = $1 AND p.ws_port IS NOT NULL
     AND p.status IN ('ready', 'ingesting')
   ```

2. **SSE headers + hijack.** `reply.hijack()` so Fastify does not try to send
   its own response, then `reply.raw.writeHead(200, {...})` with
   `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
   `Connection: keep-alive`, `X-Accel-Buffering: no`. Write raw `data:` frames
   to `reply.raw`.

3. **Not live** (no matching pod row): write one SSE event
   `data: {"event":"error","code":"ADMIN_STREAM_NOT_LIVE"}\n\n` and end the
   response. The console falls back to history only.

4. **Live.** Open `ws://host:port` (the `ws` package, already a gateway
   dependency). On each upstream message, write it through verbatim:
   `data: <raw pod json>\n\n`. Pod messages already carry the shape
   `{ event, stream_id, cue_id, start_ms, end_ms, text, source_text, confidence }`.

5. **Keepalive.** Every 15s write an SSE comment `: ping\n\n` so idle proxies
   do not drop the connection. Clear the interval on close.

6. **Lifecycle.**
   - Pod WS `close`/`error` → write `data: {"event":"closed"}\n\n`, end the SSE.
   - Client disconnect (`reply.raw.on("close", ...)`) → close the upstream WS
     and clear the keepalive.

7. **Audit.** One `audit(req, "stream.captions.stream", "stream", id, tenant_id)`
   on a successful connect, mirroring the `stream.cues.view` audit on the cues
   endpoint (caption text is customer content; every read is attributable).

Documented in `packages/contracts/openapi-admin.yaml` as a `text/event-stream`
response, so the openapi contract test passes.

## Component 2: Next proxy streaming

`app/api/admin/[...path]/route.ts` currently ends `proxy()` with
`const text = await upstream.text()` — it buffers every response, which would
never flush an SSE stream. Add a branch before that: if the upstream
`content-type` starts with `text/event-stream`, return the body as a stream
instead of buffering.

```ts
const ct = upstream.headers.get("content-type") ?? "application/json";
if (ct.startsWith("text/event-stream")) {
  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}
// ...existing buffered path unchanged
```

`upstream.body` is a `ReadableStream` (Node `fetch` does not buffer by
default), so this passes bytes straight through. No new route, no auth change:
the same session-cookie → admin-bearer model applies. `EventSource` only issues
same-origin `GET`s and cannot set headers, so it relies on the session cookie
the browser sends automatically — which `proxy()` already reads via `auth()`.

## Component 3: Console detail page

`app/streams/[id]/page.tsx` — replace the 2s cue-poll `useQuery` with:

- **Live streams** (status `provisioning` / `awaiting_ingest` / `active` /
  `ending`): one-shot history fetch (`adminClient.cues(id)`), then
  `new EventSource("/api/admin/streams/" + id + "/captions/stream")`.
- **Terminal streams** (status `ended` / `archived` / `failed`): no SSE — just
  the one-shot history fetch. Nothing new will ever arrive; opening a stream is
  pointless and the endpoint would only return `ADMIN_STREAM_NOT_LIVE`.

`EventSource` handlers:

- `onmessage`: parse the cue.
  - `cue.finalised` → append to the finalised list (dedupe by `cue_id`), clear
    the interim line.
  - `cue.interim` → set a single `interim` state value (the live "typing" line).
  - `error` / `closed` → close the `EventSource`.
- Close the `EventSource` when the stream-detail poll observes a terminal
  status, and on unmount.

**Rendering.** The finalised cue list renders as it does today, plus one live
interim line below it, styled muted/italic. Each interim message replaces that
line; when the finalised version of that cue arrives it appends to the list and
the interim line clears until the next partial starts. This is the one visible
UX change beyond latency.

The existing 3s stream-detail `useQuery` stays — it is what tells the page when
the stream has gone terminal (and thus when to stop the `EventSource`).

## Error handling

| Situation | Behaviour |
|---|---|
| Stream not live when opened | SSE emits `error` + closes; page shows history only |
| Pod dies / stream ends mid-view | Gateway sends `closed`, ends SSE; page stops, keeps what it has |
| Transient network drop, stream still live | `EventSource` auto-reconnects; gateway re-attaches to the pod WS |
| Pod WS unreachable after lookup | `ws` emits `error`; gateway sends `closed`, ends SSE |
| Admin token / auth | Unchanged: cookie to proxy, bearer stays server-side |

A failed SSE connect never affects the stream itself — this is a read path.

## Testing

- **Gateway.**
  - Integration test for the **not-live path**: a stream with no ready pod
    yields a single `error` event with code `ADMIN_STREAM_NOT_LIVE` and the
    connection closes (testable with `app.inject`, since it is a short response).
  - Route is under `requireAdmin`: covered automatically by the existing
    `onRoute` auth sweep in `tests/admin-auth.test.ts`, which enumerates the
    admin router and asserts every route rejects an anonymous caller and a valid
    tenant token.
  - openapi contract: covered by documenting the route in `openapi-admin.yaml`.
  - Full pod-WS → SSE forwarding is verified live against the running stack
    rather than with a brittle fake-WS unit test — the bridge logic is a
    line-for-line reuse of `streams-ws.ts`, which is itself already exercised.
- **Console.** `pnpm typecheck` and `pnpm lint`.
- **Live e2e.** With the stack running and a live stream, open the console
  detail page: interim cues appear and settle into finalised lines with no 2s
  lag; when the stream ends, the feed stops cleanly.

## Scope / non-goals

- Ops console only. The tenant WebSocket (`streams-ws.ts`) is untouched.
- No change to how cues are produced, persisted, published to NATS, or written
  to VTT.
- Interim cues stay ephemeral — they render live and are gone on refresh, which
  is correct: they are superseded by their finalised versions.
- No new persistence, no interim-cue storage, no per-tenant config.

## Files touched

**audio-api** (`C:\dev\audio-api`)

- `services/api-gateway/src/routes/admin/captions-stream.ts` — new SSE router.
- `services/api-gateway/src/routes/admin/index.ts` — register it.
- `services/api-gateway/tests/admin-captions-stream.test.ts` — new; not-live
  path.
- `packages/contracts/openapi-admin.yaml` — document the SSE route.

**audio-api-console** (`C:\dev\audio-api-console`)

- `app/api/admin/[...path]/route.ts` — stream `text/event-stream` bodies.
- `app/streams/[id]/page.tsx` — `EventSource` + interim/finalised rendering,
  replacing the cue poll.
- `lib/types.ts` — a live-cue type carrying the `event` tag, if the existing
  `AdminCue` shape needs extending.

Both repos are on `main`. Do the work on a feature branch in each
(`feat/live-captions`), matching prior workflow. Don't merge or push without
Adam's say-so.
