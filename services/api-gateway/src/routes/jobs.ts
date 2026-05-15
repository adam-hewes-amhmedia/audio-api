import { FastifyInstance } from "fastify";
import {
  getPool, withTx, connectNats, publish, jobId, traceId, attemptId,
  ApiError
} from "@audio-api/node-common";
import { SUBJECTS, Envelope } from "@audio-api/proto";

interface SubmitBody {
  input: { type: "url"; url: string };
  analyses: string[];
  callback_url?: string;
  mode?: "sync" | "async";
}

const VALID_ANALYSES = new Set(["format", "vad"]);

let natsRef: Awaited<ReturnType<typeof connectNats>> | null = null;
async function nats() {
  if (!natsRef) natsRef = await connectNats();
  return natsRef;
}

export async function jobsRoutes(app: FastifyInstance) {
  app.post<{ Body: SubmitBody }>("/v1/jobs", { onRequest: app.requireAuth }, async (req, reply) => {
    const body = req.body;
    if (!body?.input?.url || body.input.type !== "url") {
      throw new ApiError("INPUT_UNREACHABLE", "input.url and input.type='url' required");
    }
    if (!Array.isArray(body.analyses) || body.analyses.length === 0) {
      throw new ApiError("INPUT_UNREACHABLE", "analyses[] required");
    }
    for (const a of body.analyses) {
      if (!VALID_ANALYSES.has(a)) {
        throw new ApiError("INPUT_UNSUPPORTED_CODEC", `analysis '${a}' not supported in this version`);
      }
    }
    const id = jobId();
    const tid = traceId();
    const tenant = req.tenant_id!;
    const inputDescriptor = { type: "url", url: body.input.url };

    await withTx(async client => {
      await client.query(
        `INSERT INTO jobs (id, tenant_id, status, input_descriptor, options, callback_url, mode)
         VALUES ($1,$2,'queued',$3,'{}'::jsonb,$4,$5)`,
        [id, tenant, inputDescriptor, body.callback_url ?? null, body.mode ?? "async"]
      );
      for (const a of body.analyses) {
        await client.query(
          `INSERT INTO analyses (job_id, name, status) VALUES ($1,$2,'pending')`,
          [id, a]
        );
      }
      await client.query(
        `INSERT INTO job_events (job_id, kind, stage, payload) VALUES ($1,'submitted',NULL,$2)`,
        [id, { analyses: body.analyses }]
      );
    });

    const { js } = await nats();
    const env: Envelope<{ url: string }> = {
      job_id: id, tenant_id: tenant, trace_id: tid,
      attempt_id: attemptId(id, "fetch"),
      emitted_at: new Date().toISOString(),
      payload: { url: body.input.url }
    };
    await publish(js, SUBJECTS.WORK_FETCH, env);

    return reply.code(201).send({ job_id: id, status: "queued" });
  });

  app.get<{ Params: { id: string } }>("/v1/jobs/:id", { onRequest: app.requireAuth }, async (req, reply) => {
    const pool = getPool();
    const j = await pool.query(
      `SELECT id, status, created_at, started_at, completed_at FROM jobs WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenant_id]
    );
    if (j.rowCount === 0) return reply.code(404).send({ code: "INPUT_UNREACHABLE", message: "Job not found" });
    const a = await pool.query(
      `SELECT name, status, attempts FROM analyses WHERE job_id = $1`,
      [req.params.id]
    );
    return {
      job_id: j.rows[0].id,
      status: j.rows[0].status,
      created_at: j.rows[0].created_at,
      started_at: j.rows[0].started_at,
      completed_at: j.rows[0].completed_at,
      analyses: a.rows
    };
  });

  app.get<{ Params: { id: string } }>("/v1/jobs/:id/results", { onRequest: app.requireAuth }, async (req, reply) => {
    const pool = getPool();
    const r = await pool.query(
      `SELECT r.report FROM results r JOIN jobs j ON j.id = r.job_id
       WHERE r.job_id = $1 AND j.tenant_id = $2`,
      [req.params.id, req.tenant_id]
    );
    if (r.rowCount === 0) return reply.code(404).send({ code: "INPUT_UNREACHABLE", message: "Results not ready" });
    return r.rows[0].report;
  });

  app.get<{ Params: { id: string } }>("/v1/jobs/:id/events", { onRequest: app.requireAuth }, async (req, reply) => {
    const pool = getPool();
    const own = await pool.query("SELECT 1 FROM jobs WHERE id=$1 AND tenant_id=$2", [req.params.id, req.tenant_id]);
    if (own.rowCount === 0) return reply.code(404).send({ code: "INPUT_UNREACHABLE", message: "Job not found" });
    const e = await pool.query(
      `SELECT ts, kind, stage, payload FROM job_events WHERE job_id = $1 ORDER BY ts ASC`,
      [req.params.id]
    );
    return { events: e.rows };
  });
}
