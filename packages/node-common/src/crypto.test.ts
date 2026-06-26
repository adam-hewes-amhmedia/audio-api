import { describe, it, expect } from "vitest";
import { sealHeaders, openHeaders } from "./crypto.js";

const KEY = Buffer.alloc(32, 7).toString("base64"); // 32-byte test key

describe("sealHeaders/openHeaders", () => {
  it("round-trips a header map", () => {
    const hdrs = { Authorization: "Bearer x", "X-Tok": "y" };
    const sealed = sealHeaders(hdrs, KEY);
    expect(Buffer.isBuffer(sealed)).toBe(true);
    expect(openHeaders(sealed, KEY)).toEqual(hdrs);
  });

  it("returns null for null input", () => {
    expect(sealHeaders(null, KEY)).toBeNull();
    expect(openHeaders(null, KEY)).toBeNull();
  });

  it("produces a fresh IV each call (ciphertext differs)", () => {
    const a = sealHeaders({ a: "b" }, KEY)!;
    const b = sealHeaders({ a: "b" }, KEY)!;
    expect(a.equals(b)).toBe(false);
  });

  it("rejects a tampered ciphertext", () => {
    const sealed = sealHeaders({ a: "b" }, KEY)!;
    sealed[sealed.length - 1] ^= 0xff;
    expect(() => openHeaders(sealed, KEY)).toThrow();
  });

  it("rejects a wrong key", () => {
    const sealed = sealHeaders({ a: "b" }, KEY)!;
    const otherKey = Buffer.alloc(32, 9).toString("base64");
    expect(() => openHeaders(sealed, otherKey)).toThrow();
  });
});
