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
});
