import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { createLogger, ApiError } from "@audio-api/node-common";
import { healthRoutes } from "./routes/health.js";
import { jobsRoutes } from "./routes/jobs.js";
import { authPlugin } from "./auth.js";

export async function buildServer(): Promise<FastifyInstance> {
  const log = createLogger("api-gateway");
  const app = Fastify({ loggerInstance: log as any });
  await app.register(cors, { origin: true });
  await app.register(authPlugin);
  await app.register(healthRoutes);
  await app.register(jobsRoutes);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      const { status, body } = err.toHttp();
      return reply.code(status).send(body);
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ code: "INTERNAL", message: "Internal error" });
  });

  return app;
}
