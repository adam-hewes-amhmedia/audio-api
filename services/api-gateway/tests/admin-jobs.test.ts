import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getPool } from "@audio-api/node-common";
import {
  adminHeaders, buildAdminServer, cleanFixtures, seedAdminToken, seedJob,
  TENANT_A, TENANT_B,
} from "./helpers/admin.js";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:00:01.000Z";

describe("admin jobs", () => {
  beforeAll(async () => {
    await cleanFixtures();
    await seedAdminToken();
  });

  afterAll(async () => {
    await cleanFixtures();
  });

  beforeEach(async () => {
    await getPool().query("DELETE FROM jobs WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
  });

  it("filters by tenant and never returns another tenant's rows", async () => {
    await seedJob({ id: "j_adm_a1", tenant: TENANT_A, status: "queued", createdAt: T0 });
    await seedJob({ id: "j_adm_b1", tenant: TENANT_B, status: "queued", createdAt: T1 });

    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: `/v1/admin/jobs?tenant_id=${TENANT_A}`, headers: adminHeaders() });
    expect(res.json().items.map((j: any) => j.id)).toEqual(["j_adm_a1"]);
    await app.close();
  });

  it("filters by status", async () => {
    await seedJob({ id: "j_adm_a1", tenant: TENANT_A, status: "queued", createdAt: T0 });
    await seedJob({ id: "j_adm_a2", tenant: TENANT_A, status: "failed", createdAt: T1 });

    const app = await buildAdminServer();
    const res = await app.inject({
      method: "GET", url: `/v1/admin/jobs?tenant_id=${TENANT_A}&status=failed`, headers: adminHeaders(),
    });
    expect(res.json().items.map((j: any) => j.id)).toEqual(["j_adm_a2"]);
    await app.close();
  });

  it("returns a well-formed envelope for an unfiltered list", async () => {
    await seedJob({ id: "j_adm_a1", tenant: TENANT_A, status: "queued", createdAt: T0 });
    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/jobs?limit=5", headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body).toHaveProperty("next_cursor");
    expect(body).not.toHaveProperty("total");
    const times = body.items.map((j: any) => new Date(j.created_at).getTime());
    expect(times).toEqual([...times].sort((a: number, b: number) => b - a));
    await app.close();
  });

  it("returns analyses on the detail view", async () => {
    await seedJob({ id: "j_adm_a1", tenant: TENANT_A, status: "running", createdAt: T0 });
    await getPool().query(
      `INSERT INTO analyses (job_id, name, status, attempts) VALUES ('j_adm_a1', 'vad', 'done', 1), ('j_adm_a1', 'language', 'failed', 3)`
    );

    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/jobs/j_adm_a1", headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.analyses.map((a: any) => a.name)).toEqual(["language", "vad"]);
    // Attempts is what tells an operator whether something retried itself to
    // death or failed once.
    expect(body.analyses.find((a: any) => a.name === "language").attempts).toBe(3);
    await app.close();
  });

  it("404s an unknown job", async () => {
    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/jobs/j_nope", headers: adminHeaders() });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("ADMIN_NOT_FOUND");
    await app.close();
  });

  it("returns results", async () => {
    await seedJob({ id: "j_adm_a1", tenant: TENANT_A, status: "done", createdAt: T0 });
    await getPool().query(
      "INSERT INTO results (job_id, report) VALUES ('j_adm_a1', $1)",
      [JSON.stringify({ vad: { speech_ratio: 0.8 } })]
    );

    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/jobs/j_adm_a1/results", headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.json().report).toEqual({ vad: { speech_ratio: 0.8 } });
    await app.close();
  });

  it("404s results for a job that has none", async () => {
    await seedJob({ id: "j_adm_a1", tenant: TENANT_A, status: "running", createdAt: T0 });
    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/jobs/j_adm_a1/results", headers: adminHeaders() });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns the event timeline oldest first", async () => {
    await seedJob({ id: "j_adm_a1", tenant: TENANT_A, status: "done", createdAt: T0 });
    await getPool().query(
      `INSERT INTO job_events (job_id, ts, kind, stage) VALUES
         ('j_adm_a1', '2026-01-01T00:00:02Z', 'webhook.attempt', 'callback'),
         ('j_adm_a1', '2026-01-01T00:00:00Z', 'job.created', null),
         ('j_adm_a1', '2026-01-01T00:00:01Z', 'job.started', 'vad')`
    );

    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/jobs/j_adm_a1/events", headers: adminHeaders() });
    // A timeline reads forwards, unlike every other list here.
    expect(res.json().items.map((e: any) => e.kind)).toEqual(["job.created", "job.started", "webhook.attempt"]);
    await app.close();
  });

  it("404s events for an unknown job", async () => {
    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/jobs/j_nope/events", headers: adminHeaders() });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
