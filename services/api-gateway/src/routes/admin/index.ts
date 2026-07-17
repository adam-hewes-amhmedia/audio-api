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
// Requests per minute across the whole admin surface. Deliberately generous:
// the console polls (a stream detail screen is ~50/min on its own between the
// stream and its cue feed), and it proxies server-side, so every operator's
// traffic arrives from one IP and shares one bucket. This is a ceiling on
// abuse, not per-operator fairness — the goal is that an unauthenticated flood
// cannot sit in a loop hitting Postgres, not that two admins queue behind each
// other.
const adminRateLimitMax = () => {
  const v = parseInt(process.env.ADMIN_RATE_LIMIT_MAX ?? "600", 10);
  return Number.isFinite(v) && v > 0 ? v : 600;
};

export async function adminRoutes(app: FastifyInstance) {
  // Before requireAdmin, and that order is the point. requireAdmin does a
  // Postgres lookup on every request, so limiting after it would mean an
  // anonymous caller could still make us hit the database as fast as they can
  // send packets. The admin token is 32 random bytes and is not going to be
  // guessed; this bounds the load, not the credential.
  //
  // A scope hook rather than per-route config, for the same reason the auth hook
  // is: there is nothing to forget when a route is added.
  app.addHook("onRequest", app.rateLimit({ max: adminRateLimitMax(), timeWindow: "1 minute" }));
  app.addHook("onRequest", app.requireAdmin);

  await app.register(adminStreamsRoutes);
  await app.register(adminJobsRoutes);
  await app.register(adminPodsRoutes);
  await app.register(adminTenantsRoutes);
  await app.register(adminTokensRoutes);
}
