import { connect, NatsConnection, JetStreamClient, JSONCodec, headers as natsHeaders } from "nats";
import { Envelope } from "@audio-api/proto";

export const jc = JSONCodec();

export interface NatsClients {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: Awaited<ReturnType<NatsConnection["jetstreamManager"]>>;
}

export async function connectNats(url = process.env.NATS_URL ?? "nats://localhost:4222"): Promise<NatsClients> {
  const nc = await connect({ servers: url, maxReconnectAttempts: -1 });
  const js = nc.jetstream();
  const jsm = await nc.jetstreamManager();
  return { nc, js, jsm };
}

export async function publish<T>(js: JetStreamClient, subject: string, envelope: Envelope<T>): Promise<void> {
  const h = natsHeaders();
  h.set("X-Trace-Id", envelope.trace_id);
  h.set("X-Attempt-Id", envelope.attempt_id);
  await js.publish(subject, jc.encode(envelope), { headers: h });
}

export function decodeEnvelope<T>(data: Uint8Array): Envelope<T> {
  return jc.decode(data) as Envelope<T>;
}
