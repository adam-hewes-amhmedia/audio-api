import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import yaml from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

export interface ErrorCodeMeta {
  http: number;
  retry: boolean;
  action: string;
}

export const ERROR_CODES: Record<string, ErrorCodeMeta> = yaml.parse(
  readFileSync(resolve(root, "error-codes.yaml"), "utf8")
);

export function httpStatusFor(code: string): number {
  return ERROR_CODES[code]?.http ?? 500;
}

// Lazy, unlike ERROR_CODES: the admin spec is only read by the test that keeps
// it honest against the real router, so there is no reason to parse it into
// every service that imports this package.
export function loadAdminOpenApi(): { paths: Record<string, Record<string, unknown>> } {
  return yaml.parse(readFileSync(resolve(root, "openapi-admin.yaml"), "utf8"));
}

export type ErrorCode = keyof typeof ERROR_CODES;
