import {
  connectNats, getPool, createLogger, startTelemetry, createStorage, putObject, jc
} from "@audio-api/node-common";
import { SUBJECTS } from "@audio-api/proto";
import { runArchiveWithRetries } from "./archive.js";

startTelemetry("worker-tt-archiver");
const log = createLogger("worker-tt-archiver");

async function main() {
  const { js, jsm } = await connectNats();
  const s3 = createStorage();

  try {
    await jsm.consumers.add("AUDIO_STREAMS", {
      durable_name: "worker-tt-archiver",
      filter_subjects: [SUBJECTS.STREAM_INGEST_ENDED],
      ack_policy: "explicit" as any
    } as any);
  } catch (e: any) {
    if (!/exists/i.test(String(e))) throw e;
  }

  const consumer = await js.consumers.get("AUDIO_STREAMS", "worker-tt-archiver");
  const sub = await consumer.consume({ max_messages: 4 });
  log.info("worker-tt-archiver consuming");

  const pool = getPool();
  const deps = {
    query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]),
    put: (key: string, body: Buffer, ct?: string) => putObject(s3, key, body, ct),
  };

  for await (const m of sub) {
    try {
      const evt = jc.decode(m.data) as { stream_id?: string };
      const streamId = evt.stream_id;
      if (!streamId) { m.ack(); continue; }

      const outcome = await runArchiveWithRetries(streamId, deps);
      if (outcome.ok) {
        await js.publish(
          SUBJECTS.STREAM_ARCHIVED,
          jc.encode({ stream_id: streamId, ttml_object: outcome.ttml_object })
        );
        log.info({ stream_id: streamId, cues: outcome.cue_count }, "stream.archived");
      } else {
        // Archive failure is non-fatal: the live VTT is still served and the
        // stream stays `ended`. Surface STREAM_ARCHIVE_FAILED for operators.
        log.error(
          { stream_id: streamId, code: "STREAM_ARCHIVE_FAILED", attempts: outcome.attempts, err: outcome.error },
          "archive.failed"
        );
      }
      m.ack();
    } catch (e: any) {
      log.error({ err: e }, "archiver.error");
      m.nak(5000);
    }
  }
}

main().catch(e => { log.error({ err: e }, "fatal"); process.exit(1); });
