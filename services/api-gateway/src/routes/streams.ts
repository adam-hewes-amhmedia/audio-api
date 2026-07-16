import { FastifyInstance } from "fastify";
import {
  getPool, connectNats, publish, streamId, traceId, attemptId,
  sealHeaders, ApiError
} from "@audio-api/node-common";
import {
  SUBJECTS, StreamProvisionRequested, StreamDeleteRequested, StreamSourceKind, StreamSourceMode, Envelope
} from "@audio-api/proto";

interface StreamCreateBody {
  source?: {
    kind?: string;
    url?: string;
    mode?: string;
    passphrase?: string;
    headers?: Record<string, string>;
  };
  source_hint?: string;
  output?: { target_lang?: string; caption_ts?: boolean };
  options?: Record<string, unknown>;
  callback_url?: string;
}

const publicBase = () => process.env.PUBLIC_BASE_URL ?? "http://localhost:8080";
const wsBase    = () => process.env.PUBLIC_WS_URL   ?? "ws://localhost:8080";
const srtBase   = () => process.env.SRT_PUBLIC_HOST ?? "localhost";

const KINDS: ReadonlySet<StreamSourceKind> = new Set(["hls", "dash", "mp4", "srt"]);
// srt is the odd one out against the pull kinds: it has a direction, may carry
// a passphrase, and has no use for headers.
const SRT_MODES: ReadonlySet<StreamSourceMode> = new Set(["caller", "listener"]);
const ALLOW_HTTP = process.env.STREAM_ALLOW_HTTP === "1";

// libsrt's own bounds: "Crypto PBKDF2 Passphrase size[0,10..64]". Rejecting here
// beats ffmpeg rejecting it later, where the client cannot see why.
const PASSPHRASE_MIN = 10;
const PASSPHRASE_MAX = 64;

// A listener sits on an open inbound UDP port, so the passphrase is the only
// thing authenticating whoever connects. Unauthenticated ingest is a dev-only
// escape hatch, mirroring STREAM_ALLOW_HTTP.
const allowUnauthIngest = () => process.env.STREAM_ALLOW_UNAUTH_INGEST === "1";

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

interface ValidatedSource {
  kind: StreamSourceKind;
  url?: string;
  mode?: StreamSourceMode;
  passphrase?: string;
  headers?: Record<string, string>;
}

function parseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new ApiError("INPUT_UNREACHABLE", "source.url must be a valid URL");
  }
}

function validateSrtSource(s: NonNullable<StreamCreateBody["source"]>): ValidatedSource {
  const mode = s.mode as StreamSourceMode | undefined;
  if (!mode || !SRT_MODES.has(mode)) {
    throw new ApiError("INPUT_UNREACHABLE", `source.mode is required for srt and must be one of: ${[...SRT_MODES].join(", ")}`);
  }
  if (s.headers) {
    throw new ApiError("INPUT_UNREACHABLE", "source.headers is not valid for an srt source");
  }
  if (s.passphrase !== undefined) {
    if (s.passphrase.length < PASSPHRASE_MIN || s.passphrase.length > PASSPHRASE_MAX) {
      throw new ApiError("INPUT_UNREACHABLE", `source.passphrase must be ${PASSPHRASE_MIN}-${PASSPHRASE_MAX} characters`);
    }
  }

  if (mode === "listener") {
    // We allocate and hand back the ingest endpoint, so a client-supplied url
    // would be silently ignored. Reject it rather than pretend we honoured it.
    if (s.url) {
      throw new ApiError("INPUT_UNREACHABLE", "source.url must be omitted for an srt listener; the ingest endpoint is assigned and returned as ingest.url");
    }
    if (s.passphrase === undefined && !allowUnauthIngest()) {
      throw new ApiError("INPUT_UNREACHABLE", "source.passphrase is required for an srt listener");
    }
    return { kind: "srt", mode, passphrase: s.passphrase };
  }

  if (!s.url) {
    throw new ApiError("INPUT_UNREACHABLE", "source.url is required for an srt caller");
  }
  if (parseUrl(s.url).protocol !== "srt:") {
    throw new ApiError("INPUT_UNREACHABLE", "source.url must use srt:// for an srt source");
  }
  return { kind: "srt", url: s.url, mode, passphrase: s.passphrase };
}

