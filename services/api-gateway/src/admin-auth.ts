import { createHash } from "node:crypto";
import { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { getPool, ApiError } from "@audio-api/node-common";

declare module "fastify" {
  interface FastifyInstance {
    requireAdmin: (req: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    admin_token_id?: string;
  }
}

// Mirrors auth.ts deliberately: same sha256-hex digest, same active-only lookup.
// The two must agree on hashing or seed-admin-token.sh silently produces a token
// that can never authenticate.
//
// The one thing this must never do is set req.tenant_id. Admin identity has no
// tenant, and admin_tokens has no tenant_id column to give it one. If this
// function ever assigned a tenant, every tenant-scoped `WHERE tenant_id = $2`
// downstream would happily serve that tenant's data to an admin caller and
// look completely correct while doing it.
//
// fastify-plugin is correct here for the same reason it is correct in auth.ts:
// this only decorates the instance, so it needs to escape encapsulation to be
// visible to the route scopes. The onRequest hook in routes/admin/index.ts is
// the opposite case and must NOT be wrapped.
export const adminAuthPlugin = fp(async function adminAuthPlugin(app: FastifyInstance) {
  app.decorate("requireAdmin", async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith("Bearer ")) {
      throw new ApiError("ADMIN_AUTH_FAILED", "Missing bearer token");
    }
    const token = h.slice(7).trim();
    const hash = createHash("sha256").update(token).digest("hex");
    const r = await getPool().query<{ id: string }>(
      "SELECT id FROM admin_tokens WHERE token_hash = $1 AND revoked_at IS NULL",
      [hash]
    );
    // A valid tenant token lands here as "invalid": it is in api_tokens, not
    // admin_tokens, so it cannot match. That is the whole point of the split,
    // and the onRoute sweep test asserts it on every admin route.
    if (r.rowCount === 0) throw new ApiError("ADMIN_AUTH_FAILED", "Invalid or revoked admin token");
    req.admin_token_id = r.rows[0].id;
  });
});
