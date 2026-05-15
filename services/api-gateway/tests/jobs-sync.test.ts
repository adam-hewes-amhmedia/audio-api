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

describe("POST /v1/jobs sync mode", () => {
  it("returns 202 when not completed within timeout", async () => {
    process.env.SYNC_TIMEOUT_MS = "100";
    const app = await buildServer();
    const res = await app.inject({
      method: "POST", url: "/v1/jobs",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { input: { type: "url", url: "https://example.invalid/a.wav" }, analyses: ["format"], mode: "sync" }
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().job_id).toMatch(/^j_/);
    await app.close();
  });
});
