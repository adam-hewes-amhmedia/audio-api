import { FastifyInstance } from "fastify";
import { getPool, ApiError } from "@audio-api/node-common";
import { podCols, podStaleAfterS } from "./sql.js";
import { mapPod } from "./mappers.js";
import { parseLimit } from "./pagination.js";

export async function adminPodsRoutes(app: FastifyInstance) {
  // GET /v1/admin/pods — the fleet
  //
  // No cursor here, unlike jobs and streams. The pod table is bounded by how
  // many GPUs exist, not by how many requests customers have made, so it is
  // small and stays small. A cursor would be ceremony over a table that fits on
  // one screen. limit is still honoured as a backstop.
  app.get<{ Querystring: { status?: string; stale?: string; limit?: string } }>(
    "/v1/admin/pods",
    async (req) => {
      const q = req.query ?? {};
      const limit = parseLimit(q.limit);
      const staleAfter = podStaleAfterS();

      // $1 is the staleness threshold, referenced by podCols and reused by the
      // stale filter below, so the column and the filter can never disagree.
      const params: unknown[] = [staleAfter];
      const where: string[] = [];

      if (q.status) {
        params.push(q.status);
        where.push(`p.status = $${params.length}`);
      }
      if (q.stale !== undefined) {
        if (q.stale !== "true" && q.stale !== "false") {
          throw new ApiError("ADMIN_INVALID_QUERY", "stale must be 'true' or 'false'");
        }
        const op = q.stale === "true" ? ">" : "<=";
        where.push(`(now() - p.last_heartbeat) ${op} make_interval(secs => $1::int)`);
      }
      params.push(limit);

      // tenant_id is not on stream_pods; it comes via the stream the pod is
      // currently serving. LEFT JOIN because an idle or just-reaped pod has no
      // stream, and those are exactly the rows an operator is looking for.
      const r = await getPool().query(
        `SELECT ${podCols(1)}, s.tenant_id
         FROM stream_pods p
         LEFT JOIN streams s ON s.id = p.stream_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY p.last_heartbeat ASC
         LIMIT $${params.length}`,
        params
      );
      // Oldest heartbeat first: the pods most likely to be dead sort to the top,
      // which is the order an operator wants to read them in.
      return { items: r.rows.map(mapPod), next_cursor: null };
    }
  );
}
