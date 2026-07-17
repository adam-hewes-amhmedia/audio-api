import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { getPool } from "@audio-api/node-common";
import { buildServer } from "../src/server.js";
import {
  adminHeaders, buildAdminServer, cleanFixtures, seedAdminToken, seedJob, seedStream,
  TENANT_A, TENANT_B, ADMIN_ID,
} from "./helpers/admin.js";

const T0 = "2026-01-01T00:00:00.000Z";
const NEW_TENANT = "tenant_adm_brand_new";

describe("admin tokens", () => {
  beforeAll(async () => {
    await cleanFixtures();
    await seedAdminToken();
  });

  afterAll(async () => {
    await cleanFixtures();
    const pool = getPool();
    await pool.query("DELETE FROM api_tokens WHERE tenant_id = $1", [NEW_TENANT]);
    await pool.query("DELETE FROM tenant_secrets WHERE tenant_id = $1", [NEW_TENANT]);
    await pool.query("DELETE FROM admin_audit WHERE tenant_id = $1", [NEW_TENANT]);
  });

  beforeEach(async () => {
    const pool = getPool();
    await pool.query("DELETE FROM api_tokens WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B, NEW_TENANT]]);
    await pool.query("DELETE FROM tenant_secrets WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B, NEW_TENANT]]);
    await pool.query("DELETE FROM admin_audit WHERE admin_token_id = $1", [ADMIN_ID]);
    await pool.query("DELETE FROM jobs WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    await pool.query("DELETE FROM streams WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
  });

  // The highest-value test in this file. It does not assert "the hashing matches
  // auth.ts" — it proves it, by issuing a token through the admin API and then
  // authenticating a real tenant route with the plaintext. If admin-auth and
  // auth ever diverge on hashing, this fails instead of shipping a token that
  // can never authenticate.
  it("issues a token that authenticates against a real tenant route", async () => {
    await seedJob({ id: "j_adm_a1", tenant: TENANT_A, status: "queued", createdAt: T0 });

    const admin = await buildAdminServer();
    const issued = await admin.inject({
      method: "POST", url: "/v1/admin/tokens",
      headers: adminHeaders(), payload: { tenant_id: TENANT_A, name: "round-trip" },
    });
    expect(issued.statusCode).toBe(201);
    const token = issued.json().token;
    expect(token).toMatch(/^at_/);
    await admin.close();

    const app = await buildServer();
    const res = await app.inject({
      method: "GET", url: "/v1/streams/nonexistent",
      headers: { authorization: `Bearer ${token}` },
    });
    // 404 from the handler, not 401 from auth: the token authenticated.
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns the plaintext exactly once and stores only the hash", async () => {
    await seedJob({ id: "j_adm_a1", tenant: TENANT_A, status: "queued", createdAt: T0 });

    const app = await buildAdminServer();
    const issued = await app.inject({
      method: "POST", url: "/v1/admin/tokens",
      headers: adminHeaders(), payload: { tenant_id: TENANT_A, name: "show-once" },
    });
    const { token, id } = issued.json();

    const row = await getPool().query("SELECT token_hash FROM api_tokens WHERE id = $1", [id]);
    expect(row.rows[0].token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    // The plaintext is nowhere in the database.
    const anywhere = await getPool().query("SELECT count(*)::int AS n FROM api_tokens WHERE token_hash = $1", [token]);
    expect(anywhere.rows[0].n).toBe(0);

    // Listing never re-reveals it, and never exposes the hash either.
    const list = await app.inject({ method: "GET", url: `/v1/admin/tokens?tenant_id=${TENANT_A}`, headers: adminHeaders() });
    const found = list.json().items.find((t: any) => t.id === id);
    expect(found).not.toHaveProperty("token");
    expect(found).not.toHaveProperty("token_hash");
    await app.close();
  });

  // The guard against silently forking a permanent phantom tenant that nobody
  // can find, because nothing lists tenants except by scanning for ids exactly
  // like the typo.
  it("refuses an unknown tenant without allow_new_tenant", async () => {
    const app = await buildAdminServer();
    const res = await app.inject({
      method: "POST", url: "/v1/admin/tokens",
      headers: adminHeaders(), payload: { tenant_id: NEW_TENANT, name: "typo" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("ADMIN_INVALID_QUERY");
    const rows = await getPool().query("SELECT count(*)::int AS n FROM api_tokens WHERE tenant_id = $1", [NEW_TENANT]);
    expect(rows.rows[0].n).toBe(0);
    await app.close();
  });

  it("creates a new tenant with allow_new_tenant, including a webhook secret", async () => {
    const app = await buildAdminServer();
    const res = await app.inject({
      method: "POST", url: "/v1/admin/tokens",
      headers: adminHeaders(), payload: { tenant_id: NEW_TENANT, name: "deliberate", allow_new_tenant: true },
    });
    expect(res.statusCode).toBe(201);

    // Without this row, worker-webhook silently no-ops: the tenant's webhooks
    // would never fire and never error. Same transaction as the token, because a
    // tenant existing without one is the broken state being avoided.
    const secret = await getPool().query("SELECT webhook_secret FROM tenant_secrets WHERE tenant_id = $1", [NEW_TENANT]);
    expect(secret.rowCount).toBe(1);
    expect(secret.rows[0].webhook_secret).toBeTruthy();
    // Never handed back: rotation gets its own endpoint in phase two.
    expect(res.json()).not.toHaveProperty("webhook_secret");
    await app.close();
  });

  it("recognises a tenant known only from a stream", async () => {
    await seedStream({ id: "s_adm_b1", tenant: TENANT_B, status: "active", createdAt: T0 });
    const app = await buildAdminServer();
    const res = await app.inject({
      method: "POST", url: "/v1/admin/tokens",
      headers: adminHeaders(), payload: { tenant_id: TENANT_B, name: "existing" },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it.each([
    ["", "empty"],
    ["A_UPPER", "uppercase"],
    ["ab", "too short"],
    ["has space", "space"],
    ["_leading", "leading underscore"],
  ])("rejects tenant_id %s (%s)", async (tenant) => {
    const app = await buildAdminServer();
    const res = await app.inject({
      method: "POST", url: "/v1/admin/tokens",
      headers: adminHeaders(), payload: { tenant_id: tenant, name: "x", allow_new_tenant: true },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("requires a name", async () => {
    await seedJob({ id: "j_adm_a1", tenant: TENANT_A, status: "queued", createdAt: T0 });
    const app = await buildAdminServer();
    const res = await app.inject({
      method: "POST", url: "/v1/admin/tokens", headers: adminHeaders(), payload: { tenant_id: TENANT_A },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("audits issuance without recording the token or its hash", async () => {
    await seedJob({ id: "j_adm_a1", tenant: TENANT_A, status: "queued", createdAt: T0 });
    const app = await buildAdminServer();
    const issued = await app.inject({
      method: "POST", url: "/v1/admin/tokens",
      headers: adminHeaders(), payload: { tenant_id: TENANT_A, name: "audited" },
    });
    const { token, id } = issued.json();
    const hash = createHash("sha256").update(token).digest("hex");

    const a = await getPool().query(
      "SELECT admin_token_id, action, target_id, tenant_id, payload::text AS p FROM admin_audit WHERE action = 'token.issue' AND target_id = $1",
      [id]
    );
    expect(a.rowCount).toBe(1);
    expect(a.rows[0].admin_token_id).toBe(ADMIN_ID);
    expect(a.rows[0].tenant_id).toBe(TENANT_A);
    // The hash is a verifier: anything that can read the audit log could
    // otherwise replay it against api_tokens to confirm a guess.
    expect(a.rows[0].p).not.toContain(token);
    expect(a.rows[0].p).not.toContain(hash);
    await app.close();
  });

  it("revokes a token so it stops authenticating", async () => {
    await seedJob({ id: "j_adm_a1", tenant: TENANT_A, status: "queued", createdAt: T0 });
    const admin = await buildAdminServer();
    const issued = await admin.inject({
      method: "POST", url: "/v1/admin/tokens",
      headers: adminHeaders(), payload: { tenant_id: TENANT_A, name: "to-revoke" },
    });
    const { token, id } = issued.json();

    const app = await buildServer();
    const before = await app.inject({ method: "GET", url: "/v1/streams/nope", headers: { authorization: `Bearer ${token}` } });
    expect(before.statusCode).toBe(404);

    const rev = await admin.inject({ method: "POST", url: `/v1/admin/tokens/${id}/revoke`, headers: adminHeaders() });
    expect(rev.statusCode).toBe(200);
    expect(rev.json().revoked_at).toBeTruthy();

    const after = await app.inject({ method: "GET", url: "/v1/streams/nope", headers: { authorization: `Bearer ${token}` } });
    expect(after.statusCode).toBe(401);
    await app.close();
    await admin.close();
  });

  it("revoke is idempotent and does not rewrite when access ended", async () => {
    await seedJob({ id: "j_adm_a1", tenant: TENANT_A, status: "queued", createdAt: T0 });
    const app = await buildAdminServer();
    const issued = await app.inject({
      method: "POST", url: "/v1/admin/tokens",
      headers: adminHeaders(), payload: { tenant_id: TENANT_A, name: "twice" },
    });
    const { id } = issued.json();

    const first = await app.inject({ method: "POST", url: `/v1/admin/tokens/${id}/revoke`, headers: adminHeaders() });
    const second = await app.inject({ method: "POST", url: `/v1/admin/tokens/${id}/revoke`, headers: adminHeaders() });
    expect(second.statusCode).toBe(200);
    // Re-stamping revoked_at would rewrite history about when access actually ended.
    expect(second.json().revoked_at).toBe(first.json().revoked_at);
    await app.close();
  });

  it("404s revoking an unknown token", async () => {
    const app = await buildAdminServer();
    const res = await app.inject({ method: "POST", url: "/v1/admin/tokens/t_nope/revoke", headers: adminHeaders() });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
