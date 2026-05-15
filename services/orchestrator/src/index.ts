import {
  connectNats, getPool, withTx, createLogger, startTelemetry,
  publish, attemptId, createStorage, readObjectJson
} from "@audio-api/node-common";
import { SUBJECTS, Envelope, FileReady } from "@audio-api/proto";
import { nextStepsAfterFileReady, nextStepsAfterFormatReady } from "./pipeline.js";
import { isComplete, buildReport } from "./aggregate.js";

startTelemetry("orchestrator");
const log = createLogger("orchestrator");

async function loadAnalyses(jobId: string): Promise<string[]> {
  const r = await getPool().query<{ name: string }>(
    "SELECT name FROM analyses WHERE job_id = $1", [jobId]
  );
  return r.rows.map(x => x.name);
}

async function dispatch(js: any, env: Envelope<any>, analysis: string) {
  const subjectMap: Record<string, string> = {
    format:       SUBJECTS.WORK_FORMAT,
    vad:          SUBJECTS.WORK_VAD,
    language:     SUBJECTS.WORK_LANGUAGE,
    dme_classify: SUBJECTS.WORK_DME_CLASSIFY
  };
  const subject = subjectMap[analysis];
  if (!subject) {
    log.warn({ analysis }, "no subject for analysis");
    return;
  }
  await publish(js, subject, {
    ...env,
    attempt_id: attemptId(env.job_id, analysis),
    emitted_at: new Date().toISOString(),
    payload: { source_object_key: env.payload?.object_key }
  });
  await withTx(client => client.query(
    "UPDATE analyses SET status='running', started_at=COALESCE(started_at, now()) WHERE job_id=$1 AND name=$2",
    [env.job_id, analysis]
  ));
  await getPool().query(
    "INSERT INTO job_events (job_id, kind, stage, payload) VALUES ($1,'stage_started',$2,$3)",
    [env.job_id, analysis, {}]
  );
}

async function maybeFinalize(env: Envelope<any>, js: any, s3: any) {
  const aRows = await getPool().query<{ name: string; status: string; result_object: string | null; error: any }>(
    "SELECT name, status, result_object, error FROM analyses WHERE job_id = $1",
    [env.job_id]
  );
  const requested = aRows.rows.map(r => r.name);
  const statuses: Record<string, string> = {};
  const failures: any[] = [];
  const perAnalysis: Record<string, any> = {};
  for (const r of aRows.rows) {
    statuses[r.name] = r.status;
    if (r.status === "completed" && r.result_object) {
      perAnalysis[r.name] = await readObjectJson(s3, r.result_object);
    }
    if (r.status === "failed" && r.error) {
      failures.push({ analysis: r.name, ...r.error });
    }
  }
  if (!isComplete(requested, statuses)) return;

  const jr = await getPool().query<{ size_bytes: number | null }>("SELECT size_bytes FROM jobs WHERE id=$1", [env.job_id]);
  const duration = perAnalysis.format?.duration_s ?? 0;
  const size = Number(jr.rows[0]?.size_bytes ?? 0);
  const report = buildReport({
    job_id: env.job_id,
    input: { duration_s: duration, size_bytes: size },
    perAnalysis,
    failures
  });

  await getPool().query(
    `INSERT INTO results (job_id, report) VALUES ($1,$2)
     ON CONFLICT (job_id) DO UPDATE SET report = EXCLUDED.report`,
    [env.job_id, report]
  );
  const finalStatus = failures.length === requested.length ? "failed" : "completed";
  await getPool().query(
    `UPDATE jobs SET status=$2, completed_at=now(), duration_s=$3 WHERE id=$1`,
    [env.job_id, finalStatus, duration]
  );
  await getPool().query(
    `INSERT INTO job_events (job_id, kind, stage, payload) VALUES ($1,'stage_completed','aggregate',$2)`,
    [env.job_id, { status: finalStatus }]
  );
  await getPool().query(`SELECT pg_notify('job_done', $1)`, [env.job_id]);
  await publish(js, SUBJECTS.EVENT_JOB_DONE, {
    job_id: env.job_id,
    tenant_id: env.tenant_id,
    trace_id: env.trace_id,
    attempt_id: env.attempt_id,
    emitted_at: new Date().toISOString(),
    payload: { status: finalStatus }
  });
  log.info({ job_id: env.job_id, status: finalStatus }, "aggregate.done");
}

