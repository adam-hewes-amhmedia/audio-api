#!/usr/bin/env -S node --import tsx
/**
 * Skeleton smoke test for the live-subtitles Stream lifecycle.
 *
 * Drives: POST /v1/streams -> wait for status=active -> open WS ->
 * collect at least 2 stub cues -> DELETE -> assert status=ending.
 *
 * Usage:
 *   API_URL=http://localhost:8080 \
 *   DEV_TOKEN=test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa \
 *   pnpm dlx tsx scripts/smoke-stream.ts
 *
 * Or via pnpm script:
 *   pnpm run smoke:stream
 */

const API   = process.env.API_URL   ?? "http://localhost:8080";
const TOKEN = process.env.DEV_TOKEN ?? "test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AUTH  = { authorization: `Bearer ${TOKEN}` };
const STATUS_TIMEOUT_MS = 30_000;
const CUE_TIMEOUT_MS    = 30_000;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function pollStatus(id: string, target: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const r = await fetch(`${API}/v1/streams/${id}`, { headers: AUTH });
    if (r.status === 200) {
      const body = await r.json() as { status: string };
      last = body.status;
      if (last === target) return last;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for status='${target}' (last='${last}')`);
}

async function main() {
  console.log("[smoke] creating stream...");
  const createRes = await fetch(`${API}/v1/streams`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ source_hint: "fr", output: { target_lang: "en" } }),
  });
  if (createRes.status !== 201) {
    throw new Error(`POST /v1/streams expected 201, got ${createRes.status}: ${await createRes.text()}`);
  }
  const created = await createRes.json() as {
    stream_id: string;
    status: string;
    ingest: { protocol: string; url: string; expires_at: string };
    outputs: { websocket_url: string; vtt_url: string; ttml_url: string };
  };
  console.log(`[smoke] stream_id=${created.stream_id}`);
  if (!created.stream_id.startsWith("s_")) throw new Error("stream_id not s_-prefixed");
  if (created.status !== "provisioning")   throw new Error(`expected status=provisioning, got ${created.status}`);
  if (created.ingest.protocol !== "srt")   throw new Error("ingest.protocol not srt");
  if (!created.outputs.websocket_url.includes(created.stream_id)) throw new Error("ws url missing stream id");

  console.log("[smoke] waiting for status=active (provisioning -> awaiting_ingest -> active, ~3-5s)...");
  const reachedActive = await pollStatus(created.stream_id, "active", STATUS_TIMEOUT_MS);
  console.log(`[smoke] status=${reachedActive}`);

  console.log("[smoke] opening WebSocket to gateway proxy...");
  const wsUrl = created.outputs.websocket_url;
  // Node 24 native WebSocket supports custom headers
  const ws = new WebSocket(wsUrl, { headers: AUTH } as any);

  const cues: any[] = [];
  await new Promise<void>((resolve, reject) => {
    const tmo = setTimeout(() => reject(new Error("timed out waiting for >= 2 cues")), CUE_TIMEOUT_MS);
    ws.addEventListener("message", (event: MessageEvent) => {
      const msg = JSON.parse(event.data.toString());
      if (msg.event === "cue.finalised") {
        cues.push(msg);
        console.log(`[smoke] cue #${msg.cue_id}: "${String(msg.text).slice(0, 60)}"`);
        if (cues.length >= 2) { clearTimeout(tmo); resolve(); }
      }
    });
    ws.addEventListener("error", (event: Event) => {
      clearTimeout(tmo);
      reject(new Error(`WebSocket error: ${(event as any).message ?? "unknown"}`));
    });
  });

  if (cues.length < 2) throw new Error(`expected >= 2 cues, got ${cues.length}`);
  if (typeof cues[0].text !== "string" || !cues[0].text.startsWith("[stub cue")) {
    throw new Error(`cue text doesn't look like a stub cue: ${cues[0].text}`);
  }
  if (cues[1].cue_id <= cues[0].cue_id) {
    throw new Error(`cue_id should increase: ${cues[0].cue_id} -> ${cues[1].cue_id}`);
  }

  console.log("[smoke] closing WS and deleting stream...");
  try { ws.close(); } catch {}
  const delRes = await fetch(`${API}/v1/streams/${created.stream_id}`, { method: "DELETE", headers: AUTH });
  if (delRes.status !== 202) {
    throw new Error(`DELETE expected 202, got ${delRes.status}: ${await delRes.text()}`);
  }
  const delBody = await delRes.json() as { status: string };
  if (delBody.status !== "ending") throw new Error(`DELETE response status expected ending, got ${delBody.status}`);

  // Confirm DB also reflects 'ending' (polled to allow a moment for any orchestrator updates)
  const finalStatus = (await (await fetch(`${API}/v1/streams/${created.stream_id}`, { headers: AUTH })).json() as any).status;
  if (!["ending", "ended"].includes(finalStatus)) {
    throw new Error(`expected ending/ended, got ${finalStatus}`);
  }

  console.log(`\n[smoke] PASS — stream ${created.stream_id} reached status='active', emitted ${cues.length} cues, ended cleanly`);
  process.exit(0);
}

main().catch(e => {
  console.error("[smoke] FAIL:", e?.message ?? e);
  process.exit(1);
});
