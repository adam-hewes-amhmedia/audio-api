import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@audio-api/node-common";
import {
  adminHeaders, buildAdminServer, cleanFixtures, seedAdminToken, seedJob, seedStream,
  TENANT_A, TENANT_B,
} from "./helpers/admin.js";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";

describe("admin tenants", () => {
  beforeAll(async () => {
    await cleanFixtures();
    await seedAdminToken();

    await seedJob({ id: "j_adm_a1", tenant: TENANT_A, status: "queued", createdAt: T0 });
    await seedJob({ id: "j_adm_a2", tenant: TENANT_A, status: "done", createdAt: T1 });
    await seedStream({ id: "s_adm_a1", tenant: TENANT_A, status: "active", createdAt: T0 });
    await getPool().query(
      "INSERT INTO api_tokens (id, tenant_id, token_hash, name) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)",
      ["t_adm_ten1", TENANT_A, "hash_ten_1", "live", "t_adm_ten2", TENANT_A, "hash_ten_2", "dead"]
    );
    await getPool().query("UPDATE api_tokens SET revoked_at = now() WHERE id = 't_adm_ten2'");

    // Known only from a stream: no jobs, no tokens. Proves the UNION reaches
    // every table that carries a tenant_id rather than just the obvious one.
    await seedStream({ id: "s_adm_b1", tenant: TENANT_B, status: "ended", createdAt: T0 });
  });

  afterAll(async () => {
    await cleanFixtures();
  });

  const find = (body: any, tenant: string) => body.items.find((t: any) => t.tenant_id === tenant);

  it("derives tenants and counts from the tables that carry a tenant_id", async () => {
    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/tenants", headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const a = find(body, TENANT_A);
    expect(a.job_count).toBe(2);
    expect(a.stream_count).toBe(1);
    // Active vs total matters: a tenant whose only token is revoked has no
    // access, and the console must not imply otherwise.
    expect(a.active_token_count).toBe(1);
    expect(a.total_token_count).toBe(2);
    await app.close();
  });

  it("includes a tenant that exists only as a stream", async () => {
    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/tenants", headers: adminHeaders() });
    const b = find(res.json(), TENANT_B);
    // A tenant is not a record anywhere; it is a string on a row. Miss a table
    // in the UNION and a real tenant becomes invisible.
    expect(b).toBeTruthy();
    expect(b.stream_count).toBe(1);
    expect(b.job_count).toBe(0);
    expect(b.active_token_count).toBe(0);
    await app.close();
  });

  it("reports last activity as the newest of jobs and streams", async () => {
    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/tenants", headers: adminHeaders() });
    const a = find(res.json(), TENANT_A);
    expect(new Date(a.last_activity_at).toISOString()).toBe(new Date(T1).toISOString());
    await app.close();
  });

  it("returns a sorted envelope", async () => {
    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/tenants", headers: adminHeaders() });
    const body = res.json();
    expect(body).toHaveProperty("next_cursor");
    const ids = body.items.map((t: any) => t.tenant_id);
    expect(ids).toEqual([...ids].sort());
    await app.close();
  });
});
