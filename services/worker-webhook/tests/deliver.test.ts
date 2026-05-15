import { describe, it, expect, vi } from "vitest";
import { deliverWithRetries, BACKOFF_MS } from "../src/deliver.js";

describe("deliverWithRetries", () => {
  it("succeeds on first 2xx", async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200 } as Response));
    const result = await deliverWithRetries("https://x", "body", { sleep: async () => {}, fetchImpl: f as any });
    expect(result.attempts).toBe(1);
    expect(result.success).toBe(true);
  });
  it("retries 5 times then gives up", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 500 } as Response));
    const result = await deliverWithRetries("https://x", "body", { sleep: async () => {}, fetchImpl: f as any });
    expect(result.attempts).toBe(BACKOFF_MS.length);
    expect(result.success).toBe(false);
  });
});
