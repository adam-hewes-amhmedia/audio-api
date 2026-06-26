#!/usr/bin/env -S node --import tsx
/**
 * Plan 6 full-stack E2E: drive a real stream through the running service stack.
 *
 * POST /v1/streams (real source URL) -> orchestrator/supervisor fork a pod ->
 * pod pulls + decodes with ffmpeg, runs Silero VAD + faster-whisper translate ->
 * real cues over the gateway WS proxy -> rolling WebVTT -> on end the
 * worker-tt-archiver writes the EBU-TT-D archive.
 *
 * Asserts: status reaches active; >=1 real (non-stub) cue over WS; captions.vtt
 * served; after end, captions.ttml served (valid EBU-TT-D).
 *
 * Usage (stack must be up + a token seeded):
 *   API_URL=http://localhost:8080 DEV_TOKEN=... \
 *   STREAM_SOURCE_URL=https://.../clip.mp4 STREAM_SOURCE_KIND=mp4 STREAM_HINT=fr \
 *   node --import tsx scripts/e2e-stream.ts
 */

const API   = process.env.API_URL   ?? "http://localhost:8080";
const TOKEN = process.env.DEV_TOKEN ?? "test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AUTH  = { authorization: `Bearer ${TOKEN}` };
const SOURCE_URL  = process.env.STREAM_SOURCE_URL ?? "";
const SOURCE_KIND = process.env.STREAM_SOURCE_KIND ?? "mp4";
const HINT        = process.env.STREAM_HINT ?? "fr";

// The pod downloads + loads the model, then runs CPU inference — be patient.
const ACTIVE_TIMEOUT_MS = 360_000;
const CUE_TIMEOUT_MS    = 360_000;
const ENDED_TIMEOUT_MS  = 360_000;
const TTML_TIMEOUT_MS   = 120_000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function pollStatus(id: string, targets: string | string[], timeoutMs: number): Promise<string> {
  const want = Array.isArray(targets) ? targets : [targets];
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const r = await fetch(`${API}/v1/streams/${id}`, { headers: AUTH });
    if (r.status === 200) {
      last = ((await r.json()) as { status: string }).status;
      if (want.includes(last)) return last;
      if (last === "failed" && !want.includes("failed")) throw new Error(`stream went to 'failed'`);
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for status in [${want.join(",")}] (last='${last}')`);
}

async function main() {
  if (!SOURCE_URL) throw new Error("set STREAM_SOURCE_URL");
  console.log(`[e2e] POST /v1/streams kind=${SOURCE_KIND} url=${SOURCE_URL}`);
  const createRes = await fetch(`${API}/v1/streams`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ source: { kind: SOURCE_KIND, url: SOURCE_URL }, source_hint: HINT, output: { target_lang: "en" } }),
  });
  if (createRes.status !== 201) throw new Error(`POST expected 201, got ${createRes.status}: ${await createRes.text()}`);
  const created = await createRes.json() as { stream_id: string; outputs: { websocket_url: string; vtt_url: string; ttml_url: string } };
  const id = created.stream_id;
  console.log(`[e2e] stream_id=${id}`);

  console.log("[e2e] waiting for status=active (model load + first frame)...");
  console.log(`[e2e] status=${await pollStatus(id, "active", ACTIVE_TIMEOUT_MS)}`);

  console.log("[e2e] opening WS proxy, collecting real cues...");
  const ws = new WebSocket(created.outputs.websocket_url, { headers: AUTH } as any);
  const cues: any[] = [];
  await new Promise<void>((resolve, reject) => {
    const tmo = setTimeout(() => (cues.length ? resolve() : reject(new Error("no cues within timeout"))), CUE_TIMEOUT_MS);
    ws.addEventListener("message", (e: MessageEvent) => {
      const msg = JSON.parse(e.data.toString());
      if (msg.event === "cue.finalised") {
        cues.push(msg);
        console.log(`[e2e] cue #${msg.cue_id} ${(msg.start_ms/1000).toFixed(1)}-${(msg.end_ms/1000).toFixed(1)}s: ${String(msg.text).slice(0,80)}`);
        if (cues.length >= 3) { clearTimeout(tmo); resolve(); }
      }
    });
    ws.addEventListener("error", (ev: Event) => { clearTimeout(tmo); reject(new Error(`WS error: ${(ev as any).message ?? "unknown"}`)); });
  });
  try { ws.close(); } catch {}
  if (cues.length < 1) throw new Error("expected >= 1 real cue");
  if (String(cues[0].text).startsWith("[stub cue")) throw new Error("got STUB cues — pod is in stub mode");

  console.log("[e2e] checking captions.vtt playlist + first segment...");
  const vttRes = await fetch(`${API}/v1/streams/${id}/captions.vtt`, { headers: AUTH });
  if (vttRes.status !== 200) throw new Error(`captions.vtt expected 200, got ${vttRes.status}`);
  const playlist = await vttRes.text();
  if (!playlist.includes("#EXTM3U")) throw new Error("captions.vtt is not an HLS WebVTT playlist");
  const segRes = await fetch(`${API}/v1/streams/${id}/segments/000001.vtt`, { headers: AUTH });
  if (segRes.status !== 200 || !(await segRes.text()).includes("WEBVTT")) throw new Error("first VTT segment missing/invalid");

  console.log("[e2e] waiting for end (ended or archived; the archiver may advance it fast)...");
  console.log(`[e2e] status=${await pollStatus(id, ["ended", "archived"], ENDED_TIMEOUT_MS)}`);

  console.log("[e2e] waiting for the EBU-TT-D archive...");
  const deadline = Date.now() + TTML_TIMEOUT_MS;
  let ttml = "";
  while (Date.now() < deadline) {
    const r = await fetch(`${API}/v1/streams/${id}/captions.ttml`, { headers: AUTH });
    if (r.status === 200) { ttml = await r.text(); break; }
    await sleep(2000);
  }
  if (!ttml.includes("<tt:tt")) throw new Error("captions.ttml not available / not EBU-TT-D");
  console.log(`[e2e] TTML archive OK (${(ttml.match(/<tt:p\b/g) ?? []).length} cues)`);

  console.log(`\n[e2e] PASS — ${id}: active -> ${cues.length}+ real cues -> VTT -> ended -> EBU-TT-D archive`);
  process.exit(0);
}

main().catch(e => { console.error("[e2e] FAIL:", e?.message ?? e); process.exit(1); });
