import { createHash } from "node:crypto";
import { FastifyInstance, FastifyRequest } from "fastify";
import { getPool, ApiError } from "@audio-api/node-common";

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    tenant_id?: string;
    token_id?: string;
  }
}

export async function authPlugin(app: FastifyInstance) {
  app.decorate("requireAuth", async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith("Bearer ")) {
      throw new ApiError("INPUT_AUTH_FAILED", "Missing bearer token");
    }
    const token = h.slice(7).trim();
    const hash = createHash("sha256").update(token).digest("hex");
    const r = await getPool().query<{ id: string; tenant_id: string }>(
      "SELECT id, tenant_id FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL",
      [hash]
    );
    if (r.rowCount === 0) throw new ApiError("INPUT_AUTH_FAILED", "Invalid or revoked token");
    req.tenant_id = r.rows[0].tenant_id;
    req.token_id = r.rows[0].id;
  });
}
