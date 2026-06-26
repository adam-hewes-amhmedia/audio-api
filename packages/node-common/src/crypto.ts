import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM sealed blob layout: iv(12) || tag(16) || ciphertext.
const IV_LEN = 12;
const TAG_LEN = 16;
const ALGO = "aes-256-gcm";

function loadKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) {
    throw new Error(`STREAM_HEADERS_KEY must decode to 32 bytes, got ${key.length}`);
  }
  return key;
}

/**
 * Encrypt a header map for at-rest storage. Returns null for null input so
 * callers can pass it straight through to a nullable column.
 */
export function sealHeaders(headers: Record<string, string> | null, keyB64: string): Buffer | null {
  if (headers === null) return null;
  const key = loadKey(keyB64);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(headers), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

/**
 * Decrypt a sealed header blob produced by sealHeaders. Returns null for null
 * input. Throws if the blob is malformed, truncated, tampered, or the key is wrong.
 */
export function openHeaders(sealed: Buffer | null, keyB64: string): Record<string, string> | null {
  if (sealed === null) return null;
  if (sealed.length < IV_LEN + TAG_LEN) {
    throw new Error("sealed header blob is too short");
  }
  const key = loadKey(keyB64);
  const iv = sealed.subarray(0, IV_LEN);
  const tag = sealed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = sealed.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as Record<string, string>;
}
