import {
  connectNats, getPool, createLogger, startTelemetry
} from "@audio-api/node-common";
import { SUBJECTS, Envelope } from "@audio-api/proto";
import { sign } from "./sign.js";
import { deliverWithRetries } from "./deliver.js";

startTelemetry("worker-webhook");
const log = createLogger("worker-webhook");

async function main() {
  const { nc, js, jsm } = await connectNats();

  try {
    await jsm.consumers.add("AUDIO_EVENTS", {
      durable_name: "worker-webhook",
      filter_subjects: [SUBJECTS.EVENT_JOB_DONE, SUBJECTS.EVENT_JOB_FAILED],
      ack_policy: "explicit" as any
    } as any);
  } catch (e: any) {
    if (!/exists/i.test(String(e))) throw e;
  }

  const consumer = await js.consumers.get("AUDIO_EVENTS", "worker-webhook");
  const sub = await consumer.consume({ max_messages: 4 });

  log.info("worker-webhook consuming");

  for await (const m of sub) {
    try {
      const env = JSON.parse(new TextDecoder().decode(m.data)) as Envelope<any>;
      const job = await getPool().query(
        "SELECT callback_url, tenant_id, status FROM jobs WHERE id=$1", [env.job_id]
      );
      if (!job.rowCount || !job.rows[0].callback_url) { m.ack(); continue; }

      const tenant = job.rows[0].tenant_id;
      const secretRow = await getPool().query(
        "SELECT webhook_secret FROM tenant_secrets WHERE tenant_id=$1", [tenant]
      );
      if (!secretRow.rowCount) {
        log.warn({ tenant }, "no webhook secret");
        m.ack();
        continue;
      }

      const payload = {
        event: m.subject === SUBJECTS.EVENT_JOB_DONE ? "job.completed" : "job.failed",
        job_id: env.job_id,
        status: job.rows[0].status,
        results_url: `${process.env.PUBLIC_API_URL ?? "http://localhost:8080"}/v1/jobs/${env.job_id}/results`
      };
      const body = JSON.stringify(payload);
      const sig = sign(body, secretRow.rows[0].webhook_secret);

      const result = await deliverWithRetries(job.rows[0].callback_url, body, {
        headers: { "X-Signature": sig, "X-Job-Id": env.job_id }
      });

      await getPool().query(
        `INSERT INTO job_events (job_id, kind, stage, payload) VALUES ($1, 'webhook_attempt', NULL, $2)`,
        [env.job_id, result]
      );
      m.ack();
      log.info({ job_id: env.job_id, ok: result.success, attempts: result.attempts }, "webhook.done");
    } catch (e: any) {
      log.error({ err: e }, "webhook.error");
      m.nak(5000);
    }
  }
}

main().catch(e => { log.error({ err: e }, "fatal"); process.exit(1); });