function validateSource(body: StreamCreateBody): ValidatedSource {
  const s = body.source;
  if (!s || !s.kind) {
    throw new ApiError("INPUT_UNREACHABLE", "source.kind is required");
  }
  if (!KINDS.has(s.kind as StreamSourceKind)) {
    throw new ApiError("INPUT_UNREACHABLE", `source.kind must be one of: ${[...KINDS].join(", ")}`);
  }
  if (s.kind === "srt") {
    return validateSrtSource(s);
  }

  // Pull kinds (hls/dash/mp4): unchanged.
  if (!s.url) {
    throw new ApiError("INPUT_UNREACHABLE", "source.kind and source.url are required");
  }
  if (s.mode !== undefined || s.passphrase !== undefined) {
    throw new ApiError("INPUT_UNREACHABLE", "source.mode and source.passphrase are only valid for an srt source");
  }
  const u = parseUrl(s.url);
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
    const captionTs = body.output?.caption_ts === true;
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
         (id, tenant_id, status, source_kind, source_url, source_mode, source_passphrase,
          source_headers, source_hint, target_lang, options, callback_url, caption_ts_enabled)
       VALUES ($1, $2, 'provisioning', $3, $4, $5, $6, $7, $8, 'en', $9, $10, $11)`,
      [
        id,
        tenant,
        source.kind,
        source.url ?? null,          // null only for an srt listener; we assign that endpoint
        source.mode ?? null,
        // Sealed with the same key and helper as source.headers: the pod gets the
        // plaintext inline on the NATS message and never reads this column back.
        sealHeaders(source.passphrase ? { passphrase: source.passphrase } : null, headersKey()),
        sealHeaders(source.headers ?? null, headersKey()),
        body.source_hint ?? null,
        body.options ? JSON.stringify(body.options) : "{}",
        body.callback_url ?? null,
        captionTs,
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
        source: {
          kind: source.kind, url: source.url, headers: source.headers,
          mode: source.mode, passphrase: source.passphrase,
        },
        source_hint: body.source_hint,
        options:     body.options,
        caption_ts:  captionTs,
      },
    };
    await publish(js, SUBJECTS.STREAM_PROVISION_REQUESTED, env);

    return reply.code(201).send({
      stream_id: id,
      status:    "provisioning",
      // headers and passphrase deliberately omitted, never echoed
      source: { kind: source.kind, url: source.url, mode: source.mode },
      outputs: {
        websocket_url: `${wsBase()}/v1/streams/${id}/captions`,
        vtt_url:       `${publicBase()}/v1/streams/${id}/captions.vtt`,
        ttml_url:      `${publicBase()}/v1/streams/${id}/captions.ttml`,
        // Host only: the supervisor allocates the SRT port during provisioning,
        // so the concrete srt://host:port is surfaced on GET once the pod is ready.
        ...(captionTs ? { caption_srt_url: `srt://${srtBase()}` } : {}),
      },
    });
  });

  // GET /v1/streams/:id — get stream status
  app.get<{ Params: { id: string } }>("/v1/streams/:id", { onRequest: app.requireAuth }, async (req, reply) => {
    const r = await getPool().query(
      `SELECT s.id, s.status, s.source_kind, s.source_url, s.cue_count, s.created_at,
              s.started_at, s.ended_at, s.archived_at, s.caption_ts_enabled, p.srt_port
       FROM streams s
       LEFT JOIN stream_pods p ON p.pod_id = s.pod_id
       WHERE s.id = $1 AND s.tenant_id = $2`,
      [req.params.id, req.tenant_id]
    );
    if (r.rowCount === 0) {
      return reply.code(404).send({ code: "STREAM_NOT_FOUND", message: "Stream not found" });
    }

    // caption_ts_enabled / srt_port are join plumbing, not part of the stream row.
    // The concrete SRT URL only exists once the supervisor has allocated a port.
    const { caption_ts_enabled, srt_port, ...stream } = r.rows[0];
    if (!caption_ts_enabled) return stream;
    return {
      ...stream,
      outputs: srt_port ? { caption_srt_url: `srt://${srtBase()}:${srt_port}` } : {},
    };
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
