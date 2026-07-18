import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getPool } from "@audio-api/node-common";
import {
  adminHeaders, buildAdminServer, cleanFixtures, seedAdminToken, ADMIN_ID,
} from "./helpers/admin.js";

// The deployment defaults the gateway reports come from process.env (the four
// POD_* vars moved into .env for exactly this reason). Pin them here so `default`
// and `source` are deterministic regardless of the ambient shell.
const ENV_DEFAULTS = {
  POD_MAX_DURATION_S: "30",
  POD_IDLE_TIMEOUT_S: "30",
  POD_RECONNECT_WINDOW_S: "60",
  POD_MODEL_SIZE: "small",
};

async function clearSettings() {
  await getPool().query("DELETE FROM settings");
}

describe("admin settings", () => {
  beforeAll(async () => {
    Object.assign(process.env, ENV_DEFAULTS);
    await cleanFixtures();
    await seedAdminToken();
  });

  afterAll(async () => {
    await clearSettings();
    await cleanFixtures();
  });

  beforeEach(async () => {
    await clearSettings();
    await getPool().query("DELETE FROM admin_audit WHERE admin_token_id = $1", [ADMIN_ID]);
  });

  // Empty table must behave exactly like today: every setting falls back to its
  // env default. This is the proof that adding the table changed no behaviour.
  it("reports every setting from the environment when the table is empty", async () => {
    const app = await buildAdminServer();
    const res = await app.inject({ method: "GET", url: "/v1/admin/settings", headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pod_max_duration_s).toEqual({ value: null, default: 30, effective: 30, source: "environment" });
    expect(body.pod_idle_timeout_s).toEqual({ value: null, default: 30, effective: 30, source: "environment" });
    expect(body.pod_reconnect_window_s).toEqual({ value: null, default: 60, effective: 60, source: "environment" });
    expect(body.pod_model_size).toEqual({ value: null, default: "small", effective: "small", source: "environment" });
    await app.close();
  });

  it("reports a database-set value as source=database with the effective override", async () => {
    const app = await buildAdminServer();
    await app.inject({
      method: "PUT", url: "/v1/admin/settings",
      headers: adminHeaders(), payload: { pod_max_duration_s: 300 },
    });
    const res = await app.inject({ method: "GET", url: "/v1/admin/settings", headers: adminHeaders() });
    expect(res.json().pod_max_duration_s).toEqual({ value: 300, default: 30, effective: 300, source: "database" });
    // A setting not touched stays on the environment default.
    expect(res.json().pod_idle_timeout_s).toEqual({ value: null, default: 30, effective: 30, source: "environment" });
    await app.close();
  });

  it("treats an absent key as leave-alone and an explicit null as unset", async () => {
    const app = await buildAdminServer();
    // Set two values.
    await app.inject({
      method: "PUT", url: "/v1/admin/settings",
      headers: adminHeaders(), payload: { pod_max_duration_s: 300, pod_idle_timeout_s: 45 },
    });
    // Second PUT: null unsets duration, idle_timeout is absent so must survive.
    await app.inject({
      method: "PUT", url: "/v1/admin/settings",
      headers: adminHeaders(), payload: { pod_max_duration_s: null },
    });
    const res = await app.inject({ method: "GET", url: "/v1/admin/settings", headers: adminHeaders() });
    expect(res.json().pod_max_duration_s.source).toBe("environment");
    expect(res.json().pod_max_duration_s.value).toBe(null);
    expect(res.json().pod_idle_timeout_s.value).toBe(45);
    await app.close();
  });

  it("accepts 0 as unlimited for max duration", async () => {
    const app = await buildAdminServer();
    await app.inject({
      method: "PUT", url: "/v1/admin/settings",
      headers: adminHeaders(), payload: { pod_max_duration_s: 0 },
    });
    const res = await app.inject({ method: "GET", url: "/v1/admin/settings", headers: adminHeaders() });
    expect(res.json().pod_max_duration_s).toEqual({ value: 0, default: 30, effective: 0, source: "database" });
    await app.close();
  });

  it("never creates a second settings row (upsert against id=1)", async () => {
    const app = await buildAdminServer();
    await app.inject({ method: "PUT", url: "/v1/admin/settings", headers: adminHeaders(), payload: { pod_max_duration_s: 100 } });
    await app.inject({ method: "PUT", url: "/v1/admin/settings", headers: adminHeaders(), payload: { pod_idle_timeout_s: 20 } });
    const n = await getPool().query("SELECT count(*)::int AS n FROM settings");
    expect(n.rows[0].n).toBe(1);
    await app.close();
  });

  it.each([
    [{ pod_max_duration_s: -1 }, "negative duration"],
    [{ pod_idle_timeout_s: 0 }, "zero idle timeout"],
    [{ pod_reconnect_window_s: -5 }, "negative reconnect"],
    [{ pod_model_size: "gigantic" }, "unknown model"],
    [{ pod_max_duration_s: 1.5 }, "non-integer"],
    [{ pod_max_duration_s: "300" }, "string not number"],
  ])("rejects %o (%s) with ADMIN_INVALID_QUERY", async (payload) => {
    const app = await buildAdminServer();
    const res = await app.inject({ method: "PUT", url: "/v1/admin/settings", headers: adminHeaders(), payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("ADMIN_INVALID_QUERY");
    // A rejected write must not have partially applied.
    const n = await getPool().query("SELECT count(*)::int AS n FROM settings");
    expect(n.rows[0].n).toBe(0);
    await app.close();
  });

  it("accepts every valid model size", async () => {
    const app = await buildAdminServer();
    for (const size of ["tiny", "base", "small", "medium", "large-v3"]) {
      const res = await app.inject({ method: "PUT", url: "/v1/admin/settings", headers: adminHeaders(), payload: { pod_model_size: size } });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });

  it("writes an audit row with before and after", async () => {
    const app = await buildAdminServer();
    await app.inject({ method: "PUT", url: "/v1/admin/settings", headers: adminHeaders(), payload: { pod_max_duration_s: 300 } });

    // Scope to this test's own admin token: the count assertion mirrors the
    // beforeEach cleanup (which clears admin_audit for ADMIN_ID only), so a
    // shared dev DB carrying settings.update rows from other tokens can't skew it.
    const a = await getPool().query(
      "SELECT admin_token_id, action, target_type, target_id, payload::text AS p FROM admin_audit WHERE action = 'settings.update' AND admin_token_id = $1",
      [ADMIN_ID]
    );
    expect(a.rowCount).toBe(1);
    expect(a.rows[0].admin_token_id).toBe(ADMIN_ID);
    expect(a.rows[0].target_type).toBe("settings");
    const payload = JSON.parse(a.rows[0].p);
    expect(payload.before.pod_max_duration_s).toBe(null);
    expect(payload.after.pod_max_duration_s).toBe(300);
    await app.close();
  });

  it("stamps updated_by with the admin token id", async () => {
    const app = await buildAdminServer();
    await app.inject({ method: "PUT", url: "/v1/admin/settings", headers: adminHeaders(), payload: { pod_model_size: "medium" } });
    const row = await getPool().query("SELECT updated_by FROM settings WHERE id = 1");
    expect(row.rows[0].updated_by).toBe(ADMIN_ID);
    await app.close();
  });
});
