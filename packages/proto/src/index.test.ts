import { describe, it, expect } from "vitest";
import { validateEnvelope, validateFileReady } from "./index.js";

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
