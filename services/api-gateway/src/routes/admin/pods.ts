import { FastifyInstance } from "fastify";
import { getPool, ApiError } from "@audio-api/node-common";
import { podCols, podStaleAfterS } from "./sql.js";
import { mapPod } from "./mappers.js";
import { parseLimit } from "./pagination.js";

// Pods that are finished: they will never heartbeat again and hold nothing.
// 'dead' is the reaper's verdict on a pod that stopped saying anything;
// 'terminated' is a pod that stopped on purpose and filed it. Everything else
// ('starting', 'ready') is a pod that is, or should be, alive.
const SETTLED_POD_STATUSES = ["dead", "terminated"];

export async function adminPodsRoutes(app: FastifyInstance) {
  // GET /v1/admin/pods — the fleet
  //
  // No cursor here, unlike jobs and streams. The live fleet is bounded by how
  // many GPUs exist, not by how many requests customers have made. limit is
  // still honoured as a backstop.
  //
  // Settled rows are a different story: nothing deletes them, so they grow
  // without bound, and this list is ordered oldest-heartbeat-first — which sorts
  // the corpses to the top. Filtering them out in the browser would therefore be
  // wrong in the one case it matters: with a few thousand settled rows, `limit`
  // would be filled entirely by dead pods and a live one would never reach the
  // client at all. It has to happen in SQL.
  app.get<{ Querystring: { status?: string; stale?: string; settled?: string; limit?: string } }>(
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
      // Absent means "everything", matching `stale`. The console asks for
      // settled=false by default rather than this defaulting to it: a filter
      // that hides rows unless you opt out is how an operator ends up certain a
      // pod does not exist.
      if (q.settled !== undefined) {
        if (q.settled !== "true" && q.settled !== "false") {
          throw new ApiError("ADMIN_INVALID_QUERY", "settled must be 'true' or 'false'");
        }
        params.push(SETTLED_POD_STATUSES);
        // NOT (x = ANY(...)) for the negative case, never `x <> ANY(...)`:
        // <> ANY means "differs from at least one element", which is true for
        // every row the moment the array holds two distinct values. It would
        // read as a filter and match everything.
        where.push(
          q.settled === "true"
            ? `p.status = ANY($${params.length})`
            : `NOT (p.status = ANY($${params.length}))`
        );
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
