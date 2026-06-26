import { FastifyInstance } from "fastify";
import {
  getPool, connectNats, publish, streamId, traceId, attemptId,
  sealHeaders, ApiError
} from "@audio-api/node-common";
import {
  SUBJECTS, StreamProvisionRequested, StreamDeleteRequested, StreamSourceKind, Envelope
} from "@audio-api/proto";

interface StreamCreateBody {
  source?: {
    kind?: string;
    url?: string;
    headers?: Record<string, string>;
  };
  source_hint?: string;
  output?: { target_lang?: string };
  options?: Record<string, unknown>;
  callback_url?: string;
}

const publicBase = () => process.env.PUBLIC_BASE_URL ?? "http://localhost:8080";
const wsBase    = () => process.env.PUBLIC_WS_URL   ?? "ws://localhost:8080";

const KINDS: ReadonlySet<StreamSourceKind> = new Set(["hls", "dash", "mp4"]);
const ALLOW_HTTP = process.env.STREAM_ALLOW_HTTP === "1";

function headersKey(): string {
  const k = process.env.STREAM_HEADERS_KEY;
  if (!k) throw new ApiError("INTERNAL", "STREAM_HEADERS_KEY is not configured");
  return k;
}

// Per-tenant concurrent-stream cap. Read at request time so it can be tuned via
// env. 0 / unset = unlimited (the production default of 2 is set in compose).
function maxConcurrentPerTenant(): number {
  const v = parseInt(process.env.STREAM_MAX_CONCURRENT_PER_TENANT ?? "0", 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// Statuses that count as an in-flight stream against the tenant cap.
const ACTIVE_STREAM_STATUSES = ["provisioning", "awaiting_ingest", "active", "ending"];

let natsRef: Awaited<ReturnType<typeof connectNats>> | null = null;
async function nats() {
  if (!natsRef) natsRef = await connectNats();
  return natsRef;
}

function validateSource(body: StreamCreateBody): { kind: StreamSourceKind; url: string; headers?: Record<string, string> } {
  const s = body.source;
  if (!s || !s.kind || !s.url) {
    throw new ApiError("INPUT_UNREACHABLE", "source.kind and source.url are required");
  }
  if (!KINDS.has(s.kind as StreamSourceKind)) {
    throw new ApiError("INPUT_UNREACHABLE", `source.kind must be one of: ${[...KINDS].join(", ")}`);
  }
  let u: URL;
  try {
    u = new URL(s.url);
  } catch {
    throw new ApiError("INPUT_UNREACHABLE", "source.url must be a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ApiError("INPUT_UNREACHABLE", "source.url must use http(s)");
  }
  if (u.protocol === "http:" && !ALLOW_HTTP) {
    throw new ApiError("INPUT_UNREACHABLE", "source.url must use https://");
  }
  if (s.headers && Object.keys(s.headers).length > 10) {
    throw new ApiError("INPUT_UNREACHABLE", "source.headers may not exceed 10 entries");
  }
  return { kind: s.kind as StreamSourceKind, url: s.url, headers: s.headers };
}

export async function streamsRoutes(app: FastifyInstance) {
  // POST /v1/streams — create a live subtitle stream
  app.post<{ Body: StreamCreateBody }>("/v1/streams", { onRequest: app.requireAuth }, async (req, reply) => {
    const body = req.body ?? {};
    const targetLang = body.output?.target_lang;

    if (targetLang !== undefined && targetLang !== "en") {
      throw new ApiError("INPUT_UNREACHABLE", "output.target_lang must be 'en' in v1");
    }
    const source = validateSource(body);

    const id    = streamId();
    const tid   = traceId();
    const tenant = req.tenant_id!;

    const cap = maxConcurrentPerTenant();
    if (cap > 0) {
      const active = await getPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM streams WHERE tenant_id = $1 AND status = ANY($2)`,
        [tenant, ACTIVE_STREAM_STATUSES]
      );
      if (active.rows[0].n >= cap) {
        throw new ApiError("STREAM_CAP_EXCEEDED", "Concurrent stream cap reached for this tenant");
      }
    }

    // source.headers are sealed with AES-256-GCM (STREAM_HEADERS_KEY) before they
    // touch Postgres. The pod never reads this column — it receives the headers
    // inline on the NATS provision message (memory only). See migration 0006.
    await getPool().query(
      `INSERT INTO streams
         (id, tenant_id, status, source_kind, source_url, source_headers, source_hint, target_lang, options, callback_url)
       VALUES ($1, $2, 'provisioning', $3, $4, $5, $6, 'en', $7, $8)`,
      [
        id,
        tenant,
        source.kind,
        source.url,
        sealHeaders(source.headers ?? null, headersKey()),
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
        source:      { kind: source.kind, url: source.url, headers: source.headers },
        source_hint: body.source_hint,
        options:     body.options,
      },
    };
    await publish(js, SUBJECTS.STREAM_PROVISION_REQUESTED, env);

    return reply.code(201).send({
      stream_id: id,
      status:    "provisioning",
      source: { kind: source.kind, url: source.url },   // headers deliberately omitted, never echoed
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
      `SELECT id, status, source_kind, source_url, cue_count, created_at, started_at, ended_at, archived_at
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
