import { describe, it, expect } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";

describe("logger redaction", () => {
  it("redacts token field", () => {
    let captured = "";
    const sink = new Writable({
      write(c, _e, cb) { captured += c.toString(); cb(); }
    });
    const log = pino(
      {
        base: { service: "t" },
        redact: { paths: ["token", "*.token", "headers.authorization"], censor: "[REDACTED]" }
      },
      sink
    );
    log.info({ token: "secret123" }, "x");
    expect(captured).not.toContain("secret123");
    expect(captured).toContain("[REDACTED]");
  });
});
