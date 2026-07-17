import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
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
  await app.register(authPlugin);
  await app.register(adminAuthPlugin);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      const { status, body } = err.toHttp();
      return reply.code(status).send(body);
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
