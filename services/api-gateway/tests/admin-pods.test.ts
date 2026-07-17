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
    await seedPod({ podId: "p_adm_fresh", status: "ready", heartbeatAgeS: 2 });
    await seedPod({ podId: "p_adm_stale", status: "ready", heartbeatAgeS: 600 });

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
    await seedPod({ podId: "p_adm_mid", status: "ready", heartbeatAgeS: 45 });

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
    await seedPod({ podId: "p_adm_fresh", status: "ready", heartbeatAgeS: 2 });
    await seedPod({ podId: "p_adm_stale", status: "ready", heartbeatAgeS: 600 });

    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/pods?stale=true&limit=200", headers: adminHeaders() });
    const ids = fixturePods(res.json()).map((p: any) => p.pod_id);
    expect(ids).toContain("p_adm_stale");
    expect(ids).not.toContain("p_adm_fresh");
    await app.close();
  });

  describe("settled filter", () => {
    // Settled pods are never deleted and this list sorts oldest-heartbeat-first,
    // so they pile up at the top. Filtering them client-side would look right
    // with a handful of rows and silently hide the live fleet once there are
    // enough corpses to fill `limit`. Hence a SQL filter, and hence these tests.
    const seedFleet = async () => {
      await seedPod({ podId: "p_adm_live", status: "ready", heartbeatAgeS: 2 });
      await seedPod({ podId: "p_adm_boot", status: "starting", heartbeatAgeS: 1 });
      await seedPod({ podId: "p_adm_dead", status: "dead", heartbeatAgeS: 900 });
      await seedPod({ podId: "p_adm_term", status: "terminated", heartbeatAgeS: 900 });
    };

    it("settled=false returns only the live fleet", async () => {
      await seedFleet();
      const app = await buildAdminServer();
      const res = await app.inject({ method: "GET", url: "/v1/admin/pods?settled=false&limit=200", headers: adminHeaders() });
      const ids = fixturePods(res.json()).map((p: any) => p.pod_id).sort();
      // The assertion that catches `<> ANY`: with two settled statuses, that
      // operator is true for every row, so this list would come back with all
      // four and the test would fail here rather than in production.
      expect(ids).toEqual(["p_adm_boot", "p_adm_live"]);
      await app.close();
    });

    it("settled=true returns only the finished pods", async () => {
      await seedFleet();
      const app = await buildAdminServer();
      const res = await app.inject({ method: "GET", url: "/v1/admin/pods?settled=true&limit=200", headers: adminHeaders() });
      const ids = fixturePods(res.json()).map((p: any) => p.pod_id).sort();
      expect(ids).toEqual(["p_adm_dead", "p_adm_term"]);
      await app.close();
    });

    it("omitting settled returns everything", async () => {
      await seedFleet();
      const app = await buildAdminServer();
      const res = await app.inject({ method: "GET", url: "/v1/admin/pods?limit=200", headers: adminHeaders() });
      const ids = fixturePods(res.json()).map((p: any) => p.pod_id).sort();
      // Absent means no filter, matching `stale`. A list that hides rows unless
      // you opt out is how an operator becomes certain a pod does not exist.
      expect(ids).toEqual(["p_adm_boot", "p_adm_dead", "p_adm_live", "p_adm_term"]);
      await app.close();
    });

    it("combines with the stale filter", async () => {
      await seedFleet();
      await seedPod({ podId: "p_adm_zombie", status: "ready", heartbeatAgeS: 900 });
      const app = await buildAdminServer();
      // The pod an operator actually hunts for: still claiming to be alive, but
      // silent. Not settled, and stale.
      const res = await app.inject({ method: "GET", url: "/v1/admin/pods?settled=false&stale=true&limit=200", headers: adminHeaders() });
      expect(fixturePods(res.json()).map((p: any) => p.pod_id)).toEqual(["p_adm_zombie"]);
      await app.close();
    });

    it("rejects a non-boolean settled filter", async () => {
      const app = await buildAdminServer();
      const res = await app.inject({ method: "GET", url: "/v1/admin/pods?settled=maybe", headers: adminHeaders() });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("ADMIN_INVALID_QUERY");
      await app.close();
    });
  });

  it("rejects a non-boolean stale filter", async () => {
    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/pods?stale=maybe", headers: adminHeaders() });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("ADMIN_INVALID_QUERY");
    await app.close();
  });

  it("filters by status", async () => {
    await seedPod({ podId: "p_adm_ready", status: "ready", heartbeatAgeS: 2 });
    await seedPod({ podId: "p_adm_term", status: "terminated", heartbeatAgeS: 2 });

    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/pods?status=terminated&limit=200", headers: adminHeaders() });
    const ids = fixturePods(res.json()).map((p: any) => p.pod_id);
    expect(ids).toEqual(["p_adm_term"]);
    await app.close();
  });

  // tenant_id is not a column on stream_pods; it arrives via the stream the pod
  // is serving.
  it("resolves tenant_id through the stream, and null when the pod serves no stream", async () => {
    await seedPod({ podId: "p_adm_busy", status: "ready", heartbeatAgeS: 2 });
    await seedStream({ id: "s_adm_a1", tenant: TENANT_A, status: "active", createdAt: T0, podId: "p_adm_busy" });
    await getPool().query("UPDATE stream_pods SET stream_id = 's_adm_a1' WHERE pod_id = 'p_adm_busy'");
    await seedPod({ podId: "p_adm_term", status: "terminated", heartbeatAgeS: 2 });

    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/pods?limit=200", headers: adminHeaders() });
    const pods = fixturePods(res.json());
    expect(pods.find((p: any) => p.pod_id === "p_adm_busy").tenant_id).toBe(TENANT_A);
    // A pod serving no stream has no tenant, and it is exactly the row an
    // operator hunting for spare capacity is looking for, so the LEFT JOIN must
    // not drop it.
    expect(pods.find((p: any) => p.pod_id === "p_adm_term").tenant_id).toBeNull();
    await app.close();
  });

  it("sorts oldest heartbeat first", async () => {
    await seedPod({ podId: "p_adm_1", status: "ready", heartbeatAgeS: 5 });
    await seedPod({ podId: "p_adm_2", status: "ready", heartbeatAgeS: 900 });
    await seedPod({ podId: "p_adm_3", status: "ready", heartbeatAgeS: 100 });

    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/pods?limit=200", headers: adminHeaders() });
    const ages = fixturePods(res.json()).map((p: any) => p.heartbeat_age_s);
    // Most-likely-dead first: that is the order an operator reads them in.
    expect(ages).toEqual([...ages].sort((a: number, b: number) => b - a));
    await app.close();
  });
});
