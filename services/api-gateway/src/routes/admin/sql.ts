// Column lists for every admin read, as named constants.
//
// Layer 1 of the "never expose a secret" guarantee. There is no SELECT * in the
// admin surface, ever. `SELECT s.* FROM streams s` would pull source_headers
// and source_passphrase — both AES-256-GCM sealed — straight into a response
// body, and the next migration to add a sensitive column would do it again
// silently. Naming columns means a new secret column is invisible to admin
// until someone deliberately adds it here.
//
// This layer fails silently if someone gets it wrong, which is why mappers.ts
// exists as layer 2.

// Sealed columns, never selected: source_headers, source_passphrase.
export const STREAM_COLS = `
  s.id, s.tenant_id, s.status, s.source_kind, s.source_url, s.source_mode,
  s.source_hint, s.target_lang, s.options, s.callback_url, s.pod_id,
  s.ttml_object, s.cue_count, s.caption_ts_enabled,
  s.created_at, s.started_at, s.ended_at, s.archived_at, s.error
`;

// token_hash is never selected.
export const JOB_COLS = `
  j.id, j.tenant_id, j.status, j.input_descriptor, j.options, j.callback_url,
  j.mode, j.source_object, j.source_sha256, j.duration_s, j.size_bytes,
  j.created_at, j.started_at, j.completed_at, j.error
`;

export const ANALYSIS_COLS = `
  a.job_id, a.name, a.status, a.attempts, a.result_object, a.error,
  a.started_at, a.completed_at
`;

export const JOB_EVENT_COLS = `
  e.id, e.job_id, e.ts, e.kind, e.stage, e.payload
`;

export const CUE_COLS = `
  c.stream_id, c.cue_id, c.start_ms, c.end_ms, c.text, c.source_text, c.confidence
`;

// Staleness is computed in SQL, not in the console, against the same env var the
// reaper reads (STREAM_POD_STALE_AFTER_S, worker-stream-supervisor/worker.py:35).
// If the console applied its own threshold in JS, the console and the reaper
// could disagree about whether a pod is alive, and the operator would be
// debugging the tool instead of the fleet.
// Takes the placeholder index for the staleness threshold so callers composing
// this into a larger query cannot get the parameter numbering out of step.
export const podCols = (staleParam: number) => `
  p.pod_id, p.supervisor_host, p.ws_host, p.ws_port, p.srt_port, p.ingest_port,
  p.stream_id, p.status, p.last_heartbeat,
  EXTRACT(EPOCH FROM (now() - p.last_heartbeat))::int AS heartbeat_age_s,
  (now() - p.last_heartbeat) > make_interval(secs => $${staleParam}::int) AS stale
`;

export function podStaleAfterS(): number {
  const v = parseInt(process.env.STREAM_POD_STALE_AFTER_S ?? "30", 10);
  return Number.isFinite(v) && v > 0 ? v : 30;
}
