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
