import { setTimeout as sleep } from "node:timers/promises";

const API = process.env.API_URL ?? "http://localhost:8080";
const TOKEN = process.env.API_TOKEN!;
if (!TOKEN) { console.error("API_TOKEN required"); process.exit(1); }

const SAMPLE_URL = process.env.SAMPLE_URL
  ?? "https://upload.wikimedia.org/wikipedia/commons/c/c5/Ostendo_Tonkunst_Sample.ogg";

async function main() {
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
      console.log("OK");
      return;
    }
    if (s.status === "failed") throw new Error("job failed: " + JSON.stringify(s));
    await sleep(2000);
  }
  throw new Error("timeout");
}

main().catch(e => { console.error(e); process.exit(1); });
