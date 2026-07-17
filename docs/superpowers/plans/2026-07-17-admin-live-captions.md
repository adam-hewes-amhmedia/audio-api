# Live Captions in the Ops Console (SSE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show admin ops-console captions live (interim + finalised) the instant the pod produces them, replacing the 2s poll.

**Architecture:** A new gateway SSE endpoint reuses the proven `streams-ws.ts` bridge (look up the stream's pod, open its WS server-side) and re-emits every pod message as an SSE `data:` event. The Next proxy streams `text/event-stream` bodies through instead of buffering, so the admin token stays server-side. The console detail page swaps its cue poll for an `EventSource`.

**Tech Stack:** Fastify + TypeScript gateway (`C:\dev\audio-api`), `ws` package for the pod client, Next.js 16 + MUI + React Query console (`C:\dev\audio-api-console`), native browser `EventSource`.

## Global Constraints

- **Admin token never reaches the browser.** The browser talks only to the same-origin Next proxy (`app/api/admin/[...path]/route.ts`), which attaches the bearer server-side. Never call audio-api from a client component.
- **Forward pod WS messages verbatim.** A pod message is already the `{ event, stream_id, cue_id, start_ms, end_ms, text, source_text, confidence }` shape the console consumes; wrap it in `data: <json>\n\n`, do not reshape it.
- **Keepalive:** the gateway writes an SSE comment `: ping\n\n` every 15s so idle proxies do not drop the connection.
- **TDD where a runner exists.** The gateway has vitest — write the failing test first. The console has no unit-test runner (matching the existing console); its gate is `pnpm typecheck` + `pnpm lint` + live verification.
- **Gateway tests** run serially (`fileParallelism: false`) against one shared DB and need host-facing env (docker hostnames rewritten to `localhost` in `DATABASE_URL`/`NATS_URL`/`OBJECT_STORE_*`) per project memory.
- **Branch `feat/live-captions` in both repos.** audio-api is already on it (spec commit `621de07`, off `main`). Create it in the console off its default branch. Do not merge or push without Adam's say-so.

---

### Task 1: Gateway SSE endpoint

**Files:**
- Create: `C:\dev\audio-api\services\api-gateway\src\routes\admin\captions-stream.ts`
- Modify: `C:\dev\audio-api\services\api-gateway\src\routes\admin\index.ts`
- Modify: `C:\dev\audio-api\packages\contracts\openapi-admin.yaml`
- Test: `C:\dev\audio-api\services\api-gateway\tests\admin-captions-stream.test.ts`

**Interfaces:**
- Consumes: `audit(req, action, targetType, targetId, tenantId, payload?)` from `./audit.js`; `getPool()` from `@audio-api/node-common`; `WebSocket` from `ws`. Test helpers from `./helpers/admin.js`: `buildAdminServer()`, `adminHeaders()`, `seedAdminToken()`, `cleanFixtures()`, `TENANT_A`.
- Produces: route `GET /v1/admin/streams/:id/captions/stream` (SSE). Emits SSE `data:` frames whose JSON is either a verbatim pod cue (`{event:"cue.interim"|"cue.finalised", ...}`), `{event:"error", code:"ADMIN_STREAM_NOT_LIVE"}`, or `{event:"closed"}`. The console (Tasks 2-3) depends on exactly these event names.

Confirm the branch is `feat/live-captions` before starting:

```bash
cd /c/dev/audio-api && git branch --show-current
# expect: feat/live-captions
```

- [ ] **Step 1: Write the failing test**

Create `services/api-gateway/tests/admin-captions-stream.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocketServer } from "ws";
import { getPool } from "@audio-api/node-common";
import { buildAdminServer, adminHeaders, seedAdminToken, cleanFixtures, TENANT_A } from "./helpers/admin.js";

let app: Awaited<ReturnType<typeof buildAdminServer>>;
let upstream: WebSocketServer;
let upstreamPort: number;

// Read SSE `data:` frames off the streaming HTTP body until we have `want` of
// them or the timeout fires. Comments (`: ping`) and blank lines are skipped.
async function readEvents(url: string, want: number, timeoutMs = 5000): Promise<any[]> {
  const res = await fetch(url, { headers: adminHeaders() });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const events: any[] = [];
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (events.length < want && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) events.push(JSON.parse(line.slice(5).trim()));
      }
    }
  }
  try { await reader.cancel(); } catch {}
  return events;
}

beforeAll(async () => {
  await cleanFixtures();
  await seedAdminToken();

  upstream = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => upstream.once("listening", () => r()));
  upstreamPort = (upstream.address() as any).port;
  upstream.on("connection", (ws) => {
    ws.send(JSON.stringify({ event: "cue.interim", cue_id: 1, start_ms: 0, end_ms: 900, text: "hel" }));
    ws.send(JSON.stringify({ event: "cue.finalised", cue_id: 1, start_ms: 0, end_ms: 900, text: "hello" }));
  });

  app = await buildAdminServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  try { upstream.close(); } catch {}
  if (app) await app.close();
  await cleanFixtures();
});

describe("SSE /v1/admin/streams/:id/captions/stream", () => {
  it("emits ADMIN_STREAM_NOT_LIVE and closes when the stream has no live pod", async () => {
    const addr = app.server.address() as any;
    const url = `http://127.0.0.1:${addr.port}/v1/admin/streams/s_not_live/captions/stream`;
    const events = await readEvents(url, 1);
    expect(events[0]).toMatchObject({ event: "error", code: "ADMIN_STREAM_NOT_LIVE" });
  });

  it("forwards interim and finalised cues from the pod as SSE events", async () => {
    const id = "s_adm_capstream_01";
    const pid = "p_adm_capstream_01";
    const pool = getPool();
    await pool.query(
      "INSERT INTO streams (id, tenant_id, status, target_lang, source_kind, source_url, pod_id) " +
      "VALUES ($1, $2, 'active', 'en', 'hls', 'https://cdn.example.com/x.m3u8', $3)",
      [id, TENANT_A, pid]
    );
    await pool.query(
      "INSERT INTO stream_pods (pod_id, supervisor_host, ws_host, ws_port, stream_id, status) " +
      "VALUES ($1, 'localhost', '127.0.0.1', $2, $3, 'ready')",
      [pid, upstreamPort, id]
    );

    const addr = app.server.address() as any;
    const url = `http://127.0.0.1:${addr.port}/v1/admin/streams/${id}/captions/stream`;
    const events = await readEvents(url, 2);
    expect(events[0]).toMatchObject({ event: "cue.interim", cue_id: 1, text: "hel" });
    expect(events[1]).toMatchObject({ event: "cue.finalised", cue_id: 1, text: "hello" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter api-gateway test admin-captions-stream`
Expected: FAIL — the route does not exist, so both cases time out with no events (`events[0]` is `undefined`).

- [ ] **Step 3: Write the SSE route**

Create `services/api-gateway/src/routes/admin/captions-stream.ts`:

```ts
import { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { getPool } from "@audio-api/node-common";
import { audit } from "./audit.js";

// The live caption feed for the admin detail screen. The tenant API exposes the
// same pod WS at GET /v1/streams/:id/captions; the console cannot use that,
// because a Next route handler cannot proxy a WS upgrade and the admin token
// must stay server-side. SSE is a plain streaming HTTP response, so it passes
// through the Next proxy while the token never leaves the server.
//
// Cross-tenant on purpose (no tenant_id filter): admin sees every tenant, and
// the read is attributed to the admin token via the audit row below.
export async function adminCaptionsStreamRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/v1/admin/streams/:id/captions/stream",
    async (req, reply) => {
      const row = await getPool().query<{ host: string; port: number; tenant_id: string }>(
        `SELECT p.ws_host AS host, p.ws_port AS port, s.tenant_id AS tenant_id
         FROM streams s JOIN stream_pods p ON p.pod_id = s.pod_id
         WHERE s.id = $1 AND p.ws_port IS NOT NULL
           AND p.status IN ('ready', 'ingesting')`,
        [req.params.id]
      );

      // Everything from here is SSE. hijack() stops Fastify from also trying to
      // send a normal reply on this request.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });

      const send = (obj: unknown) => {
        try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
      };

      // Not live: tell the client and stop. The console falls back to the
      // finalised-cue history it already fetched.
      if (row.rowCount === 0) {
        send({ event: "error", code: "ADMIN_STREAM_NOT_LIVE" });
        res.end();
        return;
      }

      const { host, port, tenant_id } = row.rows[0];
      // Caption text is customer content; every read is attributable, exactly
      // as the polled cues endpoint audits stream.cues.view.
      await audit(req, "stream.captions.stream", "stream", req.params.id, tenant_id);

      const upstream = new WebSocket(`ws://${host}:${port}`);
      const ping = setInterval(() => {
        try { res.write(`: ping\n\n`); } catch {}
      }, 15000);

      let ended = false;
      const finish = () => {
        if (ended) return;
        ended = true;
        clearInterval(ping);
        try { upstream.close(); } catch {}
        try { res.end(); } catch {}
      };

      upstream.on("message", (d) => {
        // Verbatim: d is already the { event, cue_id, ... } payload the console
        // consumes.
        try { res.write(`data: ${d.toString()}\n\n`); } catch {}
      });
      upstream.on("close", () => { send({ event: "closed" }); finish(); });
      upstream.on("error", () => { send({ event: "closed" }); finish(); });

      // Client hung up: close the pod WS so we do not leak the connection.
      res.on("close", () => { clearInterval(ping); try { upstream.close(); } catch {} });
    }
  );
}
```

- [ ] **Step 4: Register the route**

In `services/api-gateway/src/routes/admin/index.ts`, add the import after the other admin router imports (after line 7):

```ts
import { adminCaptionsStreamRoutes } from "./captions-stream.js";
```

and register it in `adminRoutes`, after `await app.register(adminSettingsRoutes);` (or after the last existing register on this branch, `adminTokensRoutes`):

```ts
  await app.register(adminCaptionsStreamRoutes);
```

> Note: this branch is off `main`, so `adminSettingsRoutes` (from `feat/admin-settings`) is not present here. Register `adminCaptionsStreamRoutes` after the last existing `app.register(...)` line, whichever it is.

- [ ] **Step 5: Document the route in openapi**

In `packages/contracts/openapi-admin.yaml`, add a new path entry immediately after the `/v1/admin/streams/{id}/cues:` block (which ends around line 86, before `/v1/admin/streams/{id}/kill:`):

```yaml
  /v1/admin/streams/{id}/captions/stream:
    get:
      summary: Live caption feed (SSE)
      description: >
        Server-Sent Events bridge to the stream's pod. Emits interim and
        finalised cues the instant the pod produces them, so the console does
        not have to poll. Interim cues are WS-only and never persisted, so this
        is the only way to see them. If the stream has no live pod the endpoint
        emits a single {event:"error", code:"ADMIN_STREAM_NOT_LIVE"} and closes;
        when the pod WS ends it emits {event:"closed"}. The connect is audited
        as stream.captions.stream because cue text is customer content.
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        "200":
          description: An event stream of cue events.
          content:
            text/event-stream:
              schema: { type: string }
        "401": { $ref: "#/components/responses/AuthFailed" }
```

- [ ] **Step 6: Run the new test to verify it passes**

Run: `pnpm --filter api-gateway test admin-captions-stream`
Expected: PASS — both cases green.

- [ ] **Step 7: Run the contract and auth sweeps to verify no drift**

Run: `pnpm --filter api-gateway test admin-openapi admin-auth`
Expected: PASS. `admin-openapi` confirms the new route is documented (no phantom, no undocumented); `admin-auth` confirms the route rejects anonymous and tenant-token callers (it inherits `requireAdmin` from the scope, so this passes without extra code).

- [ ] **Step 8: Commit**

```bash
cd /c/dev/audio-api
git add services/api-gateway/src/routes/admin/captions-stream.ts \
        services/api-gateway/src/routes/admin/index.ts \
        packages/contracts/openapi-admin.yaml \
        services/api-gateway/tests/admin-captions-stream.test.ts
git commit -m "feat(admin): SSE endpoint for live caption feed

GET /v1/admin/streams/:id/captions/stream bridges the pod WS server-side
and re-emits interim + finalised cues as SSE, so the console can show
captions live without polling and without the admin token in the browser.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Console proxy streams SSE bodies

**Files:**
- Modify: `C:\dev\audio-api-console\app\api\admin\[...path]\route.ts:60-64`

**Interfaces:**
- Consumes: the gateway route from Task 1 (via `AUDIO_API_URL`).
- Produces: the proxy now returns `text/event-stream` responses as a live stream instead of buffering them. Task 3's `EventSource` depends on this.

- [ ] **Step 1: Create the console branch**

```bash
cd /c/dev/audio-api-console
git checkout main 2>/dev/null || git checkout master
git checkout -b feat/live-captions
git branch --show-current   # expect: feat/live-captions
```

- [ ] **Step 2: Add the streaming branch to `proxy()`**

In `app/api/admin/[...path]/route.ts`, replace the buffered tail of `proxy()` (currently lines 60-64):

```ts
  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
```

with a version that streams event-stream bodies through untouched:

```ts
  const contentType = upstream.headers.get("content-type") ?? "application/json";

  // SSE (the live caption feed) is a long-lived streaming response. Buffering it
  // with .text() would wait forever, so pass the body through as a stream. The
  // admin token still never leaves this server; only the cue bytes flow.
  if (contentType.startsWith("text/event-stream") && upstream.body) {
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  }

  // Everything else: pass the upstream status and body through untouched.
  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { "content-type": contentType },
  });
```

- [ ] **Step 3: Typecheck**

Run: `cd /c/dev/audio-api-console && pnpm typecheck`
Expected: PASS (no type errors; `upstream.body` is a `ReadableStream`, a valid `BodyInit`).

- [ ] **Step 4: Commit**

```bash
cd /c/dev/audio-api-console
git add "app/api/admin/[...path]/route.ts"
git commit -m "feat(proxy): stream text/event-stream responses through

The live caption feed is SSE; buffering it with .text() would never
return. Pass event-stream bodies through as a stream while keeping the
admin token server-side.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Console detail page uses EventSource

**Files:**
- Modify: `C:\dev\audio-api-console\lib\types.ts` (add `LiveCueEvent`)
- Modify: `C:\dev\audio-api-console\app\streams\[id]\page.tsx`

**Interfaces:**
- Consumes: the SSE route via the proxy (Tasks 1-2); `adminClient.cues(id)` for history; `AdminCue`, `ACTIVE_STREAM_STATUSES` from `@/lib/types`.
- Produces: the finished feature. Terminal state of the plan.

- [ ] **Step 1: Add the live-cue event type**

In `lib/types.ts`, after the `AdminCue` interface (ends line 58), add:

```ts
// A single SSE frame from GET /v1/admin/streams/:id/captions/stream. cue.* frames
// carry a cue; error/closed are lifecycle signals. Fields beyond `event` are
// optional because the lifecycle frames omit them.
export interface LiveCueEvent {
  event: "cue.interim" | "cue.finalised" | "error" | "closed";
  cue_id?: number;
  start_ms?: number;
  end_ms?: number;
  text?: string;
  source_text?: string | null;
  confidence?: number | null;
  code?: string;
}
```

- [ ] **Step 2: Rewrite the page's imports and hooks**

In `app/streams/[id]/page.tsx`:

Change the React import (line 8) from:

```ts
import { use, useState } from "react";
```
to:
```ts
import { use, useEffect, useState } from "react";
```

Change the types import (line 10) from:

```ts
import { KILLABLE_STATUSES, AdminCue } from "@/lib/types";
```
to:
```ts
import { KILLABLE_STATUSES, ACTIVE_STREAM_STATUSES, AdminCue, LiveCueEvent } from "@/lib/types";
```

Add an `interim` state next to the existing `cues` state (after line 31, `const [cues, setCues] = useState<AdminCue[]>([]);`):

```ts
  const [interim, setInterim] = useState<string | null>(null);
```

Delete the entire cue-polling `useQuery` block (lines 39-54, the comment plus `useQuery({ queryKey: ["cues", id], ... refetchInterval: 2000 })`) and replace it with the two effects below plus their helpers. Place them after the `kill` mutation (after line 63) and **before** the `if (q.isLoading)` guard, because hooks must run on every render:

```ts
  // Liveness as a stable boolean, so the SSE effect does not re-open on every 3s
  // stream poll. It flips to false exactly when the stream goes terminal.
  const live = ACTIVE_STREAM_STATUSES.includes(q.data?.status ?? "");

  // History: the SSE stream only carries cues from connect-time on, so fetch the
  // finalised cues that already happened once, when the stream id changes.
  useEffect(() => {
    let cancelled = false;
    adminClient
      .cues(id)
      .then((res) => { if (!cancelled) setCues((prev) => mergeCues(prev, res.items)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [id]);

  // Live: while the stream is live, subscribe to the SSE feed. Finalised cues
  // append; an interim cue is the single live "typing" line, replaced each time
  // and cleared when its finalised version lands.
  useEffect(() => {
    if (!live) return;
    const es = new EventSource(`/api/admin/streams/${id}/captions/stream`);
    es.onmessage = (e) => {
      let msg: LiveCueEvent;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.event === "cue.finalised") {
        setInterim(null);
        setCues((prev) => mergeCues(prev, [toCue(msg)]));
      } else if (msg.event === "cue.interim") {
        setInterim(msg.text ?? "");
      } else if (msg.event === "closed" || msg.event === "error") {
        es.close();
      }
    };
    // On a transient drop EventSource reconnects on its own while live; nothing
    // to do here. The stream going terminal flips `live` and runs the cleanup.
    return () => { es.close(); };
  }, [id, live]);
```

- [ ] **Step 3: Add the merge/convert helpers**

At the bottom of `app/streams/[id]/page.tsx`, after the component's closing brace, add:

```ts
// Append only cue_ids not already present, keeping the feed ordered. History and
// the live stream overlap around connect-time, so dedupe is required.
function mergeCues(prev: AdminCue[], next: AdminCue[]): AdminCue[] {
  const seen = new Set(prev.map((c) => c.cue_id));
  const add = next.filter((c) => c.cue_id != null && !seen.has(c.cue_id));
  if (add.length === 0) return prev;
  return [...prev, ...add].sort((a, b) => a.cue_id - b.cue_id);
}

// A finalised SSE frame carries the same fields as AdminCue, just optionally.
function toCue(m: LiveCueEvent): AdminCue {
  return {
    cue_id: m.cue_id!,
    start_ms: m.start_ms ?? 0,
    end_ms: m.end_ms ?? 0,
    text: m.text ?? "",
    source_text: m.source_text ?? null,
    confidence: m.confidence ?? null,
  };
}
```

- [ ] **Step 4: Render the interim line**

In the Captions card, replace the empty/list block (currently lines 162-175, the `{cues.length === 0 ? (...) : (cues.map(...))}` expression) with one that also shows the live interim line:

```tsx
                {cues.length === 0 && !interim ? (
                  <Typography color="text.secondary" variant="body2">
                    No captions yet. They appear here as the pod produces them.
                  </Typography>
                ) : (
                  <>
                    {cues.map((c) => (
                      <Box key={c.cue_id} sx={{ mb: 1.5 }}>
                        <Typography variant="caption" color="text.secondary">
                          {cueTime(c.start_ms)}
                        </Typography>
                        <Typography variant="body2">{c.text}</Typography>
                      </Box>
                    ))}
                    {interim && (
                      <Box sx={{ mb: 1.5 }}>
                        <Typography variant="body2" sx={{ fontStyle: "italic", color: "text.secondary" }}>
                          {interim}
                        </Typography>
                      </Box>
                    )}
                  </>
                )}
```

- [ ] **Step 5: Typecheck and lint**

Run: `cd /c/dev/audio-api-console && pnpm typecheck && pnpm lint`
Expected: PASS. In particular no `react-hooks/set-state-in-effect` error: the `setCues`/`setInterim` calls run inside async callbacks (the fetch `.then` and the `EventSource.onmessage`), not synchronously in the effect body.

- [ ] **Step 6: Commit**

```bash
cd /c/dev/audio-api-console
git add lib/types.ts "app/streams/[id]/page.tsx"
git commit -m "feat(streams): live captions via EventSource

Replace the 2s cue poll with an SSE subscription: finalised cues append,
an interim cue shows as a single live line. History is backfilled once
from the cues endpoint; terminal streams show history only.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 7: Live end-to-end verification**

With the stack running (gateway + supervisor in Docker per project memory, console on 3300) and a live stream producing audio:

1. Open the console, go to the stream's detail page.
2. Confirm interim text appears as a muted italic line and updates faster than the old 2s cadence, then settles into a finalised line.
3. Kill or end the stream; confirm the feed stops cleanly (no console errors, no runaway reconnect) and the finalised cues remain.
4. Reload on an ended stream; confirm history still shows (finalised cues) and no interim line appears.

---

## Self-Review

**Spec coverage:**
- Gateway SSE endpoint (cross-tenant lookup, verbatim forward, not-live error, closed on WS end, 15s keepalive, audit) → Task 1.
- Next proxy streaming branch → Task 2.
- Console EventSource, history backfill, dedupe, interim/finalised rendering, terminal-stream handling → Task 3.
- Testing: gateway not-live + forwarding tests, openapi + auth sweeps → Task 1 steps 1-7; console typecheck/lint + live e2e → Task 3 steps 5, 7.
- Non-goals (no persistence change, tenant WS untouched, interim stays ephemeral) → respected; no task touches `streams-ws.ts`, `fanout.py`, NATS, or the cues DB path.

**Placeholder scan:** none — every code and command step is concrete.

**Type consistency:** `LiveCueEvent` (Task 3 step 1) is used identically in the effect and `toCue` (steps 2-3). `mergeCues`/`toCue` names match across steps 2-4. Event names `cue.interim` / `cue.finalised` / `error` (code `ADMIN_STREAM_NOT_LIVE`) / `closed` match between the gateway (Task 1), openapi (Task 1 step 5) and the console handler (Task 3 step 2). `ACTIVE_STREAM_STATUSES` is the existing export in `lib/types.ts:159`.
