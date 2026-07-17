import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { createLogger, ApiError } from "@audio-api/node-common";
import { healthRoutes } from "./routes/health.js";
import { jobsRoutes } from "./routes/jobs.js";
import { streamsRoutes } from "./routes/streams.js";
import { streamsWsRoutes } from "./routes/streams-ws.js";
import { streamsVttRoutes } from "./routes/streams-vtt.js";
import { authPlugin } from "./auth.js";
import { adminAuthPlugin } from "./admin-auth.js";
import { adminRoutes } from "./routes/admin/index.js";

// The admin API is off unless explicitly switched on. Layer 3 of the admin auth
// guarantee, and the only one that holds even if the other two are wrong: a
// route that was never registered cannot leak anything. Production turns this on
// deliberately; every other environment gets no admin surface at all.
export const adminApiEnabled = () => process.env.ADMIN_API_ENABLED === "1";

export interface BuildServerOpts {
  // Test seam. Fastify's onRoute hook only fires for routes registered after it
  // is added, so there is no way to enumerate the real router from outside
  // buildServer. tests/admin-auth.test.ts uses this to sweep every admin route
  // that actually exists and assert each one rejects anonymous and tenant
  // callers. Nothing in production passes it.
  onRoute?: (route: { method: string | string[]; url: string }) => void;
}

export async function buildServer(opts: BuildServerOpts = {}): Promise<FastifyInstance> {
  const log = createLogger("api-gateway");
  const app = Fastify({ loggerInstance: log as any });
  if (opts.onRoute) app.addHook("onRoute", opts.onRoute);
  await app.register(cors, { origin: true });
  // global: false is load-bearing, not a preference.
  //
  // @fastify/rate-limit is wrapped in fastify-plugin, so registering it inside
  // the admin scope would NOT keep it there: fp hoists it to the root instance
  // and it would throttle the entire customer API. Exactly the trap that makes
  // routes/admin/index.ts refuse to be fp-wrapped.
  //
  // So it is registered here, globally, but adds no global hook. All it does is
  // decorate the instance with app.rateLimit(), which the admin scope then
  // attaches as its own onRequest hook. The tenant API is untouched, and
  // tests/admin-rate-limit.test.ts asserts that.
  await app.register(rateLimit, { global: false });
  await app.register(authPlugin);
  await app.register(adminAuthPlugin);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      const { status, body } = err.toHttp();
      return reply.code(status).send(body);
    }
    // @fastify/rate-limit throws a 429 rather than replying directly, so without
    // this it falls into the catch-all below and is reported as INTERNAL: we
    // would be telling the caller we broke when we in fact throttled them, and
    // a 500 invites the retry that a 429 is trying to prevent. RATE_LIMITED
    // already exists in the error catalogue.
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 429) {
      return reply.code(429).send({ code: "RATE_LIMITED", message: e.message ?? "Too many requests" });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ code: "INTERNAL", message: "Internal error" });
  });

  await app.register(healthRoutes);
  await app.register(jobsRoutes);
  await app.register(streamsRoutes);
  await app.register(streamsWsRoutes);
  await app.register(streamsVttRoutes);
  if (adminApiEnabled()) await app.register(adminRoutes);

  return app;
}
