import { setTimeout as sleep } from "node:timers/promises";

const API = process.env.API_URL ?? "http://localhost:8080";
const TOKEN = process.env.API_TOKEN!;
if (!TOKEN) { console.error("API_TOKEN required"); process.exit(1); }

const SAMPLE_URL = process.env.SAMPLE_URL
  ?? "https://upload.wikimedia.org/wikipedia/commons/c/c5/Ostendo_Tonkunst_Sample.ogg";

async function smokeFormat() {
  console.log("=== format smoke ===");
  console.log("→ health");
  const h = await fetch(`${API}/v1/health`).then(r => r.json());
  if (h.status !== "ok") throw new Error("health not ok");

  console.log("→ submit");
  const sub = await fetch(`${API}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ input: { type: "url", url: SAMPLE_URL }, analyses: ["format"] })
  });
  if (sub.status !== 201) { console.error(await sub.text()); throw new Error(`submit ${sub.status}`); }
  const { job_id } = await sub.json();
  console.log("  job_id:", job_id);

  for (let i = 0; i < 30; i++) {
    const s = await fetch(`${API}/v1/jobs/${job_id}`, { headers: { authorization: `Bearer ${TOKEN}` } }).then(r => r.json());
    process.stdout.write(`  status=${s.status} analyses=${JSON.stringify(s.analyses)}\r`);
    if (s.status === "completed") {
      console.log("\n→ results");
      const rep = await fetch(`${API}/v1/jobs/${job_id}/results`, { headers: { authorization: `Bearer ${TOKEN}` } }).then(r => r.json());
      console.log(JSON.stringify(rep, null, 2));
      if (!rep.format) throw new Error("no format in report");
      console.log("format OK");
      return;
    }
    if (s.status === "failed") throw new Error("job failed: " + JSON.stringify(s));
    await sleep(2000);
  }
  throw new Error("timeout");
}

async function smokeWithVadAndWebhook() {
  console.log("\n=== VAD + webhook smoke ===");

  const received: any[] = [];
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, () => r()));
  const port = (server.address() as any).port;
  const cb = `http://host.docker.internal:${port}/hook`;

  const { execSync } = await import("node:child_process");
  execSync(
    `docker compose -f infra/docker-compose.yml exec -T postgres psql -U audio -d audio -c ` +
    `"INSERT INTO tenant_secrets (tenant_id, webhook_secret) VALUES ('tenant_dev','dev-secret') ON CONFLICT DO NOTHING;"`
  );

  const sub = await fetch(`${API}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      input: { type: "url", url: SAMPLE_URL },
      analyses: ["format", "vad"],
      callback_url: cb
    })
  });
  const { job_id } = await sub.json();
  console.log("  job_id:", job_id);

  const start = Date.now();
  while (received.length === 0 && Date.now() - start < 120_000) {
    await sleep(1000);
  }
  if (received.length === 0) throw new Error("webhook not received");
  console.log("webhook headers:", received[0].headers["x-signature"], "body:", received[0].body.slice(0, 80));

  const { createHmac } = await import("node:crypto");
  const expected = "sha256=" + createHmac("sha256", "dev-secret").update(received[0].body).digest("hex");
  if (received[0].headers["x-signature"] !== expected) throw new Error("HMAC mismatch");

  server.close();
  console.log("VAD + webhook OK");
}

async function run() {
  await smokeFormat();
  await smokeWithVadAndWebhook();
}

run().catch(e => { console.error(e); process.exit(1); });
