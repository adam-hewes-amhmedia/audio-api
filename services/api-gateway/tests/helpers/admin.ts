import { createHash, randomBytes } from "node:crypto";
import { getPool } from "@audio-api/node-common";
import { buildServer } from "../../src/server.js";

// Shared fixtures for the admin tests.
//
// The trap these exist to avoid: every other test file in this suite seeds
// t_test/tenant_test and cleans up only its own ids, and vitest runs the files
// serially against one shared database (fileParallelism: false). The tenant API
// never noticed, because every query is scoped `WHERE tenant_id = $2` and each
// file only ever asks about its own tenant.
//
// Admin lists are cross-tenant by definition. An unfiltered
// GET /v1/admin/streams sees every row every other file left behind, plus 238
// rows of real smoke-test data. So:
//
//   * assert on *content* only through ?tenant_id=, scoped to these fixtures;
//   * assert on unfiltered lists only for shape, ordering and cursor mechanics,
//     never for exact membership.
//
// Two tenants, not one: a single tenant cannot catch a missing tenant filter.

export const ADMIN_TOKEN = "ad_fixture-admin-token-dddddddddddddddd";
export const ADMIN_HASH = createHash("sha256").update(ADMIN_TOKEN).digest("hex");
export const ADMIN_ID = "adm_fixture";

export const TENANT_A = "tenant_adm_a";
export const TENANT_B = "tenant_adm_b";

// Seeded into rows that must never appear in a response. The redaction test
// scans for these literals rather than for a field name: scanning for the
// seeded *value* is what catches a field that got renamed on the way out.
export const SECRET_SIG = "X-Amz-Signature=deadbeefcafefixture";
export const SECRET_SOURCE_URL = `https://bucket.example.com/media/a.mp4?${SECRET_SIG}`;
export const SECRET_CALLBACK_URL = "https://hooks.example.com/cb/s3cr3t-path-fixture?token=t0ps3cr3t-fixture";
export const SECRET_WEBHOOK = "whsec_fixture_must_never_appear";

export function adminHeaders() {
  return { authorization: `Bearer ${ADMIN_TOKEN}` };
}

export async function buildAdminServer() {
  process.env.ADMIN_API_ENABLED = "1";
  return buildServer();
}

export async function cleanFixtures() {
  const pool = getPool();
  // Order matters: job_events/analyses/results and stream_cues cascade from
  // their parents, but the parents must go before the tenants they name.
  await pool.query("DELETE FROM jobs    WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
  await pool.query("DELETE FROM stream_pods WHERE pod_id LIKE 'p_adm_%'");
  await pool.query("DELETE FROM streams WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
  await pool.query("DELETE FROM api_tokens WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
  await pool.query("DELETE FROM tenant_secrets WHERE tenant_id = ANY($1)", [[TENANT_A, TENANT_B]]);
  await pool.query("DELETE FROM admin_audit WHERE tenant_id = ANY($1) OR admin_token_id = $2", [[TENANT_A, TENANT_B], ADMIN_ID]);
  await pool.query("DELETE FROM admin_tokens WHERE id = $1", [ADMIN_ID]);
}

export async function seedAdminToken() {
  const pool = getPool();
  await pool.query("DELETE FROM admin_tokens WHERE id = $1", [ADMIN_ID]);
  await pool.query("INSERT INTO admin_tokens (id, token_hash, name) VALUES ($1, $2, $3)", [
    ADMIN_ID, ADMIN_HASH, "fixture",
  ]);
}

// created_at is set explicitly and spaced a second apart so ordering and cursor
// assertions are deterministic. Rows inserted in the same statement would share
// now() and make "newest first" ambiguous.
export async function seedStream(opts: {
  id: string;
  tenant: string;
  status: string;
  createdAt: string;
  podId?: string | null;
  sourceUrl?: string;
  callbackUrl?: string | null;
  cueCount?: number;
}) {
  await getPool().query(
    `INSERT INTO streams
       (id, tenant_id, status, source_kind, source_url, source_headers, source_passphrase,
        source_hint, target_lang, options, callback_url, pod_id, cue_count, created_at)
     VALUES ($1, $2, $3, 'mp4', $4, $5, $6, 'fixture', 'en', '{}', $7, $8, $9, $10)`,
    [
      opts.id,
      opts.tenant,
      opts.status,
      opts.sourceUrl ?? SECRET_SOURCE_URL,
      // Real sealed-looking bytea in the columns that must never be selected.
      // If a SELECT * ever creeps in, these show up as a Buffer in the JSON.
      Buffer.from(`sealed-headers-${randomBytes(8).toString("hex")}`),
      Buffer.from(`sealed-passphrase-${randomBytes(8).toString("hex")}`),
      opts.callbackUrl === undefined ? SECRET_CALLBACK_URL : opts.callbackUrl,
      opts.podId ?? null,
      opts.cueCount ?? 0,
      opts.createdAt,
    ]
  );
}

export async function seedJob(opts: {
  id: string;
  tenant: string;
  status: string;
  createdAt: string;
  url?: string;
  callbackUrl?: string | null;
}) {
  await getPool().query(
    `INSERT INTO jobs
       (id, tenant_id, status, input_descriptor, options, callback_url, mode, created_at)
     VALUES ($1, $2, $3, $4, '{}', $5, 'async', $6)`,
    [
      opts.id,
      opts.tenant,
      opts.status,
      JSON.stringify({ kind: "url", url: opts.url ?? SECRET_SOURCE_URL }),
      opts.callbackUrl === undefined ? SECRET_CALLBACK_URL : opts.callbackUrl,
      opts.createdAt,
    ]
  );
}

export async function seedPod(opts: {
  podId: string;
  streamId?: string | null;
  status: string;
  heartbeatAgeS: number;
}) {
  await getPool().query(
    `INSERT INTO stream_pods (pod_id, supervisor_host, ws_host, ws_port, stream_id, status, last_heartbeat)
     VALUES ($1, 'sup-fixture', 'ws-fixture', 9000, $2, $3, now() - make_interval(secs => $4::int))`,
    [opts.podId, opts.streamId ?? null, opts.status, opts.heartbeatAgeS]
  );
}

export async function seedCues(streamId: string, n: number) {
  for (let i = 1; i <= n; i++) {
    await getPool().query(
      `INSERT INTO stream_cues (stream_id, cue_id, start_ms, end_ms, text, source_text, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, 0.9)`,
      [streamId, i, i * 1000, i * 1000 + 900, `cue text ${i}`, `source ${i}`]
    );
  }
}
