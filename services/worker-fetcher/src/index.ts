import {
  connectNats, createStorage, createLogger, startTelemetry,
  publish
} from "@audio-api/node-common";
import { SUBJECTS, Envelope, FileReady } from "@audio-api/proto";
import { fetchToObjectStore } from "./fetcher.js";

startTelemetry("worker-fetcher");
const log = createLogger("worker-fetcher");

async function main() {
  const { nc, js, jsm } = await connectNats();
  const s3 = createStorage();

  try {
    await jsm.consumers.add("AUDIO_WORK", {
      durable_name: "worker-fetcher",
      filter_subject: SUBJECTS.WORK_FETCH,
      ack_policy: "explicit" as any,
      max_deliver: 3
    } as any);
  } catch (e: any) {
    if (!/exists/i.test(String(e))) throw e;
  }

  const consumer = await js.consumers.get("AUDIO_WORK", "worker-fetcher");
  const sub = await consumer.consume({ max_messages: 4 });

  log.info("worker-fetcher consuming");

  for await (const m of sub) {
    const env = JSON.parse(new TextDecoder().decode(m.data)) as Envelope<{ url: string }>;
    log.info({ job_id: env.job_id, trace_id: env.trace_id }, "fetch.start");
    try {
      const result = await fetchToObjectStore({ url: env.payload.url, jobId: env.job_id, s3 });
      const fileReady: Envelope<FileReady> = {
        job_id: env.job_id, tenant_id: env.tenant_id,
        trace_id: env.trace_id, attempt_id: env.attempt_id,
        emitted_at: new Date().toISOString(),
        payload: result
      };
      await publish(js, SUBJECTS.EVENT_FILE_READY, fileReady);
      m.ack();
      log.info({ job_id: env.job_id, size: result.size_bytes }, "fetch.done");
    } catch (e: any) {
      log.error({ err: e, job_id: env.job_id }, "fetch.failed");
      if (m.info.deliveryCount >= 3) {
        const dead: Envelope<{ stage: string; code: string; message: string }> = {
          job_id: env.job_id, tenant_id: env.tenant_id,
          trace_id: env.trace_id, attempt_id: env.attempt_id,
          emitted_at: new Date().toISOString(),
          payload: { stage: "fetch", code: e.code ?? "INTERNAL", message: e.message }
        };
        await publish(js, SUBJECTS.EVENT_JOB_FAILED, dead);
        m.ack();
      } else {
        m.nak(5000);
      }
    }
  }
}

main().catch(e => { log.error({ err: e }, "fatal"); process.exit(1); });
