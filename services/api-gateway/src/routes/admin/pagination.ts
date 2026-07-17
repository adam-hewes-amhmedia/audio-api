import { ApiError } from "@audio-api/node-common";

// Keyset pagination, not offset.
//
// jobs and streams take continuous inserts, and both are ordered newest-first.
// With OFFSET, a row inserted between page 1 and page 2 shifts everything down
// one, so the console shows a duplicate at the top of page 2 and silently skips
// a row at the boundary. Neither is visible to the operator, which is exactly
// the failure you do not want in a triage tool. A cursor anchored to a row's
// own (created_at, id) is stable under churn.
//
// The pair is required, not just created_at: created_at has no uniqueness
// guarantee, and two rows sharing a timestamp would make the boundary
// ambiguous. id breaks the tie and matches the index ordering.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface Cursor {
  ts: string;
  id: string;
}

export function encodeCursor(created_at: Date | string, id: string): string {
  const iso = created_at instanceof Date ? created_at.toISOString() : new Date(created_at).toISOString();
  return Buffer.from(`${iso}|${id}`, "utf8").toString("base64url");
}

// Opaque to the client on purpose: a cursor is a position, not an API. Decoding
// is strict so a hand-crafted or truncated cursor fails loudly as a 400 rather
// than being coerced into a silently wrong window.
export function decodeCursor(raw: string): Cursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw new ApiError("ADMIN_INVALID_QUERY", "cursor is not valid base64url");
  }
  const sep = decoded.indexOf("|");
  if (sep <= 0 || sep === decoded.length - 1) {
    throw new ApiError("ADMIN_INVALID_QUERY", "cursor is malformed");
  }
  const ts = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (Number.isNaN(Date.parse(ts))) {
    throw new ApiError("ADMIN_INVALID_QUERY", "cursor timestamp is not a valid date");
  }
  return { ts, id };
}

// Clamped rather than rejected at the top end: a console asking for 10000 rows
// is a bug in the console, and serving 200 keeps the operator moving. A
// non-numeric or negative limit is a different thing entirely (the caller
// believes something false) and is rejected.
export function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ApiError("ADMIN_INVALID_QUERY", "limit must be a positive integer");
  }
  return Math.min(n, MAX_LIMIT);
}

// Builds the trailing `(created_at, id) < ($n, $n+1)` clause. Returns the SQL
// fragment and the params to append, so callers cannot get the placeholder
// numbering out of step with the values.
export function keysetClause(cursor: string | undefined, nextParamIndex: number): { sql: string; params: string[] } {
  if (!cursor) return { sql: "", params: [] };
  const { ts, id } = decodeCursor(cursor);
  return {
    sql: `(created_at, id) < ($${nextParamIndex}::timestamptz, $${nextParamIndex + 1})`,
    params: [ts, id],
  };
}

// The list envelope is always { items, next_cursor }.
//
// Deliberately no total count: counting an unfiltered cross-tenant table means
// a full index scan on every page, and the number is stale before it reaches
// the browser. next_cursor is null when the page is not full, which is the only
// end-of-list signal the console needs.
export function page<T extends { created_at: Date | string; id: string }>(
  rows: T[],
  limit: number
): { items: T[]; next_cursor: string | null } {
  const next = rows.length === limit ? encodeCursor(rows[rows.length - 1].created_at, rows[rows.length - 1].id) : null;
  return { items: rows, next_cursor: next };
}
