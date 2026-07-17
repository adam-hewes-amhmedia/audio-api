import { FastifyInstance } from "fastify";
import { adminStreamsRoutes } from "./streams.js";
import { adminJobsRoutes } from "./jobs.js";
import { adminPodsRoutes } from "./pods.js";
import { adminTenantsRoutes } from "./tenants.js";
import { adminTokensRoutes } from "./tokens.js";

// The admin scope root. Every admin route is a child of this plugin, and the
// hook below is the only thing standing between an unauthenticated caller and
// every tenant's data.
//
// Why a scope-level hook instead of per-route `{ onRequest: app.requireAdmin }`:
// the tenant API opts in per route, and that is survivable there because a
// forgotten hook exposes one tenant's own data to that tenant. Here, a single
// forgotten hook on a single route is a cross-tenant leak of the entire system.
// The hook is registered once, at the root, so there is nothing per-route to
// forget. Adding a route to this scope means it is guarded, by construction.
//
// MUST NOT be wrapped in fastify-plugin. fp exists to break encapsulation, and
// breaking encapsulation here would hoist this onRequest hook to the root
// Fastify instance — where it would run requireAdmin against every request the
// gateway serves and 401 the entire customer-facing API. (auth.ts does use fp,
// correctly: it only decorates, and a decorator does need to escape the scope.)
//
// The onRoute sweep in tests/admin-auth.test.ts enumerates this router for real
// and asserts each route rejects both an anonymous caller and a valid *tenant*
// token, so this guarantee is tested rather than asserted in a comment.
export async function adminRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.requireAdmin);

  await app.register(adminStreamsRoutes);
  await app.register(adminJobsRoutes);
  await app.register(adminPodsRoutes);
  await app.register(adminTenantsRoutes);
  await app.register(adminTokensRoutes);
}
