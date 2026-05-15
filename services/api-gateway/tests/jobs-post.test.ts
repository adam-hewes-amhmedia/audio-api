import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { buildServer } from "../src/server.js";
import { getPool } from "@audio-api/node-common";

const TOKEN = "test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH = createHash("sha256").update(TOKEN).digest("hex");

beforeAll(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM api_tokens WHERE id = 't_test'");
  await pool.query(
    "INSERT INTO api_tokens (id, tenant_id, token_hash) VALUES ($1,$2,$3)",
    ["t_test", "tenant_test", HASH]
  );
});

describe("POST /v1/jobs", () => {
  it("400 on missing input", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "POST", url: "/v1/jobs",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { analyses: ["format"] }
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("201 returns job_id queued", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "POST", url: "/v1/jobs",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { input: { type: "url", url: "https://example.com/a.wav" }, analyses: ["format"] }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.job_id).toMatch(/^j_/);
    expect(body.status).toBe("queued");
    const r = await getPool().query("SELECT status FROM jobs WHERE id = $1", [body.job_id]);
    expect(r.rows[0].status).toBe("queued");
    const a = await getPool().query("SELECT status FROM analyses WHERE job_id = $1 AND name='format'", [body.job_id]);
    expect(a.rows[0].status).toBe("pending");
    await app.close();
  });

  it("accepts vad as an analysis", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "POST", url: "/v1/jobs",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { input: { type: "url", url: "https://example.com/a.wav" }, analyses: ["format", "vad"] }
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it("accepts language and dme_classify", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "POST", url: "/v1/jobs",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        input: { type: "url", url: "https://example.com/a.wav" },
        analyses: ["format", "vad", "language", "dme_classify"]
      }
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });
});
