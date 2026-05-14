import pino, { Logger } from "pino";

const REDACT_PATHS = [
  "*.password", "*.token", "*.headers.authorization",
  "*.url", "input_descriptor.headers.*"
];

export function createLogger(service: string): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { service, version: process.env.SERVICE_VERSION ?? "dev" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" }
  });
}
