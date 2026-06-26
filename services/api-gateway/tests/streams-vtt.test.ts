import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { buildServer } from "../src/server.js";
import { getPool, createStorage, putObject } from "@audio-api/node-common";

const TOKEN = "vtt-token-cccccccccccccccccccccccccccc";
const HASH  = createHash("sha256").update(TOKEN).digest("hex");
const AUTH  = { authorization: `Bearer ${TOKEN}` };

const SID = "s_vtttest_0001";
const PLAYLIST = "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:03.000\nhello\n";
const SEGMENT  = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nhello\n";
const TTML     = '<?xml version="1.0" encoding="UTF-8"?>\n<tt:tt xmlns:tt="http://www.w3.org/ns/ttml"></tt:tt>\n';

let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM api_tokens WHERE id = 't_vtt'");
  await pool.query(
    "INSERT INTO api_tokens (id, tenant_id, token_hash) VALUES ('t_vtt', 'tenant_vtt', $1)",
    [HASH]
  );
  await pool.query("DELETE FROM streams WHERE id = $1", [SID]);
  await pool.query(
    `INSERT INTO streams (id, tenant_id, status, source_kind, source_url, target_lang)
     VALUES ($1, 'tenant_vtt', 'active', 'hls', 'https://cdn.example.com/x.m3u8', 'en')`,
    [SID]
  );

  const s3 = createStorage();
  await putObject(s3, `streams/${SID}/playlist.vtt`, Buffer.from(PLAYLIST), "text/vtt");
  await putObject(s3, `streams/${SID}/segments/000001.vtt`, Buffer.from(SEGMENT), "text/vtt");
  await putObject(s3, `archives/${SID}/captions.ttml`, Buffer.from(TTML), "application/ttml+xml");

  app = await buildServer();
});

afterAll(async () => {
  await getPool().query("DELETE FROM streams WHERE id = $1", [SID]);
  await app.close();
});

describe("GET /v1/streams/:id/captions.vtt", () => {
  it("streams the live playlist with text/vtt", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/streams/${SID}/captions.vtt`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/vtt");
    expect(r.body).toContain("WEBVTT");
  });

  it("401 without auth", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/streams/${SID}/captions.vtt` });
    expect(r.statusCode).toBe(401);
  });

  it("404 for unknown stream", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/streams/s_nope/captions.vtt`, headers: AUTH });
    expect(r.statusCode).toBe(404);
  });

  it("404 for another tenant's stream", async () => {
    const otherToken = "other-tok-dddddddddddddddddddddddddddd";
    await getPool().query("DELETE FROM api_tokens WHERE id = 't_vtt_other'");
    await getPool().query(
      "INSERT INTO api_tokens (id, tenant_id, token_hash) VALUES ('t_vtt_other', 'tenant_other', $1)",
      [createHash("sha256").update(otherToken).digest("hex")]
    );
    const r = await app.inject({
      method: "GET", url: `/v1/streams/${SID}/captions.vtt`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(r.statusCode).toBe(404);
  });
});

describe("GET /v1/streams/:id/segments/:seg", () => {
  it("streams a segment", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/streams/${SID}/segments/000001.vtt`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/vtt");
    expect(r.body).toContain("WEBVTT");
  });

  it("404 for a missing segment", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/streams/${SID}/segments/999999.vtt`, headers: AUTH });
    expect(r.statusCode).toBe(404);
  });

  it("rejects path-traversal segment names", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/streams/${SID}/segments/..%2f..%2fsecret`, headers: AUTH });
    expect(r.statusCode).toBe(404);
  });
});

describe("GET /v1/streams/:id/captions.ttml", () => {
  it("404 until the stream is archived", async () => {
    await getPool().query("UPDATE streams SET status='active', ttml_object=NULL WHERE id=$1", [SID]);
    const r = await app.inject({ method: "GET", url: `/v1/streams/${SID}/captions.ttml`, headers: AUTH });
    expect(r.statusCode).toBe(404);
  });

  it("200 with the EBU-TT-D archive once archived", async () => {
    await getPool().query(
      "UPDATE streams SET status='archived', ttml_object=$2 WHERE id=$1",
      [SID, `archives/${SID}/captions.ttml`]
    );
    const r = await app.inject({ method: "GET", url: `/v1/streams/${SID}/captions.ttml`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("ttml");
    expect(r.body).toContain("<tt:tt");
  });
});
