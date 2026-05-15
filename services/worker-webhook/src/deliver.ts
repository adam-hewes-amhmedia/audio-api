export const BACKOFF_MS = [0, 1000, 5000, 30_000, 120_000, 600_000];

export interface DeliverOpts {
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

export async function deliverWithRetries(url: string, body: string, opts: DeliverOpts = {}) {
  const sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const f = opts.fetchImpl ?? fetch;
  let lastStatus = 0;
  for (let i = 0; i < BACKOFF_MS.length; i++) {
    if (BACKOFF_MS[i] > 0) await sleep(BACKOFF_MS[i]);
    try {
      const res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
        body
      });
      lastStatus = res.status;
      if (res.ok) return { success: true, attempts: i + 1, status: res.status };
    } catch {
      lastStatus = 0;
    }
  }
  return { success: false, attempts: BACKOFF_MS.length, status: lastStatus };
}
