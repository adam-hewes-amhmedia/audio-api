import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { buildServer } from "../src/server.js";
import { getPool, openHeaders } from "@audio-api/node-common";

const TOKEN = "test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH  = createHash("sha256").update(TOKEN).digest("hex");

// Gateway seals source.headers at rest; supply a deterministic key for tests.
const HEADERS_KEY = Buffer.alloc(32, 1).toString("base64");
process.env.STREAM_HEADERS_KEY = HEADERS_KEY;

let app: Awaited<ReturnType<typeof buildServer>>;
const AUTH = { authorization: `Bearer ${TOKEN}` };

beforeAll(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM api_tokens WHERE id = 't_test'");
  await pool.query(
    "INSERT INTO api_tokens (id, tenant_id, token_hash) VALUES ($1, $2, $3)",
    ["t_test", "tenant_test", HASH]
  );
  app = await buildServer();
});

afterAll(async () => {
  await app.close();
});

const VALID_SOURCE = { kind: "hls", url: "https://cdn.example.com/test.m3u8" };

describe("POST /v1/streams", () => {
  it("creates a stream, returns provisioning status + echoed source", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/streams",
      headers: AUTH,
      payload: { source: VALID_SOURCE, source_hint: "fr", output: { target_lang: "en" } },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.stream_id).toMatch(/^s_/);
    expect(body.status).toBe("provisioning");
    expect(body.source.kind).toBe("hls");
    expect(body.source.url).toBe(VALID_SOURCE.url);
    expect(body.source.headers).toBeUndefined(); // never echoed
    expect(body.outputs.websocket_url).toContain(body.stream_id);
    expect(body.outputs.vtt_url).toContain(body.stream_id);
    expect(body.outputs.ttml_url).toContain(body.stream_id);

    const row = await getPool().query(
      "SELECT status, source_kind, source_url FROM streams WHERE id = $1",
      [body.stream_id]
    );
    expect(row.rows[0].status).toBe("provisioning");
    expect(row.rows[0].source_kind).toBe("hls");
    expect(row.rows[0].source_url).toBe(VALID_SOURCE.url);
  });

  it("stores source.headers as encrypted bytea, never plaintext", async () => {
    const headers = { Authorization: "Bearer origin-secret" };
    const r = await app.inject({
      method: "POST",
      url: "/v1/streams",
      headers: AUTH,
      payload: { source: { ...VALID_SOURCE, headers }, output: { target_lang: "en" } },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().source.headers).toBeUndefined(); // never echoed

    const row = await getPool().query(
      "SELECT source_headers FROM streams WHERE id = $1",
      [r.json().stream_id]
    );
    const sealed: Buffer = row.rows[0].source_headers;
    expect(Buffer.isBuffer(sealed)).toBe(true);
    expect(sealed.length).toBeGreaterThan(0);
    expect(sealed.toString("utf8")).not.toContain("origin-secret"); // not plaintext
    expect(openHeaders(sealed, HEADERS_KEY)).toEqual(headers); // round-trips with the key
  });

  it("creates a stream with no output specified", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/streams",
      headers: AUTH,
      payload: { source: VALID_SOURCE },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().status).toBe("provisioning");
  });

  it("rejects unsupported target_lang", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/streams",
      headers: AUTH,
      payload: { source: VALID_SOURCE, output: { target_lang: "de" } },
    });
    expect(r.statusCode).toBe(400);
  });

  it("rejects missing source", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/streams",
      headers: AUTH,
      payload: { output: { target_lang: "en" } },
    });
    expect(r.statusCode).toBe(400);
  });

  it("rejects unsupported source.kind", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/streams",
      headers: AUTH,
      payload: { source: { kind: "rtmp", url: "rtmp://x/y" }, output: { target_lang: "en" } },
    });
    expect(r.statusCode).toBe(400);
  });

  it("rejects plain http source.url by default", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/streams",
      headers: AUTH,
      payload: { source: { kind: "mp4", url: "http://example.com/f.mp4" }, output: { target_lang: "en" } },
    });
    expect(r.statusCode).toBe(400);
  });

  it("caption_ts=true returns caption_srt_url, persists the flag and forwards it", async () => {
    process.env.SRT_PUBLIC_HOST = "srt.example.test";
    try {
      const r = await app.inject({
        method: "POST",
        url: "/v1/streams",
        headers: AUTH,
        payload: { source: VALID_SOURCE, output: { caption_ts: true } },
      });
      expect(r.statusCode).toBe(201);
      // The SRT port is allocated by the supervisor after provisioning, so the
      // create response carries host only; GET surfaces the concrete port.
      expect(r.json().outputs.caption_srt_url).toBe("srt://srt.example.test");

      const row = await getPool().query(
        "SELECT caption_ts_enabled FROM streams WHERE id = $1",
        [r.json().stream_id]
      );
      expect(row.rows[0].caption_ts_enabled).toBe(true);
    } finally {
      delete process.env.SRT_PUBLIC_HOST;
    }
  });

  it("caption_ts omitted returns no caption_srt_url and leaves the flag false", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/streams",
      headers: AUTH,
      payload: { source: VALID_SOURCE },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().outputs.caption_srt_url).toBeUndefined();

    const row = await getPool().query(
      "SELECT caption_ts_enabled FROM streams WHERE id = $1",
      [r.json().stream_id]
    );
    expect(row.rows[0].caption_ts_enabled).toBe(false);
  });
});

