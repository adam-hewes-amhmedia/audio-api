import { FastifyInstance } from "fastify";
import { getPool } from "@audio-api/node-common";

export async function adminTenantsRoutes(app: FastifyInstance) {
  // GET /v1/admin/tenants — derived, because there is no tenants table
  //
  // A tenant is not a record anywhere in this system; it is a string that
  // appears on a job, a stream or a token. So the only honest way to answer
  // "who are our tenants" is to ask every table that carries the column.
  //
  // This is O(table) and known to be temporary. The three aggregates are
  // index-only scans over columns that are already indexed, which is fine at
  // current volume and will not be fine at millions of rows. The console caches
  // it for 30s. The real fix is a tenants table with maintained counters, and it
  // is deliberately phase two: introducing one now means backfilling and keeping
  // it in step with writes, for a screen nobody has used yet.
  app.get("/v1/admin/tenants", async () => {
    const r = await getPool().query(
      `WITH ids AS (
         SELECT tenant_id FROM jobs
         UNION
         SELECT tenant_id FROM streams
         UNION
         SELECT tenant_id FROM api_tokens
       ),
       j AS (SELECT tenant_id, count(*)::int AS n, max(created_at) AS last FROM jobs    GROUP BY 1),
       s AS (SELECT tenant_id, count(*)::int AS n, max(created_at) AS last FROM streams GROUP BY 1),
       k AS (SELECT tenant_id,
                    (count(*) FILTER (WHERE revoked_at IS NULL))::int AS active,
                    count(*)::int AS total
             FROM api_tokens GROUP BY 1)
       SELECT ids.tenant_id,
              COALESCE(j.n, 0)      AS job_count,
              COALESCE(s.n, 0)      AS stream_count,
              COALESCE(k.active, 0) AS active_token_count,
              COALESCE(k.total, 0)  AS total_token_count,
              GREATEST(j.last, s.last) AS last_activity_at
       FROM ids
       LEFT JOIN j ON j.tenant_id = ids.tenant_id
       LEFT JOIN s ON s.tenant_id = ids.tenant_id
       LEFT JOIN k ON k.tenant_id = ids.tenant_id
       ORDER BY ids.tenant_id ASC`
    );
    // No cursor: the list is the whole set, and the set is small enough that
    // paging it would be misleading about the cost.
    return { items: r.rows, next_cursor: null };
  });
}
