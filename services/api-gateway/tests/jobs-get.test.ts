import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { buildServer } from "../src/server.js";
import { getPool } from "@audio-api/node-common";

const TOKEN = "test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH = createHash("sha256").update(TOKEN).digest("hex");

beforeAll(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM api_tokens WHERE id = 't_test'");
  await pool.query("INSERT INTO api_tokens (id, tenant_id, token_hash) VALUES ('t_test','tenant_test',$1)", [HASH]);
});

describe("GET /v1/jobs/:id", () => {
  it("returns 404 when not found", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "GET", url: "/v1/jobs/j_doesnotexist",
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns status + analyses when present", async () => {
    const pool = getPool();
    await pool.query("DELETE FROM jobs WHERE id = 'j_t1'");
    await pool.query(
      "INSERT INTO jobs (id, tenant_id, status, input_descriptor, mode) VALUES ($1,$2,'queued','{}'::jsonb,'async')",
      ["j_t1","tenant_test"]
    );
    await pool.query("INSERT INTO analyses (job_id, name, status) VALUES ('j_t1','format','pending')");

    const app = await buildServer();
    const res = await app.inject({
      method: "GET", url: "/v1/jobs/j_t1",
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      job_id: "j_t1", status: "queued",
      analyses: [{ name: "format", status: "pending" }]
    });
    await app.close();
  });
});

describe("GET /v1/jobs/:id/results", () => {
  it("404 when no result yet", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "GET", url: "/v1/jobs/j_t1/results",
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
