import { describe, it, expect } from "vitest";
import {
  validateEnvelope, validateFileReady, validateFormatReady, validateVadReady,
  validateLanguageReady, validateDmeClassifyReady,
  validateStreamProvisionRequested,
  validateStreamReady,
  validateStreamIngestStarted,
  validateStreamIngestEnded,
  validateStreamCueFinalised,
  validateStreamFailed,
  validateStreamDeleteRequested,
  SUBJECTS
} from "./index.js";

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

describe("vad-ready schema", () => {
  it("validates a per-channel structure", () => {
    expect(validateVadReady({ result_object: "x", per_channel: [
      { channel: 0, speech_ratio: 0.5, segments: [{ start_ms: 0, end_ms: 100 }] }
    ]})).toBe(true);
    expect(validateVadReady({ result_object: "x", per_channel: [{ channel: 0 }] })).toBe(false);
  });
});

describe("language-ready schema", () => {
  it("accepts valid ISO codes", () => {
    expect(validateLanguageReady({
      result_object: "x",
      per_channel: [{ channel: 0, language: "en", confidence: 0.97 }]
    })).toBe(true);
    expect(validateLanguageReady({
      result_object: "x",
      per_channel: [{ channel: 0, language: "EN", confidence: 0.97 }]
    })).toBe(false);
  });
});

describe("dme-classify-ready schema", () => {
  it("validates tag enum", () => {
    expect(validateDmeClassifyReady({
      result_object: "x",
      per_channel: [{ channel: 0, timeline: [{ start_ms: 0, end_ms: 100, tag: "dialog" }] }]
    })).toBe(true);
    expect(validateDmeClassifyReady({
      result_object: "x",
      per_channel: [{ channel: 0, timeline: [{ start_ms: 0, end_ms: 100, tag: "voiceover" }] }]
    })).toBe(false);
  });
});

it("loads stream event schemas and SUBJECTS", () => {
  expect(validateStreamProvisionRequested).toBeTypeOf("function");
  expect(validateStreamReady).toBeTypeOf("function");
  expect(validateStreamIngestStarted).toBeTypeOf("function");
  expect(validateStreamIngestEnded).toBeTypeOf("function");
  expect(validateStreamCueFinalised).toBeTypeOf("function");
  expect(validateStreamFailed).toBeTypeOf("function");
  expect(SUBJECTS.STREAM_PROVISION_REQUESTED).toBe("audio.stream.provision.requested");
  expect(SUBJECTS.STREAM_READY).toBe("audio.stream.ready");
  expect(SUBJECTS.STREAM_INGEST_STARTED).toBe("audio.stream.ingest.started");
  expect(SUBJECTS.STREAM_INGEST_ENDED).toBe("audio.stream.ingest.ended");
  expect(SUBJECTS.STREAM_CUE_FINALISED).toBe("audio.stream.cue.finalised");
  expect(SUBJECTS.STREAM_FAILED).toBe("audio.stream.failed");
});

it("loads stream-delete-requested validator and SUBJECT", () => {
  expect(validateStreamDeleteRequested).toBeTypeOf("function");
  expect(SUBJECTS.STREAM_DELETE_REQUESTED).toBe("audio.stream.delete.requested");
  expect(validateStreamDeleteRequested({ stream_id: "s_01HX" })).toBe(true);
  expect(validateStreamDeleteRequested({})).toBe(false);
});

it("validates a sample stream-provision-requested payload", () => {
  const ok = validateStreamProvisionRequested({
    stream_id: "s_01HX",
    tenant_id: "t1",
    source: { kind: "hls", url: "https://cdn.example.com/m.m3u8" },
    options: { model_size: "medium" },
    source_hint: "fr",
    target_lang: "en"
  });
  expect(ok).toBe(true);
});

it("rejects a stream-provision-requested payload missing source", () => {
  const bad = validateStreamProvisionRequested({
    stream_id: "s_01HX",
    tenant_id: "t1",
    target_lang: "en"
  });
  expect(bad).toBe(false);
});
