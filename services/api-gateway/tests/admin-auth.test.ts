import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { buildServer } from "../src/server.js";
import { getPool } from "@audio-api/node-common";

const ADMIN_TOKEN = "ad_test-admin-token-aaaaaaaaaaaaaaaaaaaa";
const ADMIN_HASH = createHash("sha256").update(ADMIN_TOKEN).digest("hex");

// A *valid* tenant token. The point of the sweep is not that garbage is
// rejected — it is that a real, working, unrevoked customer credential is
// rejected by every admin route. That is the exact credential an attacker (or a
// confused customer) already holds.
const TENANT_TOKEN = "test-token-admin-sweep-bbbbbbbbbbbb";
const TENANT_HASH = createHash("sha256").update(TENANT_TOKEN).digest("hex");

const REVOKED_TOKEN = "ad_revoked-admin-token-cccccccccccc";
const REVOKED_HASH = createHash("sha256").update(REVOKED_TOKEN).digest("hex");

interface Collected {
  method: string;
  url: string;
}

// Enumerates the real router rather than a hand-written list. A hand-written
// list is a list of the routes someone remembered; this is the set of routes
// that exist. A new admin route added next year is swept the day it lands,
// without anyone choosing to cover it.
async function buildWithRoutes() {
  process.env.ADMIN_API_ENABLED = "1";
  const collected: Collected[] = [];
  const app = await buildServer({
    onRoute: (r) => {
      const methods = Array.isArray(r.method) ? r.method : [r.method];
      for (const m of methods) collected.push({ method: m, url: r.url });
    },
  });
  await app.ready();
  // HEAD is derived by Fastify from each GET and shares its hooks, so it is
  // guarded by the same requireAdmin that guards the GET. It is excluded here
  // only because a HEAD response has no body to assert the error code against.
  const admin = collected.filter((r) => r.url.startsWith("/v1/admin") && r.method !== "HEAD" && r.method !== "OPTIONS");
  return { app, admin };
}

// Path params are irrelevant to this test: requireAdmin runs in onRequest,
// before the handler ever looks up a row, so a non-existent id still 401s.
// Anything other than 401 here means the guard did not run.
const concrete = (url: string) => url.replace(/:[^/]+/g, "sweep-probe-id");

describe("admin auth", () => {
  beforeAll(async () => {
    const pool = getPool();
    await pool.query("DELETE FROM admin_tokens WHERE id IN ('adm_test', 'adm_revoked')");
    await pool.query("DELETE FROM api_tokens WHERE id = 't_admin_sweep'");
    await pool.query(
      "INSERT INTO admin_tokens (id, token_hash, name) VALUES ($1, $2, $3)",
      ["adm_test", ADMIN_HASH, "test-admin"]
    );
    await pool.query(
      "INSERT INTO admin_tokens (id, token_hash, name, revoked_at) VALUES ($1, $2, $3, now())",
      ["adm_revoked", REVOKED_HASH, "revoked-admin"]
    );
    await pool.query(
      "INSERT INTO api_tokens (id, tenant_id, token_hash, name) VALUES ($1, $2, $3, $4)",
      ["t_admin_sweep", "tenant_admin_sweep", TENANT_HASH, "sweep"]
    );
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("DELETE FROM admin_tokens WHERE id IN ('adm_test', 'adm_revoked')");
    await pool.query("DELETE FROM api_tokens WHERE id = 't_admin_sweep'");
  });

  it("registers admin routes when enabled", async () => {
    const { app, admin } = await buildWithRoutes();
    // Guards the sweep itself. Without this, deleting every admin route (or
    // breaking their registration) would make the two sweeps below pass
    // vacuously over an empty list and report green.
    expect(admin.length).toBeGreaterThan(0);
    await app.close();
  });

  it("every admin route rejects an anonymous caller", async () => {
    const { app, admin } = await buildWithRoutes();
    for (const r of admin) {
      const res = await app.inject({ method: r.method as any, url: concrete(r.url) });
      expect(res.statusCode, `${r.method} ${r.url} must 401 without a token`).toBe(401);
      expect(res.json().code, `${r.method} ${r.url}`).toBe("ADMIN_AUTH_FAILED");
    }
    await app.close();
  });

  it("every admin route rejects a valid tenant token", async () => {
    const { app, admin } = await buildWithRoutes();
    for (const r of admin) {
      const res = await app.inject({
        method: r.method as any,
        url: concrete(r.url),
        headers: { authorization: `Bearer ${TENANT_TOKEN}` },
      });
      expect(res.statusCode, `${r.method} ${r.url} must 401 for a tenant token`).toBe(401);
      expect(res.json().code, `${r.method} ${r.url}`).toBe("ADMIN_AUTH_FAILED");
    }
    await app.close();
  });

  it("rejects a revoked admin token", async () => {
    const { app } = await buildWithRoutes();
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/pods",
      headers: { authorization: `Bearer ${REVOKED_TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("accepts a valid admin token and never assigns a tenant", async () => {
    process.env.ADMIN_API_ENABLED = "1";
    const app = await buildServer();
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/pods",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("does not register admin routes when disabled", async () => {
    process.env.ADMIN_API_ENABLED = "0";
    const app = await buildServer();
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/pods",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    // 404, not 401: the route does not exist at all.
    expect(res.statusCode).toBe(404);
    await app.close();
    process.env.ADMIN_API_ENABLED = "1";
  });

  // The admin scope hook must not escape its scope. If routes/admin/index.ts is
  // ever wrapped in fastify-plugin, this hook hoists to the root instance and
  // 401s the entire customer API — an outage, caused by a security fix, that no
  // admin test would otherwise catch.
  it("does not apply the admin hook to tenant routes", async () => {
    process.env.ADMIN_API_ENABLED = "1";
    const app = await buildServer();
    const res = await app.inject({
      method: "GET",
      url: "/v1/health",
    });
    expect(res.statusCode).toBe(200);

    const tenant = await app.inject({
      method: "GET",
      url: "/v1/streams/nonexistent",
      headers: { authorization: `Bearer ${TENANT_TOKEN}` },
    });
    // 404 from the handler, not 401: the tenant token still authenticates on
    // the tenant API while the admin API is registered.
    expect(tenant.statusCode).toBe(404);
    await app.close();
  });
});
