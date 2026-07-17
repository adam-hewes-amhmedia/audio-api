import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getPool } from "@audio-api/node-common";
import {
  adminHeaders, buildAdminServer, cleanFixtures, seedAdminToken, seedPod, seedStream,
  TENANT_A,
} from "./helpers/admin.js";

const T0 = "2026-01-01T00:00:00.000Z";

describe("admin pods", () => {
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
    await pool.query("DELETE FROM streams WHERE tenant_id = $1", [TENANT_A]);
  });

  const fixturePods = (body: any) => body.items.filter((p: any) => p.pod_id.startsWith("p_adm_"));

  it("flags a pod stale past the threshold and fresh inside it", async () => {
    await seedPod({ podId: "p_adm_fresh", status: "running", heartbeatAgeS: 2 });
    await seedPod({ podId: "p_adm_stale", status: "running", heartbeatAgeS: 600 });

    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/pods?limit=200", headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    const pods = fixturePods(res.json());
    expect(pods.find((p: any) => p.pod_id === "p_adm_fresh").stale).toBe(false);
    expect(pods.find((p: any) => p.pod_id === "p_adm_stale").stale).toBe(true);
    await app.close();
  });

  // The console must not compute staleness itself. If it did, it could disagree
  // with the reaper about whether a pod is alive and the operator would end up
  // debugging the console instead of the fleet.
  it("computes staleness against STREAM_POD_STALE_AFTER_S", async () => {
    const prev = process.env.STREAM_POD_STALE_AFTER_S;
    await seedPod({ podId: "p_adm_mid", status: "running", heartbeatAgeS: 45 });

    process.env.STREAM_POD_STALE_AFTER_S = "30";
    let app = await buildAdminServer();
    let res = await app.inject({ method: "GET", url: "/v1/admin/pods?limit=200", headers: adminHeaders() });
    expect(fixturePods(res.json()).find((p: any) => p.pod_id === "p_adm_mid").stale).toBe(true);
    await app.close();

    // Same pod, same heartbeat, wider threshold: no longer stale.
    process.env.STREAM_POD_STALE_AFTER_S = "120";
    app = await buildAdminServer();
    res = await app.inject({ method: "GET", url: "/v1/admin/pods?limit=200", headers: adminHeaders() });
    expect(fixturePods(res.json()).find((p: any) => p.pod_id === "p_adm_mid").stale).toBe(false);
    await app.close();

    process.env.STREAM_POD_STALE_AFTER_S = prev;
  });

  it("filters by stale", async () => {
    await seedPod({ podId: "p_adm_fresh", status: "running", heartbeatAgeS: 2 });
    await seedPod({ podId: "p_adm_stale", status: "running", heartbeatAgeS: 600 });

    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/pods?stale=true&limit=200", headers: adminHeaders() });
    const ids = fixturePods(res.json()).map((p: any) => p.pod_id);
    expect(ids).toContain("p_adm_stale");
    expect(ids).not.toContain("p_adm_fresh");
    await app.close();
  });

  it("rejects a non-boolean stale filter", async () => {
    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/pods?stale=maybe", headers: adminHeaders() });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("ADMIN_INVALID_QUERY");
    await app.close();
  });

  it("filters by status", async () => {
    await seedPod({ podId: "p_adm_run", status: "running", heartbeatAgeS: 2 });
    await seedPod({ podId: "p_adm_idle", status: "idle", heartbeatAgeS: 2 });

    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/pods?status=idle&limit=200", headers: adminHeaders() });
    const ids = fixturePods(res.json()).map((p: any) => p.pod_id);
    expect(ids).toEqual(["p_adm_idle"]);
    await app.close();
  });

  // tenant_id is not a column on stream_pods; it arrives via the stream the pod
  // is serving.
  it("resolves tenant_id through the stream, and null when the pod is idle", async () => {
    await seedPod({ podId: "p_adm_busy", status: "running", heartbeatAgeS: 2 });
    await seedStream({ id: "s_adm_a1", tenant: TENANT_A, status: "active", createdAt: T0, podId: "p_adm_busy" });
    await getPool().query("UPDATE stream_pods SET stream_id = 's_adm_a1' WHERE pod_id = 'p_adm_busy'");
    await seedPod({ podId: "p_adm_idle", status: "idle", heartbeatAgeS: 2 });

    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/pods?limit=200", headers: adminHeaders() });
    const pods = fixturePods(res.json());
    expect(pods.find((p: any) => p.pod_id === "p_adm_busy").tenant_id).toBe(TENANT_A);
    // An idle pod has no stream, and it is exactly the row an operator hunting
    // for spare capacity is looking for, so it must not be dropped by the join.
    expect(pods.find((p: any) => p.pod_id === "p_adm_idle").tenant_id).toBeNull();
    await app.close();
  });

  it("sorts oldest heartbeat first", async () => {
    await seedPod({ podId: "p_adm_1", status: "running", heartbeatAgeS: 5 });
    await seedPod({ podId: "p_adm_2", status: "running", heartbeatAgeS: 900 });
    await seedPod({ podId: "p_adm_3", status: "running", heartbeatAgeS: 100 });

    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/pods?limit=200", headers: adminHeaders() });
    const ages = fixturePods(res.json()).map((p: any) => p.heartbeat_age_s);
    // Most-likely-dead first: that is the order an operator reads them in.
    expect(ages).toEqual([...ages].sort((a: number, b: number) => b - a));
    await app.close();
  });
});
