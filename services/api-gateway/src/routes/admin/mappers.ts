// Layer 2 of the secret guarantee: every admin response is built field by field
// here. sql.ts stops secrets being fetched; if it ever fails it fails silently,
// because an extra column just rides along in the row object. These mappers fail
// loudly instead — a field that is not named here does not reach the client, so
// forgetting to add one is a missing field in the console, not a leak.
//
// Never map: source_headers, source_passphrase, token_hash, webhook_secret.

// Presigned URLs *are* credentials. A raw jobs.input_descriptor.url carries
// ?X-Amz-Signature=... which is a working, time-limited grant to the customer's
// object; a callback_url may carry a secret path segment or query token. Both
// are the non-obvious ones that get missed, because neither field name looks
// like a secret.
//
// origin + pathname keeps everything an operator triages with (which bucket,
// which object, which host) and drops the part that grants access.
export function redactUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const u = new URL(raw);
    return u.origin + u.pathname;
  } catch {
    // Not a parseable URL. Do not echo it back: an unparseable string in a url
    // field is already unexpected, and guessing is how a secret escapes.
    return null;
  }
}

const URL_KEY = /url$/i;

// job_events.payload is worker-written jsonb with no schema the gateway controls,
// so a worker may echo a source or callback URL into it at any depth. Walking it
// is the only way to be sure; a top-level check would miss
// { attempt: { request: { url: "...?X-Amz-Signature=..." } } }.
export function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = URL_KEY.test(k) && typeof v === "string" ? redactUrl(v) : redactDeep(v);
    }
    return out;
  }
  return value;
}

export function mapStream(r: any) {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    status: r.status,
    source: {
      kind: r.source_kind,
      // Same class of risk as input_descriptor.url: an HLS/DASH manifest URL is
      // routinely signed, so the query string is a credential.
      url: redactUrl(r.source_url),
      mode: r.source_mode,
      hint: r.source_hint,
    },
    target_lang: r.target_lang,
    options: r.options,
    callback_url: redactUrl(r.callback_url),
    pod_id: r.pod_id,
    ttml_object: r.ttml_object,
    cue_count: r.cue_count,
    caption_ts_enabled: r.caption_ts_enabled,
    created_at: r.created_at,
    started_at: r.started_at,
    ended_at: r.ended_at,
    archived_at: r.archived_at,
    error: r.error,
  };
}

export function mapJob(r: any) {
  const d = r.input_descriptor ?? {};
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    status: r.status,
    input: {
      // Rebuilt rather than spread: input_descriptor is jsonb the client
      // supplied, so `...d` would pass through whatever they put in it.
      kind: d.kind ?? null,
      url: redactUrl(d.url),
    },
    options: r.options,
    callback_url: redactUrl(r.callback_url),
    mode: r.mode,
    source_object: r.source_object,
    source_sha256: r.source_sha256,
    duration_s: r.duration_s === null ? null : Number(r.duration_s),
    size_bytes: r.size_bytes === null ? null : Number(r.size_bytes),
    created_at: r.created_at,
    started_at: r.started_at,
    completed_at: r.completed_at,
    error: r.error,
  };
}

export function mapAnalysis(r: any) {
  return {
    name: r.name,
    status: r.status,
    attempts: r.attempts,
    result_object: r.result_object,
    error: r.error,
    started_at: r.started_at,
    completed_at: r.completed_at,
  };
}

export function mapJobEvent(r: any) {
  return {
    id: Number(r.id),
    ts: r.ts,
    kind: r.kind,
    stage: r.stage,
    payload: redactDeep(r.payload),
  };
}

// Cue text is exposed deliberately. It is customer content, and it is also the
// entire point of the console: "the captions are garbage" is unanswerable
// without reading them. Admin-only, and the view is audited.
export function mapCue(r: any) {
  return {
    cue_id: r.cue_id,
    start_ms: r.start_ms,
    end_ms: r.end_ms,
    text: r.text,
    source_text: r.source_text,
    confidence: r.confidence,
  };
}

export function mapPod(r: any) {
  return {
    pod_id: r.pod_id,
    supervisor_host: r.supervisor_host,
    ws_host: r.ws_host,
    ws_port: r.ws_port,
    srt_port: r.srt_port,
    ingest_port: r.ingest_port,
    stream_id: r.stream_id,
    tenant_id: r.tenant_id ?? null,
    status: r.status,
    last_heartbeat: r.last_heartbeat,
    heartbeat_age_s: r.heartbeat_age_s,
    stale: r.stale,
  };
}

// No token_hash, ever. The plaintext is returned exactly once, by the issue
// route, and is never stored to be mapped here.
export function mapToken(r: any) {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    name: r.name,
    created_at: r.created_at,
    revoked_at: r.revoked_at,
  };
}
