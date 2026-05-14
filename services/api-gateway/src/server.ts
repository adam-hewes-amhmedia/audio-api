import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { createLogger } from "@audio-api/node-common";
import { healthRoutes } from "./routes/health.js";

export async function buildServer(): Promise<FastifyInstance> {
  const log = createLogger("api-gateway");
  const app = Fastify({ logger: log as any });
  await app.register(cors, { origin: true });
  await app.register(healthRoutes);
  return app;
}
