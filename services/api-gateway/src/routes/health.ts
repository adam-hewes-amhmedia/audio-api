import { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/v1/health", async () => ({
    status: "ok",
    services: { "api-gateway": { status: "ok", version: process.env.SERVICE_VERSION ?? "dev" } }
  }));
}
