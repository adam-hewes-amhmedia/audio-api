import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getPool } from "@audio-api/node-common";
import {
  adminHeaders, buildAdminServer, cleanFixtures, seedAdminToken,
  seedStream, seedPod, seedCues, TENANT_A, TENANT_B, ADMIN_ID,
} from "./helpers/admin.js";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:00:01.000Z";
const T2 = "2026-01-01T00:00:02.000Z";

describe("admin streams", () => {
  beforeAll(async () => {
    await cleanFixtures();
    await seedAdminToken();
  });

  afterAll(async () => {
    await cleanFixtures();
  });

  beforeEach(async () => {
    const pool = getPool();
    await pool.query("DELETE FROM stream_pods WHERE pod_id LIKE 'p_adm_%'");
    await pool.query("DELETE FROM streams WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
    await pool.query("DELETE FROM admin_audit WHERE admin_token_id = $1", [ADMIN_ID]);
  });

  it("filters by tenant and never returns another tenant's rows", async () => {
    await seedStream({ id: "s_adm_a1", tenant: TENANT_A, status: "active", createdAt: T0 });
    await seedStream({ id: "s_adm_b1", tenant: TENANT_B, status: "active", createdAt: T1 });

    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: `/v1/admin/streams?tenant_id=${TENANT_A}`, headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    const ids = res.json().items.map((s: any) => s.id);
    expect(ids).toEqual(["s_adm_a1"]);
    await app.close();
  });

  it("filters by status", async () => {
    await seedStream({ id: "s_adm_a1", tenant: TENANT_A, status: "active", createdAt: T0 });
    await seedStream({ id: "s_adm_a2", tenant: TENANT_A, status: "failed", createdAt: T1 });

    const app = await buildAdminServer();
    const res = await app.inject({
      method: "GET", url: `/v1/admin/streams?tenant_id=${TENANT_A}&status=failed`, headers: adminHeaders(),
    });
    expect(res.json().items.map((s: any) => s.id)).toEqual(["s_adm_a2"]);
    await app.close();
  });

  // Shape and ordering only, never exact membership: this list is cross-tenant
  // and contains whatever every other test file and the smoke runs left behind.
  it("returns a well-formed envelope for an unfiltered list", async () => {
    await seedStream({ id: "s_adm_a1", tenant: TENANT_A, status: "active", createdAt: T0 });

    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/streams?limit=5", headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body).toHaveProperty("next_cursor");
    // No total count, by design: it would cost a full index scan per page and be
    // stale on arrival.
    expect(body).not.toHaveProperty("total");

    const times = body.items.map((s: any) => new Date(s.created_at).getTime());
    expect(times).toEqual([...times].sort((a: number, b: number) => b - a));
    await app.close();
  });

  it("returns the pod on the detail view, including a stale one", async () => {
    await seedPod({ podId: "p_adm_1", streamId: null, status: "ready", heartbeatAgeS: 600 });
    await seedStream({ id: "s_adm_a1", tenant: TENANT_A, status: "active", createdAt: T0, podId: "p_adm_1" });

    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/streams/s_adm_a1", headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pod.pod_id).toBe("p_adm_1");
    // A pod that stopped heartbeating is usually the answer to "why is this
    // stream stuck", so it must be shown, flagged, not hidden.
    expect(body.pod.stale).toBe(true);
    expect(body.pod.heartbeat_age_s).toBeGreaterThan(30);
    await app.close();
  });

  it("returns pod: null when the stream has no pod", async () => {
    await seedStream({ id: "s_adm_a1", tenant: TENANT_A, status: "provisioning", createdAt: T0, podId: null });
    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/streams/s_adm_a1", headers: adminHeaders() });
    expect(res.json().pod).toBeNull();
    await app.close();
  });

  it("404s an unknown stream", async () => {
    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/streams/s_nope", headers: adminHeaders() });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("ADMIN_NOT_FOUND");
    await app.close();
  });

  it("serves cues from a watermark", async () => {
    await seedStream({ id: "s_adm_a1", tenant: TENANT_A, status: "active", createdAt: T0, cueCount: 3 });
    await seedCues("s_adm_a1", 3);

    const app = await buildAdminServer();
    const all = await app.inject({ method: "GET", url: "/v1/admin/streams/s_adm_a1/cues", headers: adminHeaders() });
    expect(all.json().items.map((c: any) => c.cue_id)).toEqual([1, 2, 3]);

    const since = await app.inject({ method: "GET", url: "/v1/admin/streams/s_adm_a1/cues?since=2", headers: adminHeaders() });
    expect(since.json().items.map((c: any) => c.cue_id)).toEqual([3]);
    expect(since.json().items[0].text).toBe("cue text 3");
    await app.close();
  });

  it("audits the first cue read but not every poll", async () => {
    await seedStream({ id: "s_adm_a1", tenant: TENANT_A, status: "active", createdAt: T0 });
    await seedCues("s_adm_a1", 2);

    const app = await buildAdminServer();
    await app.inject({ method: "GET", url: "/v1/admin/streams/s_adm_a1/cues", headers: adminHeaders() });
    await app.inject({ method: "GET", url: "/v1/admin/streams/s_adm_a1/cues?since=1", headers: adminHeaders() });
    await app.inject({ method: "GET", url: "/v1/admin/streams/s_adm_a1/cues?since=2", headers: adminHeaders() });

    const r = await getPool().query(
      "SELECT count(*)::int AS n FROM admin_audit WHERE action = 'stream.cues.view' AND target_id = 's_adm_a1'"
    );
    // One row for the initial read; the polls that follow must not each write one
    // or a single viewer would produce a row a second.
    expect(r.rows[0].n).toBe(1);
    await app.close();
  });

  it("rejects a non-integer cue watermark", async () => {
    await seedStream({ id: "s_adm_a1", tenant: TENANT_A, status: "active", createdAt: T0 });
    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/streams/s_adm_a1/cues?since=abc", headers: adminHeaders() });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("ADMIN_INVALID_QUERY");
    await app.close();
  });

  describe("kill", () => {
    it("moves a killable stream to ending and audits it with the reason", async () => {
      await seedStream({ id: "s_adm_a1", tenant: TENANT_A, status: "active", createdAt: T0 });

      const app = await buildAdminServer();
      const res = await app.inject({
        method: "POST", url: "/v1/admin/streams/s_adm_a1/kill",
        headers: adminHeaders(), payload: { reason: "stuck on ingest" },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ stream_id: "s_adm_a1", status: "ending" });

      const row = await getPool().query("SELECT status FROM streams WHERE id = 's_adm_a1'");
      expect(row.rows[0].status).toBe("ending");

      const a = await getPool().query(
        "SELECT action, tenant_id, payload, admin_token_id FROM admin_audit WHERE target_id = 's_adm_a1' AND action = 'stream.kill'"
      );
      expect(a.rowCount).toBe(1);
      expect(a.rows[0].tenant_id).toBe(TENANT_A);
      expect(a.rows[0].payload).toEqual({ reason: "stuck on ingest" });
      // Attributable to a specific token, which is the reason admin_tokens is a
      // table rather than a shared env var.
      expect(a.rows[0].admin_token_id).toBe(ADMIN_ID);
      await app.close();
    });

    it.each(["provisioning", "awaiting_ingest", "active"])("kills a stream in %s", async (status) => {
      await seedStream({ id: "s_adm_a1", tenant: TENANT_A, status, createdAt: T0 });
      const app = await buildAdminServer();
      const res = await app.inject({ method: "POST", url: "/v1/admin/streams/s_adm_a1/kill", headers: adminHeaders(), payload: {} });
      expect(res.statusCode).toBe(202);
      await app.close();
    });

    // The state machine is not negotiable for admin either: an operator who can
    // drag an archived stream back to 'ending' strands the reaper.
    it.each(["ending", "ended", "archived", "failed"])("409s a stream in %s", async (status) => {
      await seedStream({ id: "s_adm_a1", tenant: TENANT_A, status, createdAt: T0 });
      const app = await buildAdminServer();
      const res = await app.inject({ method: "POST", url: "/v1/admin/streams/s_adm_a1/kill", headers: adminHeaders(), payload: {} });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("ADMIN_INVALID_STATE");
      await app.close();
    });

    // Admin distinguishes these two; the tenant route collapses both to 404 so it
    // cannot confirm another tenant's stream exists. An operator needs to know
    // whether they typed the id wrong or the stream already finished.
    it("404s an unknown stream rather than 409", async () => {
      const app = await buildAdminServer();
      const res = await app.inject({ method: "POST", url: "/v1/admin/streams/s_nope/kill", headers: adminHeaders(), payload: {} });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("ADMIN_NOT_FOUND");
      await app.close();
    });

    it("kills across tenants without a tenant filter", async () => {
      await seedStream({ id: "s_adm_b1", tenant: TENANT_B, status: "active", createdAt: T2 });
      const app = await buildAdminServer();
      const res = await app.inject({ method: "POST", url: "/v1/admin/streams/s_adm_b1/kill", headers: adminHeaders(), payload: {} });
      expect(res.statusCode).toBe(202);
      await app.close();
    });
  });
});
