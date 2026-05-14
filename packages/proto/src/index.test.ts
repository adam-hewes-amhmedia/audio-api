import { describe, it, expect } from "vitest";
import { validateEnvelope, validateFileReady, validateFormatReady } from "./index.js";

describe("envelope schema", () => {
  it("accepts a well-formed envelope", () => {
    const ok = validateEnvelope({
      job_id: "j_01HX",
      tenant_id: "t_acme",
      trace_id: "abc",
      attempt_id: "att",
      emitted_at: new Date().toISOString(),
      payload: {}
    });
    expect(ok).toBe(true);
  });
  it("rejects missing fields", () => {
    const ok = validateEnvelope({ job_id: "j" });
    expect(ok).toBe(false);
    expect(validateEnvelope.errors?.length).toBeGreaterThan(0);
  });
});

describe("file-ready schema", () => {
  it("validates sha256 format", () => {
    expect(validateFileReady({ object_key: "k", size_bytes: 1, sha256: "x" })).toBe(false);
    const goodHash = "a".repeat(64);
    expect(validateFileReady({ object_key: "k", size_bytes: 1, sha256: goodHash })).toBe(true);
  });
});

describe("format-ready schema", () => {
  it("accepts a well-formed payload", () => {
    const ok = validateFormatReady({
      result_object: "results/j_x/format.json",
      codec: "pcm_s24le",
      sample_rate: 48000,
      bit_depth: 24,
      channel_count: 6,
      channel_layout: "5.1",
      duration_s: 3612.4
    });
    expect(ok).toBe(true);
  });

  it("rejects payload missing required fields", () => {
    const ok = validateFormatReady({
      result_object: "k",
      codec: "pcm_s16le"
      // missing sample_rate, channel_count
    });
    expect(ok).toBe(false);
    expect(validateFormatReady.errors?.length).toBeGreaterThan(0);
  });

  it("accepts payload with only required fields", () => {
    const ok = validateFormatReady({
      result_object: "k",
      codec: "aac",
      sample_rate: 44100,
      channel_count: 2
    });
    expect(ok).toBe(true);
  });
});
