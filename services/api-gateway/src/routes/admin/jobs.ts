import { FastifyInstance } from "fastify";
import { getPool, ApiError } from "@audio-api/node-common";
import { JOB_COLS, ANALYSIS_COLS, JOB_EVENT_COLS } from "./sql.js";
import { mapJob, mapAnalysis, mapJobEvent, redactDeep } from "./mappers.js";
import { parseLimit, keysetClause, page } from "./pagination.js";

export async function adminJobsRoutes(app: FastifyInstance) {
  // GET /v1/admin/jobs — cross-tenant list
  app.get<{ Querystring: { status?: string; tenant_id?: string; limit?: string; cursor?: string } }>(
    "/v1/admin/jobs",
    async (req) => {
      const q = req.query ?? {};
      const limit = parseLimit(q.limit);
      const where: string[] = [];
      const params: unknown[] = [];

      if (q.status) {
        params.push(q.status);
        where.push(`j.status = $${params.length}`);
      }
      if (q.tenant_id) {
        params.push(q.tenant_id);
        where.push(`j.tenant_id = $${params.length}`);
      }
      const ks = keysetClause(q.cursor, params.length + 1);
      if (ks.sql) {
        where.push(ks.sql.replace(/\(created_at, id\)/, "(j.created_at, j.id)"));
        params.push(...ks.params);
      }
      params.push(limit);

      const r = await getPool().query(
        `SELECT ${JOB_COLS}
         FROM jobs j
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY j.created_at DESC, j.id DESC
         LIMIT $${params.length}`,
        params
      );
      const p = page(r.rows, limit);
      return { items: p.items.map(mapJob), next_cursor: p.next_cursor };
    }
  );

  // GET /v1/admin/jobs/:id — detail with per-analysis state
  app.get<{ Params: { id: string } }>("/v1/admin/jobs/:id", async (req) => {
    const r = await getPool().query(`SELECT ${JOB_COLS} FROM jobs j WHERE j.id = $1`, [req.params.id]);
    if (r.rowCount === 0) throw new ApiError("ADMIN_NOT_FOUND", "Job not found");

    // Separate query rather than a join: a job has a handful of analyses, and
    // joining would multiply the job row per analysis and force a de-dupe.
    const a = await getPool().query(
      `SELECT ${ANALYSIS_COLS} FROM analyses a WHERE a.job_id = $1 ORDER BY a.name ASC`,
      [req.params.id]
    );
    return { ...mapJob(r.rows[0]), analyses: a.rows.map(mapAnalysis) };
  });

  // GET /v1/admin/jobs/:id/results
  app.get<{ Params: { id: string } }>("/v1/admin/jobs/:id/results", async (req) => {
    const r = await getPool().query(
      "SELECT job_id, report, created_at FROM results WHERE job_id = $1",
      [req.params.id]
    );
    if (r.rowCount === 0) throw new ApiError("ADMIN_NOT_FOUND", "No results for this job");
    return {
      job_id: r.rows[0].job_id,
      // Worker-written jsonb whose shape the gateway does not control, so it gets
      // the same recursive URL scrub as job_events.payload rather than being
      // trusted to contain nothing sensitive.
      report: redactDeep(r.rows[0].report),
      created_at: r.rows[0].created_at,
    };
  });

  // GET /v1/admin/jobs/:id/events — the timeline, including webhook attempts
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/v1/admin/jobs/:id/events",
    async (req) => {
      const limit = parseLimit(req.query?.limit);
      const exists = await getPool().query("SELECT 1 FROM jobs WHERE id = $1", [req.params.id]);
      if (exists.rowCount === 0) throw new ApiError("ADMIN_NOT_FOUND", "Job not found");

      // Ascending: a timeline reads forwards, and it is bounded by the events of
      // one job rather than by table size.
      const r = await getPool().query(
        `SELECT ${JOB_EVENT_COLS} FROM job_events e WHERE e.job_id = $1 ORDER BY e.ts ASC, e.id ASC LIMIT $2`,
        [req.params.id, limit]
      );
      return { items: r.rows.map(mapJobEvent), next_cursor: null };
    }
  );
}
