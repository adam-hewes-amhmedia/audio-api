import {
  connectNats, getPool, createLogger, startTelemetry, createStorage, BUCKET, publish
} from "@audio-api/node-common";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { SUBJECTS } from "@audio-api/proto";
import { isComplete, buildReport } from "./aggregate.js";

startTelemetry("aggregator");
const log = createLogger("aggregator");

async function readJson(s3: any, key: string): Promise<any> {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const text = await r.Body.transformToString();
  return JSON.parse(text);
}

async function main() {
  const { nc, js, jsm } = await connectNats();
  const s3 = createStorage();

  try {
    await jsm.consumers.add("AUDIO_EVENTS", {
      durable_name: "aggregator",
      filter_subjects: ["audio.event.format.ready", "audio.event.vad.ready"],
      ack_policy: "explicit" as any
    } as any);
  } catch (e: any) {
    if (!/exists/i.test(String(e))) throw e;
  }

  const consumer = await js.consumers.get("AUDIO_EVENTS", "aggregator");
  const sub = await consumer.consume({ max_messages: 4 });

  log.info("aggregator consuming");

  for await (const m of sub) {
    try {
      const env = JSON.parse(new TextDecoder().decode(m.data));
      const jobId = env.job_id;

      const aRows = await getPool().query<{ name: string; status: string; result_object: string | null; error: any }>(
        "SELECT name, status, result_object, error FROM analyses WHERE job_id = $1", [jobId]
      );
      const statuses: Record<string, string> = {};
      const failures: any[] = [];
      const perAnalysis: Record<string, any> = {};
      for (const r of aRows.rows) {
        statuses[r.name] = r.status;
        if (r.status === "completed" && r.result_object) {
          perAnalysis[r.name] = await readJson(s3, r.result_object);
        }
        if (r.status === "failed" && r.error) {
          failures.push({ analysis: r.name, ...r.error });
        }
      }

      const requested = aRows.rows.map(r => r.name);
      if (!isComplete(requested, statuses)) {
        m.ack();
        continue;
      }

      const jr = await getPool().query("SELECT size_bytes FROM jobs WHERE id=$1", [jobId]);
      const duration = perAnalysis.format?.duration_s ?? 0;
      const size = Number(jr.rows[0]?.size_bytes ?? 0);
      const report = buildReport({
        job_id: jobId,
        input: { duration_s: duration, size_bytes: size },
        perAnalysis,
        failures
      });

      await getPool().query(
        `INSERT INTO results (job_id, report) VALUES ($1,$2)
         ON CONFLICT (job_id) DO UPDATE SET report = EXCLUDED.report`,
        [jobId, report]
      );
      const finalStatus = failures.length === requested.length ? "failed" : "completed";
      await getPool().query(
        `UPDATE jobs SET status=$2, completed_at=now(), duration_s=$3 WHERE id=$1`,
        [jobId, finalStatus, duration]
      );
      await getPool().query(
        `INSERT INTO job_events (job_id, kind, stage, payload) VALUES ($1,'stage_completed','aggregate',$2)`,
        [jobId, { status: finalStatus }]
      );
      await getPool().query(`SELECT pg_notify('job_done', $1)`, [jobId]);
      await publish(js, SUBJECTS.EVENT_JOB_DONE, {
        job_id: jobId,
        tenant_id: env.tenant_id,
        trace_id: env.trace_id,
        attempt_id: env.attempt_id,
        emitted_at: new Date().toISOString(),
        payload: { status: finalStatus }
      });
      m.ack();
      log.info({ job_id: jobId, status: finalStatus }, "aggregate.done");
    } catch (e: any) {
      log.error({ err: e }, "aggregator.error");
      m.nak(5000);
    }
  }
}

main().catch(e => { log.error({ err: e }, "fatal"); process.exit(1); });
