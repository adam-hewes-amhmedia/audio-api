import { FastifyRequest } from "fastify";
import { getPool } from "@audio-api/node-common";

// Append-only record of what an admin did, attributable to a specific token.
//
// This is why admin_tokens exists as a table rather than an ADMIN_TOKEN env var:
// a shared env secret makes every row here say "somebody". job_events cannot
// stand in for this — it is per-job and cascades on delete, so it covers neither
// killing a stream nor issuing a token (which, with no tenants table, is
// effectively creating a tenant).
//
// payload must never carry a plaintext token or a token hash. The hash is a
// verifier: anything that can read the audit log could otherwise replay it
// against admin_tokens to confirm a guess.
export async function audit(
  req: FastifyRequest,
  action: string,
  targetType: string | null,
  targetId: string | null,
  tenantId: string | null,
  payload?: Record<string, unknown>
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO admin_audit (admin_token_id, action, target_type, target_id, tenant_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        req.admin_token_id ?? "unknown",
        action,
        targetType,
        targetId,
        tenantId,
        payload ? JSON.stringify(payload) : null,
      ]
    );
  } catch (err) {
    // A failed audit write must not fail the action the operator asked for —
    // losing the kill switch because the audit table is full would be worse than
    // losing the audit row. Logged loudly so the gap is visible.
    //
    // Token issuance is the exception and does NOT use this path: there, the
    // audit row is written inside the same transaction as the token, so a token
    // cannot exist without a record of who created it.
    req.log.error({ err, action, targetId }, "admin audit write failed");
  }
}
