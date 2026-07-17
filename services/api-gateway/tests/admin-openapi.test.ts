import { describe, it, expect } from "vitest";
import { loadAdminOpenApi } from "@audio-api/contracts";
import { buildServer } from "../src/server.js";

// Closes the loop between openapi-admin.yaml and the router.
//
// The reason this file exists at all: openapi.yaml already documents 6 of the
// gateway's 12 live tenant routes, because nothing checks it. A spec that is
// half true is worse than no spec — it is a document people trust and act on
// while it quietly rots. So the admin spec only earns its place if drift in
// either direction fails a test:
//
//   * a route in the code but not the spec  -> undocumented surface;
//   * a route in the spec but not the code  -> a lie the console may be built on.
//
// Same onRoute sweep as admin-auth.test.ts, so this stays true for routes nobody
// has written yet.

// Fastify says /v1/admin/streams/:id; OpenAPI says /v1/admin/streams/{id}.
const toOpenApiPath = (url: string) => url.replace(/:([^/]+)/g, "{$1}");

async function realRoutes(): Promise<Set<string>> {
  process.env.ADMIN_API_ENABLED = "1";
  const found = new Set<string>();
  const app = await buildServer({
    onRoute: (r) => {
      if (!r.url.startsWith("/v1/admin")) return;
      const methods = Array.isArray(r.method) ? r.method : [r.method];
      for (const m of methods) {
        // HEAD is derived by Fastify from each GET and is not a documented
        // operation; OPTIONS comes from CORS.
        if (m === "HEAD" || m === "OPTIONS") continue;
        found.add(`${m.toLowerCase()} ${toOpenApiPath(r.url)}`);
      }
    },
  });
  await app.ready();
  await app.close();
  return found;
}

function specOperations(): Set<string> {
  const spec = loadAdminOpenApi();
  const ops = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(item)) {
      if (["get", "post", "put", "patch", "delete"].includes(method)) {
        ops.add(`${method} ${path}`);
      }
    }
  }
  return ops;
}

describe("admin openapi", () => {
  it("documents every admin route that exists", async () => {
    const real = await realRoutes();
    const spec = specOperations();
    const undocumented = [...real].filter((r) => !spec.has(r)).sort();
    expect(undocumented, "routes in the code but missing from openapi-admin.yaml").toEqual([]);
  });

  it("documents no admin route that does not exist", async () => {
    const real = await realRoutes();
    const spec = specOperations();
    const phantom = [...spec].filter((r) => !real.has(r)).sort();
    expect(phantom, "routes in openapi-admin.yaml that the code does not serve").toEqual([]);
  });

  it("keeps the admin spec separate from the customer spec", async () => {
    const spec = loadAdminOpenApi();
    // Publishing admin routes in the customer spec would leak internal topology:
    // the pod fleet and the full tenant list are in here.
    for (const path of Object.keys(spec.paths ?? {})) {
      expect(path.startsWith("/v1/admin"), `${path} does not belong in the admin spec`).toBe(true);
    }
  });

  it("declares the admin bearer scheme rather than the tenant one", async () => {
    const spec = loadAdminOpenApi() as any;
    expect(spec.components?.securitySchemes?.adminBearerAuth).toBeTruthy();
    // A tenant token must never be presented as valid here; the sweep in
    // admin-auth.test.ts proves the code agrees.
    expect(spec.components?.securitySchemes?.bearerAuth).toBeUndefined();
  });
});
