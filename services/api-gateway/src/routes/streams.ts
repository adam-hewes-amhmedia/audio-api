import { FastifyInstance } from "fastify";
import {
  getPool, connectNats, publish, streamId, traceId, attemptId,
  ApiError
} from "@audio-api/node-common";
import { SUBJECTS, StreamProvisionRequested, StreamDeleteRequested, Envelope } from "@audio-api/proto";

interface StreamCreateBody {
  source_hint?: string;
  output?: { target_lang?: string };
  options?: Record<string, unknown>;
  callback_url?: string;
}

const publicBase = () => process.env.PUBLIC_BASE_URL ?? "http://localhost:8080";
const wsBase    = () => process.env.PUBLIC_WS_URL   ?? "ws://localhost:8080";

let natsRef: Awaited<ReturnType<typeof connectNats>> | null = null;
async function nats() {
  if (!natsRef) natsRef = await connectNats();
  return natsRef;
}

export async function streamsRoutes(app: FastifyInstance) {
  // POST /v1/streams — create a live subtitle stream
  app.post<{ Body: StreamCreateBody }>("/v1/streams", { onRequest: app.requireAuth }, async (req, reply) => {
    const body = req.body ?? {};
    const targetLang = body.output?.target_lang;

    if (targetLang !== undefined && targetLang !== "en") {
      throw new ApiError("INPUT_UNREACHABLE", "output.target_lang must be 'en' in v1");
    }

    const id    = streamId();
    const tid   = traceId();
    const tenant = req.tenant_id!;

    await getPool().query(
      `INSERT INTO streams (id, tenant_id, status, target_lang, source_hint, options, callback_url)
       VALUES ($1, $2, 'provisioning', 'en', $3, $4, $5)`,
      [
        id,
        tenant,
        body.source_hint ?? null,
        body.options ? JSON.stringify(body.options) : "{}",
        body.callback_url ?? null,
      ]
    );

    const { js } = await nats();
    const env: Envelope<StreamProvisionRequested> = {
      job_id:     id,
      tenant_id:  tenant,
      trace_id:   tid,
      attempt_id: attemptId(id, "provision"),
      emitted_at: new Date().toISOString(),
      payload: {
        stream_id:   id,
        tenant_id:   tenant,
        target_lang: "en",
        source_hint: body.source_hint,
        options:     body.options,
      },
    };
    await publish(js, SUBJECTS.STREAM_PROVISION_REQUESTED, env);

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    return reply.code(201).send({
      stream_id: id,
      status:    "provisioning",
      ingest: {
        protocol:   "srt",
        url:        `srt://provisioning?streamid=${id}`,
        expires_at: expiresAt,
      },
      outputs: {
        websocket_url: `${wsBase()}/v1/streams/${id}/captions`,
        vtt_url:       `${publicBase()}/v1/streams/${id}/captions.vtt`,
        ttml_url:      `${publicBase()}/v1/streams/${id}/captions.ttml`,
      },
    });
  });

  // GET /v1/streams/:id — get stream status
  app.get<{ Params: { id: string } }>("/v1/streams/:id", { onRequest: app.requireAuth }, async (req, reply) => {
    const r = await getPool().query(
      `SELECT id, status, ingest_host, ingest_port, cue_count, created_at, started_at, ended_at, archived_at
       FROM streams
       WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenant_id]
    );
    if (r.rowCount === 0) {
      return reply.code(404).send({ code: "STREAM_NOT_FOUND", message: "Stream not found" });
    }
    return r.rows[0];
  });

  // DELETE /v1/streams/:id — end a stream
  app.delete<{ Params: { id: string } }>("/v1/streams/:id", { onRequest: app.requireAuth }, async (req, reply) => {
    const r = await getPool().query(
      `UPDATE streams
       SET status = 'ending'
       WHERE id = $1 AND tenant_id = $2 AND status IN ('provisioning', 'awaiting_ingest', 'active')
       RETURNING id`,
      [req.params.id, req.tenant_id]
    );
    if (r.rowCount === 0) {
      return reply.code(404).send({ code: "STREAM_NOT_FOUND", message: "Stream not found" });
    }

    // Best-effort: signal the supervisor to SIGTERM the pod. If NATS is down we still return 202.
    try {
      const { js } = await nats();
      const deleteEnv: Envelope<StreamDeleteRequested> = {
        job_id:     req.params.id,
        tenant_id:  req.tenant_id!,
        trace_id:   traceId(),
        attempt_id: attemptId(req.params.id, "delete"),
        emitted_at: new Date().toISOString(),
        payload: { stream_id: req.params.id },
      };
      await publish(js, SUBJECTS.STREAM_DELETE_REQUESTED, deleteEnv);
    } catch (err) {
      req.log.warn({ err }, "failed to publish STREAM_DELETE_REQUESTED — pod will not be SIGTERMed immediately");
    }

    return reply.code(202).send({ stream_id: req.params.id, status: "ending" });
  });
}
