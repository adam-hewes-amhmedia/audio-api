export type StreamStatus =
  | "provisioning"
  | "awaiting_ingest"
  | "active"
  | "ending"
  | "ended"
  | "archived"
  | "failed";

export type StreamEvent =
  | "ready"
  | "ingest_started"
  | "ingest_ended"
  | "archived"
  | "failed"
  | "delete_requested";

const TERMINAL: ReadonlySet<StreamStatus> = new Set(["archived", "failed"]);

type Transition = [StreamStatus, StreamEvent, StreamStatus];

const TRANSITIONS: Transition[] = [
  ["provisioning",    "ready",           "awaiting_ingest"],
  ["provisioning",    "failed",          "failed"],
  ["provisioning",    "delete_requested","ending"],
  ["awaiting_ingest", "ingest_started",  "active"],
  ["awaiting_ingest", "failed",          "failed"],
  ["awaiting_ingest", "delete_requested","ending"],
  ["active",          "ingest_ended",    "ended"],
  ["active",          "failed",          "failed"],
  ["active",          "delete_requested","ending"],
  ["ending",          "ingest_ended",    "ended"],
  ["ending",          "failed",          "failed"],
  ["ended",           "archived",        "archived"],
  ["ended",           "failed",          "failed"],
];

const TABLE = new Map<string, StreamStatus>(
  TRANSITIONS.map(([cur, ev, next]) => [`${cur}:${ev}`, next])
);

export function applyStreamEvent(
  current: StreamStatus,
  ev: StreamEvent
): { next: StreamStatus; terminal: boolean } {
  const next = TABLE.get(`${current}:${ev}`);
  if (next === undefined) {
    throw new Error(`invalid transition: ${current} --${ev}-->`);
  }
  return { next, terminal: TERMINAL.has(next) };
}
