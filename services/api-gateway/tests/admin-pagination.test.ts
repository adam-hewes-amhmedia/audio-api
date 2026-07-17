import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getPool } from "@audio-api/node-common";
import {
  adminHeaders, buildAdminServer, cleanFixtures, seedAdminToken, seedJob, TENANT_A,
} from "./helpers/admin.js";
import { encodeCursor, decodeCursor, parseLimit } from "../src/routes/admin/pagination.js";

// Spaced a second apart so ordering is deterministic. Rows sharing now() would
// make "newest first" ambiguous and this suite flaky.
const at = (i: number) => `2026-03-01T00:00:${String(i).padStart(2, "0")}.000Z`;

describe("admin pagination", () => {
  beforeAll(async () => {
    await cleanFixtures();
    await seedAdminToken();
  });

  afterAll(async () => {
    await cleanFixtures();
  });

  beforeEach(async () => {
    await getPool().query("DELETE FROM jobs WHERE tenant_id = $1", [TENANT_A]);
  });

  describe("cursor codec", () => {
    it("round-trips", () => {
      const c = encodeCursor("2026-03-01T00:00:05.000Z", "j_abc");
      expect(decodeCursor(c)).toEqual({ ts: "2026-03-01T00:00:05.000Z", id: "j_abc" });
    });

    it("survives an id containing the separator", () => {
      // Split on the *first* separator, so an id with a pipe in it still decodes.
      const c = encodeCursor("2026-03-01T00:00:05.000Z", "j_a|b");
      expect(decodeCursor(c).id).toBe("j_a|b");
    });

    it.each([
      ["not-base64-!!!", "garbage"],
      ["", "empty"],
      [Buffer.from("no-separator").toString("base64url"), "no separator"],
      [Buffer.from("not-a-date|j_1").toString("base64url"), "bad timestamp"],
      [Buffer.from("|j_1").toString("base64url"), "empty timestamp"],
      [Buffer.from("2026-03-01T00:00:05.000Z|").toString("base64url"), "empty id"],
    ])("rejects %s (%s)", (raw) => {
      // A hand-crafted or truncated cursor must fail loudly rather than be
      // coerced into a silently wrong window.
      expect(() => decodeCursor(raw)).toThrow();
    });
  });

  describe("limit", () => {
    it("defaults and clamps", () => {
      expect(parseLimit(undefined)).toBe(50);
      expect(parseLimit("10")).toBe(10);
      // A console asking for 10000 is a bug in the console; serving 200 keeps
      // the operator moving.
      expect(parseLimit("10000")).toBe(200);
    });

    it.each(["0", "-1", "abc", "1.5"])("rejects %s", (v) => {
      // Different from a too-large limit: the caller believes something false.
      expect(() => parseLimit(v)).toThrow();
    });
  });

  describe("keyset paging over a real table", () => {
    it("walks every row exactly once with no duplicates or gaps", async () => {
      for (let i = 1; i <= 7; i++) {
        await seedJob({ id: `j_adm_p${i}`, tenant: TENANT_A, status: "queued", createdAt: at(i) });
      }

      const app = await buildAdminServer();
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const url: string = `/v1/admin/jobs?tenant_id=${TENANT_A}&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const res = await app.inject({ method: "GET", url, headers: adminHeaders() });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        seen.push(...body.items.map((j: any) => j.id));
        cursor = body.next_cursor;
        if (!cursor) break;
      }

      expect(seen).toEqual(["j_adm_p7", "j_adm_p6", "j_adm_p5", "j_adm_p4", "j_adm_p3", "j_adm_p2", "j_adm_p1"]);
      expect(new Set(seen).size).toBe(7);
      await app.close();
    });

    // The reason this is keyset and not OFFSET. With OFFSET, a row inserted
    // between page 1 and page 2 shifts everything down one: the console shows a
    // duplicate at the top of page 2 and silently skips a row at the boundary.
    // Neither is visible to the operator, which is the worst property a triage
    // tool can have.
    it("does not duplicate or skip when a row is inserted mid-walk", async () => {
      for (let i = 1; i <= 6; i++) {
        await seedJob({ id: `j_adm_p${i}`, tenant: TENANT_A, status: "queued", createdAt: at(i) });
      }

      const app = await buildAdminServer();
      const first = await app.inject({
        method: "GET", url: `/v1/admin/jobs?tenant_id=${TENANT_A}&limit=3`, headers: adminHeaders(),
      });
      const page1 = first.json().items.map((j: any) => j.id);
      expect(page1).toEqual(["j_adm_p6", "j_adm_p5", "j_adm_p4"]);

      // Newest row yet: with OFFSET 3 this would push j_adm_p4 onto page 2 and
      // it would be returned twice.
      await seedJob({ id: "j_adm_p99", tenant: TENANT_A, status: "queued", createdAt: at(59) });

      const second = await app.inject({
        method: "GET",
        url: `/v1/admin/jobs?tenant_id=${TENANT_A}&limit=3&cursor=${encodeURIComponent(first.json().next_cursor)}`,
        headers: adminHeaders(),
      });
      const page2 = second.json().items.map((j: any) => j.id);

      expect(page2).toEqual(["j_adm_p3", "j_adm_p2", "j_adm_p1"]);
      expect(page1.filter((id: string) => page2.includes(id))).toEqual([]);
      await app.close();
    });

    it("returns a null cursor on a short page", async () => {
      await seedJob({ id: "j_adm_p1", tenant: TENANT_A, status: "queued", createdAt: at(1) });
      const app = await buildAdminServer();
      const res = await app.inject({
        method: "GET", url: `/v1/admin/jobs?tenant_id=${TENANT_A}&limit=10`, headers: adminHeaders(),
      });
      // The only end-of-list signal the console needs.
      expect(res.json().next_cursor).toBeNull();
      await app.close();
    });

    it("400s a malformed cursor rather than ignoring it", async () => {
      const app = await buildAdminServer();
      const res = await app.inject({
        method: "GET", url: "/v1/admin/jobs?cursor=not-a-real-cursor", headers: adminHeaders(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("ADMIN_INVALID_QUERY");
      await app.close();
    });

    it("400s a bad limit", async () => {
      const app = await buildAdminServer();
      const res = await app.inject({ method: "GET", url: "/v1/admin/jobs?limit=0", headers: adminHeaders() });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("keeps the tenant filter across pages", async () => {
      for (let i = 1; i <= 4; i++) {
        await seedJob({ id: `j_adm_p${i}`, tenant: TENANT_A, status: "queued", createdAt: at(i) });
      }
      const app = await buildAdminServer();
      const first = await app.inject({
        method: "GET", url: `/v1/admin/jobs?tenant_id=${TENANT_A}&limit=2`, headers: adminHeaders(),
      });
      const second = await app.inject({
        method: "GET",
        url: `/v1/admin/jobs?tenant_id=${TENANT_A}&limit=2&cursor=${encodeURIComponent(first.json().next_cursor)}`,
        headers: adminHeaders(),
      });
      // A cursor must not silently widen the scope of the query it continues.
      for (const j of second.json().items) expect(j.tenant_id).toBe(TENANT_A);
      await app.close();
    });
  });
});
