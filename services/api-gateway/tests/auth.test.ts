import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { buildServer } from "../src/server.js";
import { getPool } from "@audio-api/node-common";

const TEST_TOKEN = "test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TEST_HASH = createHash("sha256").update(TEST_TOKEN).digest("hex");

describe("auth", () => {
  beforeEach(async () => {
    const pool = getPool();
    await pool.query("DELETE FROM api_tokens WHERE id = 't_test'");
    await pool.query(
      "INSERT INTO api_tokens (id, tenant_id, token_hash, name) VALUES ($1, $2, $3, $4)",
      ["t_test", "tenant_test", TEST_HASH, "test"]
    );
  });

  it("401 without token on protected route", async () => {
    const app = await buildServer();
    app.get("/__whoami", { onRequest: app.requireAuth }, async (req: any) => ({ tenant: req.tenant_id }));
    const res = await app.inject({ method: "GET", url: "/__whoami" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("attaches tenant_id when token is valid", async () => {
    const app = await buildServer();
    app.get("/__whoami", { onRequest: app.requireAuth }, async (req: any) => ({ tenant: req.tenant_id }));
    const res = await app.inject({
      method: "GET", url: "/__whoami",
      headers: { authorization: `Bearer ${TEST_TOKEN}` }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenant: "tenant_test" });
    await app.close();
  });
});
