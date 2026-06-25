import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { buildServer } from "../src/server.js";
import { getPool } from "@audio-api/node-common";

const TOKEN = "test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH  = createHash("sha256").update(TOKEN).digest("hex");

let app: Awaited<ReturnType<typeof buildServer>>;
let upstream: WebSocketServer;
let upstreamPort: number;

beforeAll(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM api_tokens WHERE id = 't_test'");
  await pool.query(
    "INSERT INTO api_tokens (id, tenant_id, token_hash) VALUES ($1, $2, $3)",
    ["t_test", "tenant_test", HASH]
  );

  upstream = new WebSocketServer({ port: 0 });
  await new Promise<void>((res) => upstream.once("listening", () => res()));
  upstreamPort = (upstream.address() as any).port;

  upstream.on("connection", (ws) => {
    ws.send(JSON.stringify({ event: "cue.finalised", text: "hi" }));
  });

  app = await buildServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  try { upstream.close(); } catch {}
  if (app) await app.close();
});

describe("WS proxy /v1/streams/:id/captions", () => {
  it("forwards messages from the upstream pod to the client", async () => {
    const id  = "s_wsproxy_test_01";
    const pid = "p_wsproxy_test_01";
    const pool = getPool();

    await pool.query("DELETE FROM stream_pods WHERE pod_id=$1", [pid]);
    await pool.query("DELETE FROM streams WHERE id=$1", [id]);
    await pool.query(
      "INSERT INTO streams (id, tenant_id, status, target_lang, source_kind, source_url, pod_id) " +
      "VALUES ($1, 'tenant_test', 'active', 'en', 'hls', 'https://cdn.example.com/test.m3u8', $2)",
      [id, pid]
    );
    await pool.query(
      "INSERT INTO stream_pods (pod_id, supervisor_host, ws_host, ws_port, stream_id, status) " +
      "VALUES ($1, 'localhost', '127.0.0.1', $2, $3, 'ready')",
      [pid, upstreamPort, id]
    );

    const addr = app.server.address() as any;
    const url = `ws://127.0.0.1:${addr.port}/v1/streams/${id}/captions`;
    const client = new WebSocket(url, { headers: { authorization: `Bearer ${TOKEN}` } });

    const msg = await new Promise<string>((resolve, reject) => {
      client.on("message", (d) => resolve(d.toString()));
      client.on("error", reject);
      setTimeout(() => reject(new Error("ws timeout")), 5000);
    });

    expect(JSON.parse(msg)).toMatchObject({ event: "cue.finalised", text: "hi" });
    client.close();

    // cleanup
    await pool.query("DELETE FROM stream_pods WHERE pod_id=$1", [pid]);
    await pool.query("DELETE FROM streams WHERE id=$1", [id]);
  });

  it("sends STREAM_NOT_FOUND error and closes when no pod matches", async () => {
    const addr = app.server.address() as any;
    const url = `ws://127.0.0.1:${addr.port}/v1/streams/s_does_not_exist/captions`;
    const client = new WebSocket(url, { headers: { authorization: `Bearer ${TOKEN}` } });

    const result = await new Promise<{ msg?: string; closed: boolean }>((resolve, reject) => {
      let msg: string | undefined;
      client.on("message", (d) => { msg = d.toString(); });
      client.on("close", () => resolve({ msg, closed: true }));
      client.on("error", reject);
      setTimeout(() => reject(new Error("ws timeout")), 5000);
    });

    expect(result.closed).toBe(true);
    if (result.msg) {
      expect(JSON.parse(result.msg)).toMatchObject({ event: "error", code: "STREAM_NOT_FOUND" });
    }
  });
});
