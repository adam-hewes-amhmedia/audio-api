import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import yaml from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

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

export type ErrorCode = keyof typeof ERROR_CODES;