describe("GET /v1/streams/:id", () => {
  it("returns 404 for unknown id", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/v1/streams/s_doesnotexist",
      headers: AUTH,
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe("STREAM_NOT_FOUND");
  });

  it("returns stream row for known id", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/streams",
      headers: AUTH,
      payload: { source: VALID_SOURCE, source_hint: "en" },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().stream_id;

    const r = await app.inject({
      method: "GET",
      url: `/v1/streams/${id}`,
      headers: AUTH,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().id).toBe(id);
    expect(r.json().status).toBe("provisioning");
  });

  it("surfaces caption_srt_url with the concrete port once the pod is ready", async () => {
    process.env.SRT_PUBLIC_HOST = "srt.example.test";
    try {
      const create = await app.inject({
        method: "POST",
        url: "/v1/streams",
        headers: AUTH,
        payload: { source: VALID_SOURCE, output: { caption_ts: true } },
      });
      const id = create.json().stream_id;

      // Stand in for the supervisor: attach a ready pod holding an SRT port.
      const podId = `p_${id}`;
      await getPool().query(
        `INSERT INTO stream_pods (pod_id, supervisor_host, ws_host, ws_port, srt_port, stream_id, status)
         VALUES ($1, 'sup1', 'pod1', 10000, 11007, $2, 'ready')`,
        [podId, id]
      );
      await getPool().query("UPDATE streams SET pod_id = $1 WHERE id = $2", [podId, id]);

      const r = await app.inject({ method: "GET", url: `/v1/streams/${id}`, headers: AUTH });
      expect(r.statusCode).toBe(200);
      expect(r.json().outputs.caption_srt_url).toBe("srt://srt.example.test:11007");
    } finally {
      delete process.env.SRT_PUBLIC_HOST;
    }
  });

  it("omits caption_srt_url on GET when caption_ts was not requested", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/streams",
      headers: AUTH,
      payload: { source: VALID_SOURCE },
    });
    const id = create.json().stream_id;

    const r = await app.inject({ method: "GET", url: `/v1/streams/${id}`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.json().outputs?.caption_srt_url).toBeUndefined();
  });
});

describe("DELETE /v1/streams/:id", () => {
  it("flips status to ending", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/streams",
      headers: AUTH,
      payload: { source: VALID_SOURCE, source_hint: "fr", output: { target_lang: "en" } },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().stream_id;

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/streams/${id}`,
      headers: AUTH,
    });
    expect(del.statusCode).toBe(202);
    expect(del.json().stream_id).toBe(id);
    expect(del.json().status).toBe("ending");

    const row = await getPool().query("SELECT status FROM streams WHERE id = $1", [id]);
    expect(row.rows[0].status).toBe("ending");
  });

  it("returns 404 for unknown id", async () => {
    const r = await app.inject({
      method: "DELETE",
      url: "/v1/streams/s_doesnotexist",
      headers: AUTH,
    });
    expect(r.statusCode).toBe(404);
  });

  it("returns 404 for already-ending stream (idempotent)", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/streams",
      headers: AUTH,
      payload: { source: VALID_SOURCE },
    });
    const id = create.json().stream_id;

    await app.inject({ method: "DELETE", url: `/v1/streams/${id}`, headers: AUTH });
    const second = await app.inject({ method: "DELETE", url: `/v1/streams/${id}`, headers: AUTH });
    expect(second.statusCode).toBe(404);
  });
});

describe("POST /v1/streams per-tenant concurrency cap", () => {
  const CAP_TOKEN = "cap-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const CAP_HASH  = createHash("sha256").update(CAP_TOKEN).digest("hex");
  const CAP_AUTH  = { authorization: `Bearer ${CAP_TOKEN}` };

  beforeAll(async () => {
    await getPool().query("DELETE FROM api_tokens WHERE id = 't_cap'");
    await getPool().query(
      "INSERT INTO api_tokens (id, tenant_id, token_hash) VALUES ('t_cap', 'tenant_cap', $1)",
      [CAP_HASH]
    );
  });

  it("returns 429 STREAM_CAP_EXCEEDED once the cap is reached", async () => {
    process.env.STREAM_MAX_CONCURRENT_PER_TENANT = "2";
    try {
      await getPool().query("DELETE FROM streams WHERE tenant_id = 'tenant_cap'");
      const mk = () => app.inject({
        method: "POST", url: "/v1/streams", headers: CAP_AUTH,
        payload: { source: VALID_SOURCE, output: { target_lang: "en" } },
      });
      expect((await mk()).statusCode).toBe(201);
      expect((await mk()).statusCode).toBe(201);
      const third = await mk();
      expect(third.statusCode).toBe(429);
      expect(third.json().code).toBe("STREAM_CAP_EXCEEDED");
    } finally {
      delete process.env.STREAM_MAX_CONCURRENT_PER_TENANT;
      await getPool().query("DELETE FROM streams WHERE tenant_id = 'tenant_cap'");
    }
  });

  it("does not cap when STREAM_MAX_CONCURRENT_PER_TENANT is unset", async () => {
    await getPool().query("DELETE FROM streams WHERE tenant_id = 'tenant_cap'");
    try {
      for (let i = 0; i < 3; i++) {
        const r = await app.inject({
          method: "POST", url: "/v1/streams", headers: CAP_AUTH,
          payload: { source: VALID_SOURCE, output: { target_lang: "en" } },
        });
        expect(r.statusCode).toBe(201);
      }
    } finally {
      await getPool().query("DELETE FROM streams WHERE tenant_id = 'tenant_cap'");
    }
  });
});
