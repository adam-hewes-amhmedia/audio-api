import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { getPool } from "@audio-api/node-common";
import { buildServer } from "../src/server.js";

const ADMIN_TOKEN = "ad_ratelimit-fixture-token-eeeeeeee";
const ADMIN_HASH = createHash("sha256").update(ADMIN_TOKEN).digest("hex");
const TENANT_TOKEN = "test-token-ratelimit-ffffffffffff";
const TENANT_HASH = createHash("sha256").update(TENANT_TOKEN).digest("hex");

// Small enough to exhaust in a test without hammering, restored afterwards.
const MAX = 5;

async function build() {
  process.env.ADMIN_API_ENABLED = "1";
  process.env.ADMIN_RATE_LIMIT_MAX = String(MAX);
  return buildServer();
}

describe("admin rate limit", () => {
  beforeAll(async () => {
    const pool = getPool();
    await pool.query("DELETE FROM admin_tokens WHERE id = 'adm_rl'");
    await pool.query("DELETE FROM api_tokens WHERE id = 't_rl'");
    await pool.query("INSERT INTO admin_tokens (id, token_hash, name) VALUES ($1,$2,$3)", ["adm_rl", ADMIN_HASH, "rl"]);
    await pool.query("INSERT INTO api_tokens (id, tenant_id, token_hash, name) VALUES ($1,$2,$3,$4)", ["t_rl", "tenant_rl", TENANT_HASH, "rl"]);
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("DELETE FROM admin_tokens WHERE id = 'adm_rl'");
    await pool.query("DELETE FROM api_tokens WHERE id = 't_rl'");
    delete process.env.ADMIN_RATE_LIMIT_MAX;
  });

  it("429s an admin caller past the limit", async () => {
    const app = await build();
    const hit = () => app.inject({ method: "GET", url: "/v1/admin/pods", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });

    for (let i = 0; i < MAX; i++) {
      expect((await hit()).statusCode, `request ${i + 1} of ${MAX} should be allowed`).toBe(200);
    }
    const limited = await hit();
    expect(limited.statusCode).toBe(429);
    // Not INTERNAL. The gateway's error handler turns any non-ApiError into a
    // 500, so without the 429 branch this route would claim we broke rather
    // than that we throttled — and a 500 invites the retry a 429 prevents.
    expect(limited.json().code).toBe("RATE_LIMITED");
    await app.close();
  });

  // The reason the hook is registered before requireAdmin. requireAdmin does a
  // Postgres lookup per request; if the limiter ran after it, an anonymous
  // flood would still reach the database at full speed. 429 here (not 401)
  // proves the limiter saw the request first.
  it("limits an anonymous flood before it reaches the database", async () => {
    const app = await build();
    const hit = () => app.inject({ method: "GET", url: "/v1/admin/pods" });

    for (let i = 0; i < MAX; i++) {
      expect((await hit()).statusCode).toBe(401);
    }
    expect((await hit()).statusCode).toBe(429);
    await app.close();
  });

  // The one that matters most. @fastify/rate-limit is fastify-plugin-wrapped, so
  // registering it inside the admin scope would hoist it to the root instance
  // and throttle every customer request — an outage caused by a security fix,
  // and one no admin test would notice. Same failure mode as fp-wrapping the
  // admin auth hook.
  it("does not rate limit the tenant API", async () => {
    const app = await build();

    // Well past the admin limit, on a tenant route.
    for (let i = 0; i < MAX * 3; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/streams/nonexistent",
        headers: { authorization: `Bearer ${TENANT_TOKEN}` },
      });
      expect(res.statusCode, `tenant request ${i + 1} must not be throttled`).toBe(404);
    }
    await app.close();
  });

  it("does not rate limit health", async () => {
    const app = await build();
    for (let i = 0; i < MAX * 3; i++) {
      expect((await app.inject({ method: "GET", url: "/v1/health" })).statusCode).toBe(200);
    }
    await app.close();
  });
});
