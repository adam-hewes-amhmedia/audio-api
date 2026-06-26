import { renderEbuTtD, type ArchiveCue } from "./ebu-tt-d.js";

export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
export type PutFn = (key: string, body: Buffer, contentType?: string) => Promise<void>;

export interface ArchiveDeps {
  query: QueryFn;
  put: PutFn;
  attempts?: number;     // total attempts before giving up (default 3)
  backoffMs?: number;    // base backoff between attempts (default 200; 0 in tests)
}

export interface ArchiveResult {
  ttml_object: string;
  cue_count: number;
}

export function ttmlKey(streamId: string): string {
  return `archives/${streamId}/captions.ttml`;
}

/**
 * Render and upload the EBU-TT-D archive for a stream, then mark the row.
 * Single attempt: throws on any failure (load, render, upload, or DB update).
 */
export async function archiveStream(streamId: string, deps: ArchiveDeps): Promise<ArchiveResult> {
  const stream = await deps.query(
    "SELECT status, target_lang FROM streams WHERE id = $1",
    [streamId]
  );
  if (!stream.rowCount) throw new Error(`stream ${streamId} not found`);
  const lang = stream.rows[0].target_lang ?? "en";

  const cueRows = await deps.query(
    "SELECT cue_id, start_ms, end_ms, text FROM stream_cues WHERE stream_id = $1 ORDER BY cue_id",
    [streamId]
  );
  const cues: ArchiveCue[] = cueRows.rows.map((r) => ({
    cue_id: r.cue_id,
    start_ms: r.start_ms,
    end_ms: r.end_ms,
    text: r.text,
  }));

  const xml = renderEbuTtD(cues, { lang });
  const key = ttmlKey(streamId);
  await deps.put(key, Buffer.from(xml, "utf8"), "application/ttml+xml");

  await deps.query(
    "UPDATE streams SET ttml_object = $2, archived_at = COALESCE(archived_at, now()) WHERE id = $1",
    [streamId, key]
  );

  return { ttml_object: key, cue_count: cues.length };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RetryOutcome {
  ok: boolean;
  ttml_object?: string;
  cue_count?: number;
  attempts: number;
  error?: string;
}

/**
 * Archive with bounded retries. Archive failure is non-fatal: the row is left
 * as-is (status `ended`, live VTT still served) and the caller surfaces
 * STREAM_ARCHIVE_FAILED. A successful run returns the ttml object key.
 */
export async function runArchiveWithRetries(streamId: string, deps: ArchiveDeps): Promise<RetryOutcome> {
  const attempts = deps.attempts ?? 3;
  const backoff = deps.backoffMs ?? 200;
  let lastErr = "";
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await archiveStream(streamId, deps);
      return { ok: true, attempts: i, ...res };
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
      if (i < attempts && backoff > 0) await sleep(backoff * i);
    }
  }
  return { ok: false, attempts, error: lastErr };
}
