import { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { getPool, tokenId, ApiError } from "@audio-api/node-common";
import { mapToken } from "./mappers.js";

// Mirrors what the rest of the system already assumes a tenant id looks like.
// Enforced here because this endpoint is the only thing that ever creates one.
const TENANT_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;

export async function adminTokensRoutes(app: FastifyInstance) {
  // GET /v1/admin/tokens?tenant_id=
  app.get<{ Querystring: { tenant_id?: string } }>("/v1/admin/tokens", async (req) => {
    const tenant = req.query?.tenant_id;
    const r = await getPool().query(
      `SELECT id, tenant_id, name, created_at, revoked_at
       FROM api_tokens
       ${tenant ? "WHERE tenant_id = $1" : ""}
       ORDER BY created_at DESC, id DESC`,
      tenant ? [tenant] : []
    );
    return { items: r.rows.map(mapToken), next_cursor: null };
  });

  // POST /v1/admin/tokens — issue a tenant token
  //
  // Read this as "create a tenant". There is no tenants table, so a tenant
  // begins existing the moment a row carries its id, and this is the only place
  // that happens deliberately. That is why the existence check below is not
  // optional politeness: a typo'd tenant_id silently forks a permanent phantom
  // tenant that owns real data and that nobody will ever find, because nothing
  // lists tenants except by scanning for ids exactly like the typo.
  app.post<{ Body: { tenant_id?: string; name?: string; allow_new_tenant?: boolean } }>(
    "/v1/admin/tokens",
    async (req, reply) => {
      const body = req.body ?? {};
      const tenant = body.tenant_id;
      const name = body.name;

      if (!tenant || !TENANT_ID_RE.test(tenant)) {
        throw new ApiError("ADMIN_INVALID_QUERY", "tenant_id must match ^[a-z0-9][a-z0-9_-]{2,63}$");
      }
      if (!name) {
        throw new ApiError("ADMIN_INVALID_QUERY", "name is required");
      }

      const seen = await getPool().query(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM jobs       WHERE tenant_id = $1)
                     OR EXISTS (SELECT 1 FROM streams    WHERE tenant_id = $1)
                     OR EXISTS (SELECT 1 FROM api_tokens WHERE tenant_id = $1)`,
        [tenant]
      );
      const isNew = seen.rowCount === 0;
      if (isNew && body.allow_new_tenant !== true) {
        throw new ApiError(
          "ADMIN_INVALID_QUERY",
          `Tenant '${tenant}' has no existing data. If you mean to create it, pass allow_new_tenant: true.`
        );
      }

      // Not tokenId(): that is a ULID, which is time-ordered and therefore
      // partially predictable from when it was issued. Fine for a row id that is
      // never a secret, wrong for the secret itself. 32 random bytes is the
      // secret; the 'at_' prefix rides in the plaintext so auth.ts needs no
      // change and so secret scanners have something to match on.
      const secret = "at_" + randomBytes(32).toString("base64url");
      // Same construction as auth.ts:23. Not "the same algorithm" by agreement —
      // the round-trip test issues a token here and then authenticates a real
      // tenant route with it, so a divergence fails a test rather than shipping.
      const hash = createHash("sha256").update(secret).digest("hex");
      const id = tokenId();

      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO api_tokens (id, tenant_id, token_hash, name) VALUES ($1, $2, $3, $4)",
          [id, tenant, hash, name]
        );

        // A brand new tenant with no webhook secret is the quiet failure this
        // guards: worker-webhook/src/index.ts:39 no-ops when the row is missing,
        // so the tenant's webhooks would never fire and never error. Same
        // transaction as the token, because a tenant that exists without one is
        // exactly the broken state we are avoiding.
        if (isNew) {
          await client.query(
            `INSERT INTO tenant_secrets (tenant_id, webhook_secret) VALUES ($1, $2)
             ON CONFLICT (tenant_id) DO NOTHING`,
            [tenant, randomBytes(32).toString("base64url")]
          );
        }

        // In-transaction, unlike audit.ts's best-effort write: a token must not
        // be able to exist without a record of who issued it. Never log the
        // plaintext or the hash here — the hash is a verifier, and anything that
        // can read the audit log could replay it against api_tokens.
        await client.query(
          `INSERT INTO admin_audit (admin_token_id, action, target_type, target_id, tenant_id, payload)
           VALUES ($1, 'token.issue', 'api_token', $2, $3, $4)`,
          [req.admin_token_id ?? "unknown", id, tenant, JSON.stringify({ name, new_tenant: isNew })]
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      // Show-once. Only the hash is stored, so this is the only moment the
      // plaintext exists anywhere; losing it means revoke and reissue. The
      // webhook_secret is deliberately not returned — rotation gets its own
      // endpoint in phase two.
      return reply.code(201).send({ ...mapToken({ id, tenant_id: tenant, name, created_at: new Date(), revoked_at: null }), token: secret });
    }
  );

  // POST /v1/admin/tokens/:id/revoke — idempotent
  app.post<{ Params: { id: string } }>("/v1/admin/tokens/:id/revoke", async (req) => {
    const cur = await getPool().query<{ tenant_id: string }>(
      "SELECT tenant_id FROM api_tokens WHERE id = $1",
      [req.params.id]
    );
    if (cur.rowCount === 0) throw new ApiError("ADMIN_NOT_FOUND", "Token not found");

    // Idempotent by COALESCE rather than by checking first: revoking an already
    // revoked token is not an error, and re-stamping revoked_at would rewrite
    // history about when access actually ended.
    const r = await getPool().query(
      `UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, now())
       WHERE id = $1
       RETURNING id, tenant_id, name, created_at, revoked_at`,
      [req.params.id]
    );

    await getPool().query(
      `INSERT INTO admin_audit (admin_token_id, action, target_type, target_id, tenant_id, payload)
       VALUES ($1, 'token.revoke', 'api_token', $2, $3, NULL)`,
      [req.admin_token_id ?? "unknown", req.params.id, cur.rows[0].tenant_id]
    );

    return mapToken(r.rows[0]);
  });
}
