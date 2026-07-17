import { FastifyInstance } from "fastify";
import { getPool, ApiError } from "@audio-api/node-common";
import { audit } from "./audit.js";

// Operator-adjustable pod tuning. The column name IS the setting key, and each
// setting has a matching POD_* env var that is its deployment default. The table
// overrides that default per stream at spawn time (see the supervisor's
// settings.py); a NULL column means "use the env value", which is what lets an
// empty table behave exactly like the pre-settings deployment.
//
// This route is the one that must never edit a secret or an infra var. Its scope
// is fixed to these four keys by construction: an unknown key is rejected rather
// than ignored, so a typo'd or malicious field cannot ride in.

type SettingKey =
  | "pod_max_duration_s"
  | "pod_idle_timeout_s"
  | "pod_reconnect_window_s"
  | "pod_model_size";

// Numeric knobs and the lower bound each accepts. idle_timeout is > 0 (a pod that
// gives up after 0s of silence never starts); the other two allow 0, where 0
// means "unlimited"/"disabled" and matches the pod's own falsy handling.
const NUMERIC: { key: SettingKey; env: string; min: number }[] = [
  { key: "pod_max_duration_s",     env: "POD_MAX_DURATION_S",     min: 0 },
  { key: "pod_idle_timeout_s",     env: "POD_IDLE_TIMEOUT_S",     min: 1 },
  { key: "pod_reconnect_window_s", env: "POD_RECONNECT_WINDOW_S", min: 0 },
];
const MODEL_ENV = "POD_MODEL_SIZE";
const MODEL_SIZES = ["tiny", "base", "small", "medium", "large-v3"];
const ALL_KEYS: SettingKey[] = [...NUMERIC.map((n) => n.key), "pod_model_size"];

const COLS = "pod_max_duration_s, pod_idle_timeout_s, pod_reconnect_window_s, pod_model_size";

type RawValues = Record<SettingKey, number | string | null>;

// The stored value per setting, NULL when unset. This is what before/after in the
// audit payload records, and what GET turns into value/default/effective/source.
async function rawValues(): Promise<RawValues> {
  const r = await getPool().query(`SELECT ${COLS} FROM settings WHERE id = 1`);
  const row = r.rows[0] ?? {};
  return {
    pod_max_duration_s:     row.pod_max_duration_s ?? null,
    pod_idle_timeout_s:     row.pod_idle_timeout_s ?? null,
    pod_reconnect_window_s: row.pod_reconnect_window_s ?? null,
    pod_model_size:         row.pod_model_size ?? null,
  };
}

function numEnv(v: string | undefined): number | null {
  // Empty or unset reads as "no default known" rather than 0: an empty
  // POD_MAX_DURATION_S already means unlimited to the pod, so reporting 0 here
  // would be a different, wrong claim.
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// The dual-source mitigation: without effective + source, compose saying 30 while
// the database says 300 is a silent debugging trap.
function fact(value: number | string | null, def: number | string | null) {
  return {
    value,
    default: def,
    effective: value != null ? value : def,
    source: value != null ? "database" : "environment",
  };
}

async function readSettings() {
  const raw = await rawValues();
  const out: Record<string, ReturnType<typeof fact>> = {};
  for (const { key, env } of NUMERIC) out[key] = fact(raw[key], numEnv(process.env[env]));
  out.pod_model_size = fact(raw.pod_model_size, process.env[MODEL_ENV] ?? null);
  return out;
}

export async function adminSettingsRoutes(app: FastifyInstance) {
  // GET /v1/admin/settings — value/default/effective/source per setting
  app.get("/v1/admin/settings", async () => readSettings());

  // PUT /v1/admin/settings — partial. Absent key = leave alone; explicit null =
  // unset (revert to env). That distinction is the only reason NULL carries
  // meaning in the table, so it is honoured with `key in body`, not truthiness.
  app.put<{ Body: Record<string, unknown> }>("/v1/admin/settings", async (req) => {
    const body = req.body ?? {};

    for (const k of Object.keys(body)) {
      if (!ALL_KEYS.includes(k as SettingKey)) {
        throw new ApiError("ADMIN_INVALID_QUERY", `Unknown setting '${k}'`);
      }
    }

    const updates: { key: SettingKey; value: number | string | null }[] = [];

    for (const { key, min } of NUMERIC) {
      if (!(key in body)) continue;
      const v = body[key];
      if (v === null) { updates.push({ key, value: null }); continue; }
      if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
        throw new ApiError("ADMIN_INVALID_QUERY", `${key} must be an integer >= ${min} or null`);
      }
      updates.push({ key, value: v });
    }

    if ("pod_model_size" in body) {
      const v = body.pod_model_size;
      if (v === null) {
        updates.push({ key: "pod_model_size", value: null });
      } else if (typeof v !== "string" || !MODEL_SIZES.includes(v)) {
        throw new ApiError("ADMIN_INVALID_QUERY", `pod_model_size must be one of ${MODEL_SIZES.join(", ")} or null`);
      } else {
        updates.push({ key: "pod_model_size", value: v });
      }
    }

    // Empty body: nothing to change, and writing a row of all-NULLs would be a
    // no-op that still churns updated_at. Just report current state.
    if (updates.length === 0) return readSettings();

    const before = await rawValues();

    const cols = updates.map((u) => u.key);
    const vals = updates.map((u) => u.value);
    // $1 = updated_by, $2.. = the values. Upsert against id = 1; the singleton
    // CHECK guarantees there is only ever the one row to conflict on.
    const placeholders = cols.map((_, i) => `$${i + 2}`).join(", ");
    const assignments = cols.map((c) => `${c} = EXCLUDED.${c}`).join(", ");
    await getPool().query(
      `INSERT INTO settings (id, updated_by, updated_at, ${cols.join(", ")})
       VALUES (1, $1, now(), ${placeholders})
       ON CONFLICT (id) DO UPDATE SET updated_by = EXCLUDED.updated_by, updated_at = now(), ${assignments}`,
      [req.admin_token_id ?? "unknown", ...vals]
    );

    const after = await rawValues();
    // Settings are not secrets, so before/after go in the payload: a surprising
    // value is only attributable if the change that made it is recorded.
    await audit(req, "settings.update", "settings", "1", null, { before, after });

    return readSettings();
  });
}
