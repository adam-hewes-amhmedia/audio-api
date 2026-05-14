import { FastifyInstance } from "fastify";
import {
  withTx, connectNats, publish, jobId, traceId, attemptId,
  ApiError
} from "@audio-api/node-common";
import { SUBJECTS, Envelope } from "@audio-api/proto";

interface SubmitBody {
  input: { type: "url"; url: string };
  analyses: string[];
  callback_url?: string;
  mode?: "sync" | "async";
}

const VALID_ANALYSES = new Set(["format"]); // Plan 1: format only

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
}
