import { describe, it, expect } from "vitest";
import { jobId, tokenId, streamId, podId } from "./ids.js";

describe("id helpers", () => {
  it("jobId returns j_ prefix with ULID", () => {
    const id = jobId();
    expect(id).toMatch(/^j_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("tokenId returns t_ prefix with ULID", () => {
    const id = tokenId();
    expect(id).toMatch(/^t_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("streamId returns s_ prefix with ULID", () => {
    const id = streamId();
    expect(id).toMatch(/^s_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("podId returns p_ prefix with ULID", () => {
    const id = podId();
    expect(id).toMatch(/^p_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("generates unique IDs on each call", () => {
    const id1 = streamId();
    const id2 = streamId();
    expect(id1).not.toBe(id2);

    const id3 = podId();
    const id4 = podId();
    expect(id3).not.toBe(id4);
  });
});
