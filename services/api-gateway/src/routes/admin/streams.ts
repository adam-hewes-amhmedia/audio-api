import { FastifyInstance } from "fastify";
import {
  getPool, connectNats, publish, traceId, attemptId, ApiError
} from "@audio-api/node-common";
import { SUBJECTS, StreamDeleteRequested, Envelope } from "@audio-api/proto";
import { STREAM_COLS, CUE_COLS, podCols, podStaleAfterS } from "./sql.js";
import { mapStream, mapCue, mapPod } from "./mappers.js";
import { parseLimit, keysetClause, page } from "./pagination.js";
import { audit } from "./audit.js";

// Exactly the set stream-machine.ts allows to leave for 'ending'. Admin does not
// get a bigger hammer than the tenant API here: bypassing the state machine
// would let an operator move an already-archived stream back to 'ending' and
// strand the reaper. Admin's privilege is seeing every tenant, not breaking
// invariants.
const KILLABLE = ["provisioning", "awaiting_ingest", "active"];

let natsRef: Awaited<ReturnType<typeof connectNats>> | null = null;
async function nats() {
  if (!natsRef) natsRef = await connectNats();
  return natsRef;
}

export async function adminStreamsRoutes(app: FastifyInstance) {
  // GET /v1/admin/streams — cross-tenant list
  app.get<{ Querystring: { status?: string; tenant_id?: string; limit?: string; cursor?: string } }>(
    "/v1/admin/streams",
    async (req) => {
      const q = req.query ?? {};
      const limit = parseLimit(q.limit);
      const where: string[] = [];
      const params: unknown[] = [];

      if (q.status) {
        params.push(q.status);
        where.push(`s.status = $${params.length}`);
      }
      if (q.tenant_id) {
        params.push(q.tenant_id);
        where.push(`s.tenant_id = $${params.length}`);
      }
      const ks = keysetClause(q.cursor, params.length + 1);
      if (ks.sql) {
        where.push(ks.sql.replace(/\(created_at, id\)/, "(s.created_at, s.id)"));
        params.push(...ks.params);
      }
      params.push(limit);

      const r = await getPool().query(
        `SELECT ${STREAM_COLS}
         FROM streams s
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT $${params.length}`,
        params
      );
      const p = page(r.rows, limit);
      return { items: p.items.map(mapStream), next_cursor: p.next_cursor };
    }
  );

  // GET /v1/admin/streams/:id — detail, with the pod it landed on
  app.get<{ Params: { id: string } }>("/v1/admin/streams/:id", async (req) => {
    // The pod join includes stale pods deliberately. "Which stream is stuck" is
    // usually answered by a pod that stopped heartbeating, so hiding the stale
    // row would hide the answer.
    const r = await getPool().query(
      `SELECT ${STREAM_COLS}, ${podCols(2)}
       FROM streams s
       LEFT JOIN stream_pods p ON p.pod_id = s.pod_id
       WHERE s.id = $1`,
      [req.params.id, podStaleAfterS()]
    );
    if (r.rowCount === 0) throw new ApiError("ADMIN_NOT_FOUND", "Stream not found");
    const row = r.rows[0];
    return { ...mapStream(row), pod: row.pod_id ? mapPod(row) : null };
  });

  // GET /v1/admin/streams/:id/cues — the caption feed for the detail screen
  app.get<{ Params: { id: string }; Querystring: { since?: string; limit?: string } }>(
    "/v1/admin/streams/:id/cues",
    async (req) => {
      const limit = parseLimit(req.query?.limit);
      // Polled, so paging is by cue_id watermark rather than a cursor: the
      // console asks "what is new since the last one I saw". Ascending, unlike
      // every other list here, because a caption feed reads forwards.
      const since = req.query?.since ? Number(req.query.since) : -1;
      if (!Number.isInteger(since)) {
        throw new ApiError("ADMIN_INVALID_QUERY", "since must be an integer cue_id");
      }

      const exists = await getPool().query("SELECT tenant_id FROM streams WHERE id = $1", [req.params.id]);
      if (exists.rowCount === 0) throw new ApiError("ADMIN_NOT_FOUND", "Stream not found");

      const r = await getPool().query(
        `SELECT ${CUE_COLS}
         FROM stream_cues c
         WHERE c.stream_id = $1 AND c.cue_id > $2
         ORDER BY c.cue_id ASC
         LIMIT $3`,
        [req.params.id, since, limit]
      );

      // Cue text is customer content. Reading it is the point of the console, and
      // it is also the most sensitive thing the console shows, so every read is
      // attributable to an admin token. Only audit the first page of a poll loop
      // (since < 0), or a 1s poll would write a row per second per viewer.
      if (since < 0) {
        await audit(req, "stream.cues.view", "stream", req.params.id, exists.rows[0].tenant_id);
      }

      return { items: r.rows.map(mapCue), next_cursor: null };
    }
  );

  // POST /v1/admin/streams/:id/kill — operator kill switch
  //
  // POST, not DELETE: this is a transition to 'ending', not a record removal,
  // and the verb carries a reason the audit log needs. DELETE would also imply
  // the row goes away, which it does not.
  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/v1/admin/streams/:id/kill",
    async (req, reply) => {
      const reason = req.body?.reason;

      const cur = await getPool().query<{ status: string; tenant_id: string }>(
        "SELECT status, tenant_id FROM streams WHERE id = $1",
        [req.params.id]
      );
      // Unlike the tenant DELETE route, which collapses both cases to 404 to
      // avoid confirming another tenant's stream exists, admin separates them.
      // An operator needs to know the difference between "wrong id" and "already
      // finished" — that distinction is most of the triage.
      if (cur.rowCount === 0) throw new ApiError("ADMIN_NOT_FOUND", "Stream not found");
      if (!KILLABLE.includes(cur.rows[0].status)) {
        throw new ApiError("ADMIN_INVALID_STATE", `Stream is ${cur.rows[0].status} and cannot be killed`);
      }

      const r = await getPool().query(
        `UPDATE streams SET status = 'ending'
         WHERE id = $1 AND status = ANY($2)
         RETURNING id`,
        [req.params.id, KILLABLE]
      );
      // Lost a race with the reaper or the tenant's own DELETE between the read
      // and the write. Not an error worth inventing a code for: the stream is
      // ending either way, which is what the caller asked for.
      if (r.rowCount === 0) throw new ApiError("ADMIN_INVALID_STATE", "Stream changed state during kill");

      await audit(req, "stream.kill", "stream", req.params.id, cur.rows[0].tenant_id, { reason: reason ?? null });

      // Best-effort, mirroring the tenant route: the row already says 'ending',
      // so the reaper will collect the pod even if NATS is down. Returning 500
      // here would tell the operator the kill failed when it did not.
      try {
        const { js } = await nats();
        const env: Envelope<StreamDeleteRequested> = {
          job_id:     req.params.id,
          tenant_id:  cur.rows[0].tenant_id,
          trace_id:   traceId(),
          attempt_id: attemptId(req.params.id, "delete"),
          emitted_at: new Date().toISOString(),
          payload:    { stream_id: req.params.id },
        };
        await publish(js, SUBJECTS.STREAM_DELETE_REQUESTED, env);
      } catch (err) {
        req.log.warn({ err }, "admin kill: failed to publish STREAM_DELETE_REQUESTED — pod will not be SIGTERMed immediately");
      }

      return reply.code(202).send({ stream_id: req.params.id, status: "ending" });
    }
  );
}