async function main() {
  const { nc, js, jsm } = await connectNats();
  const s3 = createStorage();

  try {
    await jsm.consumers.add("AUDIO_EVENTS", {
      durable_name: "orchestrator",
      filter_subjects: [
        "audio.event.file.ready",
        "audio.event.format.ready",
        "audio.event.vad.ready",
        "audio.event.language.ready",
        "audio.event.dme_classify.ready",
        "audio.event.job.failed"
      ],
      ack_policy: "explicit" as any
    } as any);
  } catch (e: any) {
    if (!/exists/i.test(String(e))) throw e;
  }

  const consumer = await js.consumers.get("AUDIO_EVENTS", "orchestrator");
  const sub = await consumer.consume({ max_messages: 8 });

  log.info("orchestrator consuming");

  for await (const m of sub) {
    try {
      const env = JSON.parse(new TextDecoder().decode(m.data)) as Envelope<any>;
      const subject = m.subject;
      const analyses = await loadAnalyses(env.job_id);

      if (subject === SUBJECTS.EVENT_FILE_READY) {
        await getPool().query(
          "UPDATE jobs SET status='running', started_at=COALESCE(started_at, now()), source_object=$2 WHERE id=$1",
          [env.job_id, (env as Envelope<FileReady>).payload.object_key]
        );
        for (const a of nextStepsAfterFileReady({ analyses })) {
          await dispatch(js, env, a);
        }
      } else if (subject === SUBJECTS.EVENT_FORMAT_READY) {
        await getPool().query(
          "UPDATE analyses SET status='completed', completed_at=now(), result_object=$3 WHERE job_id=$1 AND name=$2",
          [env.job_id, "format", env.payload.result_object]
        );
        await getPool().query(
          "INSERT INTO job_events (job_id, kind, stage, payload) VALUES ($1,'stage_completed','format',$2)",
          [env.job_id, env.payload]
        );
        for (const a of nextStepsAfterFormatReady({ analyses })) {
          await dispatch(js, env, a);
        }
        await maybeFinalize(env, js, s3);
      } else if (subject === SUBJECTS.EVENT_VAD_READY) {
        await getPool().query(
          "UPDATE analyses SET status='completed', completed_at=now(), result_object=$3 WHERE job_id=$1 AND name=$2",
          [env.job_id, "vad", env.payload.result_object]
        );
        await getPool().query(
          "INSERT INTO job_events (job_id, kind, stage, payload) VALUES ($1,'stage_completed','vad',$2)",
          [env.job_id, env.payload]
        );
        await maybeFinalize(env, js, s3);
      } else if (subject === SUBJECTS.EVENT_LANGUAGE_READY) {
        await getPool().query(
          "UPDATE analyses SET status='completed', completed_at=now(), result_object=$3 WHERE job_id=$1 AND name=$2",
          [env.job_id, "language", env.payload.result_object]
        );
        await getPool().query(
          "INSERT INTO job_events (job_id, kind, stage, payload) VALUES ($1,'stage_completed','language',$2)",
          [env.job_id, env.payload]
        );
        await maybeFinalize(env, js, s3);
      } else if (subject === SUBJECTS.EVENT_DME_CLASSIFY_READY) {
        await getPool().query(
          "UPDATE analyses SET status='completed', completed_at=now(), result_object=$3 WHERE job_id=$1 AND name=$2",
          [env.job_id, "dme_classify", env.payload.result_object]
        );
        await getPool().query(
          "INSERT INTO job_events (job_id, kind, stage, payload) VALUES ($1,'stage_completed','dme_classify',$2)",
          [env.job_id, env.payload]
        );
        await maybeFinalize(env, js, s3);
      } else if (subject === SUBJECTS.EVENT_JOB_FAILED) {
        await getPool().query(
          "UPDATE jobs SET status='failed', completed_at=now(), error=$2 WHERE id=$1",
          [env.job_id, env.payload]
        );
      }
      m.ack();
    } catch (e: any) {
      log.error({ err: e }, "orchestrator.error");
      m.nak(5000);
    }
  }
}

main().catch(e => { log.error({ err: e }, "fatal"); process.exit(1); });
