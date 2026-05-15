import { describe, it, expect } from "vitest";
import { sign } from "../src/sign.js";
import { createHmac } from "node:crypto";

describe("sign", () => {
  it("produces sha256 hmac over the body", () => {
    const body = '{"a":1}';
    const sig = sign(body, "supersecret");
    const expected = "sha256=" + createHmac("sha256", "supersecret").update(body).digest("hex");
    expect(sig).toBe(expected);
  });
});
