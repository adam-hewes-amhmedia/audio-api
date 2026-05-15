import { describe, it, expect } from "vitest";
import { nextStepsAfterFileReady, nextStepsAfterFormatReady } from "../src/pipeline.js";

describe("pipeline rules", () => {
  it("file.ready always dispatches format", () => {
    const next = nextStepsAfterFileReady({ analyses: ["format"] });
    expect(next).toEqual(["format"]);
  });
  it("format.ready dispatches no further work in Plan 1", () => {
    const next = nextStepsAfterFormatReady({ analyses: ["format"] });
    expect(next).toEqual([]);
  });
  it("format.ready dispatches vad when requested", () => {
    expect(nextStepsAfterFormatReady({ analyses: ["format", "vad"] })).toEqual(["vad"]);
    expect(nextStepsAfterFormatReady({ analyses: ["format"] })).toEqual([]);
  });
  it("fans out language and dme_classify after format", () => {
    const next = nextStepsAfterFormatReady({ analyses: ["format", "language", "dme_classify"] });
    expect(next.sort()).toEqual(["dme_classify", "language"]);
  });
});
