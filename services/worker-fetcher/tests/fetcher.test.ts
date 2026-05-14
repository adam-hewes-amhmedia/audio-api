import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { fetchToObjectStore } from "../src/fetcher.js";

describe("fetchToObjectStore", () => {
  it("streams the URL into storage, computes sha256 + size", async () => {
    const body = Buffer.from("hello-audio");
    const expectedSha = createHash("sha256").update(body).digest("hex");

    const fakeFetch = vi.fn(async () => ({
      ok: true, status: 200,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      headers: new Headers({ "content-length": String(body.length) })
    } as unknown as Response));

    const putCalls: any[] = [];
    const fakeS3 = { send: vi.fn(async (cmd: any) => { putCalls.push(cmd.input); return {}; }) } as any;

    const result = await fetchToObjectStore({
      url: "https://example.com/a.wav",
      jobId: "j_x",
      s3: fakeS3,
      fetchImpl: fakeFetch as any
    });

    expect(result.object_key).toBe("working/j_x/source.bin");
    expect(result.sha256).toBe(expectedSha);
    expect(result.size_bytes).toBe(body.length);
    expect(putCalls).toHaveLength(1);
  });

  it("throws INPUT_UNREACHABLE on non-2xx", async () => {
    const fakeFetch = vi.fn(async () => ({ ok: false, status: 404 } as unknown as Response));
    await expect(fetchToObjectStore({
      url: "x", jobId: "j_x", s3: {} as any, fetchImpl: fakeFetch as any
    })).rejects.toThrowError(/INPUT_UNREACHABLE/);
  });
});
