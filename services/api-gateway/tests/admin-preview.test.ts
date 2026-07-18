import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { getPool } from "@audio-api/node-common";
import { buildAdminServer, adminHeaders, seedAdminToken, cleanFixtures, TENANT_A } from "./helpers/admin.js";

let app: Awaited<ReturnType<typeof buildAdminServer>>;
let pod: http.Server;
let podPort: number;

beforeAll(async () => {
  await cleanFixtures();
  await seedAdminToken();
  pod = http.createServer((req, res) => {
    if (req.url === "/index.m3u8") { res.setHeader("content-type", "application/vnd.apple.mpegurl"); res.end("#EXTM3U\n#EXT-X-VERSION:3\nseg-0.ts\n"); }
    else if (req.url === "/seg-0.ts") { res.setHeader("content-type", "video/mp2t"); res.end(Buffer.from([0x47, 0x40, 0x00])); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => pod.listen(0, "127.0.0.1", () => r()));
  podPort = (pod.address() as any).port;
  app = await buildAdminServer();
});

afterAll(async () => {
  try { pod.close(); } catch {}
  if (app) await app.close();
  await cleanFixtures();
});

async function seedPodStream(id: string, pid: string, hlsPort: number | null) {
  const p = getPool();
  await p.query(
    "INSERT INTO streams (id, tenant_id, status, target_lang, source_kind, source_url, pod_id) VALUES ($1,$2,'active','en','hls','https://cdn/x.m3u8',$3)",
    [id, TENANT_A, pid]
  );
  await p.query(
    "INSERT INTO stream_pods (pod_id, supervisor_host, ws_host, ws_port, hls_port, stream_id, status) VALUES ($1,'sup','127.0.0.1',9001,$2,$3,'ready')",
    [pid, hlsPort, id]
  );
}

describe("admin preview proxy", () => {
  it("proxies the playlist from the pod", async () => {
    await seedPodStream("s_adm_prev_01", "p_adm_prev_01", podPort);
    const res = await app.inject({ method: "GET", url: "/v1/admin/streams/s_adm_prev_01/preview/index.m3u8", headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/vnd.apple.mpegurl");
    expect(res.body).toContain("#EXTM3U");
  });

  it("proxies a segment from the pod", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/admin/streams/s_adm_prev_01/preview/seg-0.ts", headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("video/mp2t");
  });

  it("rejects a traversal-shaped segment name with 404", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/admin/streams/s_adm_prev_01/preview/..%2f..%2fsecret", headers: adminHeaders() });
    expect(res.statusCode).toBe(404);
  });

  it("404s ADMIN_PREVIEW_NOT_LIVE when the pod has no hls_port", async () => {
    await seedPodStream("s_adm_prev_02", "p_adm_prev_02", null);
    const res = await app.inject({ method: "GET", url: "/v1/admin/streams/s_adm_prev_02/preview/index.m3u8", headers: adminHeaders() });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("ADMIN_PREVIEW_NOT_LIVE");
  });
});
