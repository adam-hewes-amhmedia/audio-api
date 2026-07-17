import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@audio-api/node-common";
import { buildServer } from "../src/server.js";
import {
  adminHeaders, buildAdminServer, cleanFixtures, seedAdminToken, seedJob, seedStream, seedPod, seedCues,
  TENANT_A, SECRET_SIG, SECRET_SOURCE_URL, SECRET_CALLBACK_URL, SECRET_WEBHOOK,
} from "./helpers/admin.js";

const T0 = "2026-01-01T00:00:00.000Z";

// Scans for the *seeded values*, not for field names.
//
// Asserting `expect(body.source_headers).toBeUndefined()` only catches the leak
// you thought of. Seeding a known secret and then asserting the literal appears
// nowhere in the response catches the field that got renamed on the way out, the
// one that arrived via a join, and the one a worker echoed into a jsonb blob
// three levels down.
const FORBIDDEN: Array<[string, string]> = [
  ["presigned signature", SECRET_SIG],
  ["source url query", SECRET_SOURCE_URL],
  ["callback url secret", SECRET_CALLBACK_URL],
  ["webhook secret", SECRET_WEBHOOK],
  ["sealed headers", "sealed-headers-"],
  ["sealed passphrase", "sealed-passphrase-"],
];

function assertClean(label: string, raw: string) {
  for (const [what, needle] of FORBIDDEN) {
    expect(raw.includes(needle), `${label} leaked ${what}`).toBe(false);
  }
  // Belt and braces: any presigned URL, not just the seeded one.
  expect(raw.includes("X-Amz-Signature"), `${label} leaked a presigned signature`).toBe(false);
}

describe("admin redaction", () => {
  let tokenId = "";

  beforeAll(async () => {
    await cleanFixtures();
    await seedAdminToken();

    await seedStream({ id: "s_adm_a1", tenant: TENANT_A, status: "active", createdAt: T0, podId: "p_adm_1" });
    await seedPod({ podId: "p_adm_1", streamId: "s_adm_a1", status: "ready", heartbeatAgeS: 2 });
    await seedCues("s_adm_a1", 2);
    await seedJob({ id: "j_adm_a1", tenant: TENANT_A, status: "done", createdAt: T0 });

    const pool = getPool();
    await pool.query("INSERT INTO tenant_secrets (tenant_id, webhook_secret) VALUES ($1, $2) ON CONFLICT (tenant_id) DO UPDATE SET webhook_secret = EXCLUDED.webhook_secret", [TENANT_A, SECRET_WEBHOOK]);

    // job_events.payload is worker-written jsonb the gateway does not control.
    // The nesting here is the point: a top-level check would miss this.
    await pool.query(
      `INSERT INTO job_events (job_id, kind, stage, payload) VALUES ('j_adm_a1', 'webhook.attempt', 'callback', $1)`,
      [JSON.stringify({ attempt: 1, request: { url: SECRET_CALLBACK_URL, nested: { deep: { url: SECRET_SOURCE_URL } } } })]
    );
    await pool.query(
      "INSERT INTO results (job_id, report) VALUES ('j_adm_a1', $1)",
      [JSON.stringify({ vad: { ok: true }, debug: { source_url: SECRET_SOURCE_URL } })]
    );
    await pool.query(
      "INSERT INTO api_tokens (id, tenant_id, token_hash, name) VALUES ($1, $2, $3, $4)",
      ["t_adm_red", TENANT_A, "hash_must_never_appear_fixture", "redaction"]
    );
    tokenId = "t_adm_red";
  });

  afterAll(async () => {
    await cleanFixtures();
  });

  // Enumerates the real router rather than a hand-written list, for the same
  // reason the auth sweep does: a route added next year is scanned the day it
  // lands, without anyone choosing to cover it.
  it("leaks no seeded secret from any admin GET route", async () => {
    process.env.ADMIN_API_ENABLED = "1";
    const collected: Array<{ method: string; url: string }> = [];
    const app = await buildServer({
      onRoute: (r) => {
        const ms = Array.isArray(r.method) ? r.method : [r.method];
        for (const m of ms) collected.push({ method: m, url: r.url });
      },
    });
    await app.ready();

    const gets = collected.filter((r) => r.url.startsWith("/v1/admin") && r.method === "GET");
    expect(gets.length).toBeGreaterThan(0);

    for (const r of gets) {
      // Substitute a real fixture id so the route returns a populated row.
      // A 404 would trivially contain no secrets and prove nothing.
      let url = r.url;
      if (url.startsWith("/v1/admin/streams/")) url = url.replace(":id", "s_adm_a1");
      else if (url.startsWith("/v1/admin/jobs/")) url = url.replace(":id", "j_adm_a1");
      else if (url.startsWith("/v1/admin/tokens/")) url = url.replace(":id", tokenId);
      url = url.replace(/:[^/]+/g, "x");

      const res = await app.inject({ method: "GET", url, headers: adminHeaders() });
      // Must be 200, not "200 or 404". A 404 body trivially contains no secrets,
      // so tolerating one would let a new route pass this scan while never
      // having been scanned. If this fails for a route added later, the fix is
      // to seed a fixture for it above — not to relax this assertion.
      expect(res.statusCode, `${url} must return seeded data to be worth scanning`).toBe(200);
      assertClean(`GET ${url}`, res.body);
    }
    await app.close();
  });

  it("keeps the useful part of a redacted url", async () => {
    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/streams/s_adm_a1", headers: adminHeaders() });
    // origin + pathname survives: an operator still knows which bucket and which
    // object. Only the credential-bearing query is dropped.
    expect(res.json().source.url).toBe("https://bucket.example.com/media/a.mp4");
    await app.close();
  });

  it("redacts urls nested deep in worker-written jsonb", async () => {
    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/jobs/j_adm_a1/events", headers: adminHeaders() });
    const payload = res.json().items[0].payload;
    expect(payload.request.url).toBe("https://hooks.example.com/cb/s3cr3t-path-fixture");
    expect(payload.request.nested.deep.url).toBe("https://bucket.example.com/media/a.mp4");
    // Non-url fields are untouched.
    expect(payload.attempt).toBe(1);
    await app.close();
  });

  it("never exposes sealed columns on a stream", async () => {
    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/streams/s_adm_a1", headers: adminHeaders() });
    const body = res.json();
    expect(body).not.toHaveProperty("source_headers");
    expect(body).not.toHaveProperty("source_passphrase");
    expect(body.source).not.toHaveProperty("headers");
    expect(body.source).not.toHaveProperty("passphrase");
    await app.close();
  });

  it("never exposes a token hash", async () => {
    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: `/v1/admin/tokens?tenant_id=${TENANT_A}`, headers: adminHeaders() });
    expect(res.body).not.toContain("hash_must_never_appear_fixture");
    await app.close();
  });
});
