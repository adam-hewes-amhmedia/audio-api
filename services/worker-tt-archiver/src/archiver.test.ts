import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { getPool, createStorage, putObject, getObjectStream } from "@audio-api/node-common";
import { archiveStream, runArchiveWithRetries, ttmlKey } from "./archive.js";

// Integration test: requires Postgres + MinIO (host-pointed env vars).
const pool = getPool();
const s3 = createStorage();
const realPut = (key: string, body: Buffer, ct?: string) => putObject(s3, key, body, ct);
const query = (sql: string, params?: unknown[]) => pool.query(sql, params as any[]);

// Unique per module load so this suite is isolated from any concurrent copy
// (vitest runs both src/*.test.ts and the compiled dist/*.test.js against the
// same Postgres + object store; a shared id raced on rows and TTML keys). The
// derived ttmlKey(SID) inherits the uniqueness, so storage objects don't collide.
const SID = `s_archtest_${randomBytes(6).toString("hex")}`;

async function streamToString(stream: any): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

beforeAll(async () => {
  await pool.query("DELETE FROM streams WHERE id = $1", [SID]);
});
afterAll(async () => {
  await pool.query("DELETE FROM streams WHERE id = $1", [SID]);
});

beforeEach(async () => {
  await pool.query("DELETE FROM streams WHERE id = $1", [SID]);
  await pool.query(
    `INSERT INTO streams (id, tenant_id, status, source_kind, source_url, target_lang)
     VALUES ($1, 'tenant_test', 'ended', 'hls', 'https://cdn.example.com/x.m3u8', 'en')`,
    [SID]
  );
  await pool.query(
    `INSERT INTO stream_cues (stream_id, cue_id, start_ms, end_ms, text) VALUES
       ($1, 0, 1000, 3000, 'We are approaching the terminal.'),
       ($1, 1, 3200, 5000, 'Mind the gap.')`,
    [SID]
  );
});

describe("archiveStream", () => {
  it("writes a TTML object to storage and marks the stream", async () => {
    const res = await archiveStream(SID, { query, put: realPut });
    expect(res.cue_count).toBe(2);
    expect(res.ttml_object).toBe(ttmlKey(SID));

    const xml = await streamToString(await getObjectStream(s3, ttmlKey(SID)));
    expect(xml).toContain("<tt:tt");
    expect(xml).toContain("We are approaching the terminal.");
    expect((xml.match(/<tt:p\b/g) ?? []).length).toBe(2);

    const row = await pool.query("SELECT ttml_object, archived_at FROM streams WHERE id = $1", [SID]);
    expect(row.rows[0].ttml_object).toBe(ttmlKey(SID));
    expect(row.rows[0].archived_at).not.toBeNull();
  });
});

describe("runArchiveWithRetries", () => {
  it("retries 3x on upload failure and leaves the stream un-archived", async () => {
    let calls = 0;
    const failingPut = async () => { calls++; throw new Error("s3 down"); };

    const outcome = await runArchiveWithRetries(SID, { query, put: failingPut, backoffMs: 0 });
    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(3);
    expect(calls).toBe(3);

    const row = await pool.query("SELECT status, ttml_object, archived_at FROM streams WHERE id = $1", [SID]);
    expect(row.rows[0].status).toBe("ended");        // not invalidated
    expect(row.rows[0].ttml_object).toBeNull();       // no archive recorded
    expect(row.rows[0].archived_at).toBeNull();
  });

  it("succeeds on the first try and reports the object key", async () => {
    const outcome = await runArchiveWithRetries(SID, { query, put: realPut, backoffMs: 0 });
    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(1);
    expect(outcome.ttml_object).toBe(ttmlKey(SID));
  });
});
