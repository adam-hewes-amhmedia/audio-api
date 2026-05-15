import { describe, it, expect } from "vitest";
import { isComplete, buildReport } from "../src/aggregate.js";

describe("aggregator", () => {
  it("isComplete true only when every requested analysis is completed", () => {
    expect(isComplete(["format"], { format: "completed" })).toBe(true);
    expect(isComplete(["format", "vad"], { format: "completed" })).toBe(false);
    expect(isComplete(["format"], { format: "failed" })).toBe(true);
  });
  it("buildReport merges per-analysis JSON payloads", () => {
    const report = buildReport({
      job_id: "j_x",
      input: { duration_s: 5, size_bytes: 100 },
      perAnalysis: {
        format: { codec: "pcm_s16le", sample_rate: 48000, channel_count: 2, channel_layout: "stereo", duration_s: 5 }
      },
      failures: []
    });
    expect(report).toMatchObject({
      job_id: "j_x",
      format: { codec: "pcm_s16le", channel_count: 2 }
    });
  });
  it("includes vad when present", () => {
    const r = buildReport({
      job_id: "j_x", input: { duration_s: 5, size_bytes: 100 },
      perAnalysis: {
        format: { codec: "pcm_s16le", sample_rate: 48000, channel_count: 1, channel_layout: "mono", duration_s: 5 },
        vad: { per_channel: [{ channel: 0, speech_ratio: 0.4, segments: [{ start_ms: 0, end_ms: 200 }] }] }
      },
      failures: []
    });
    expect(r.vad.per_channel[0].channel).toBe(0);
  });
});
