import Ajv, { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const schemasDir = resolve(here, "..", "schemas");

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

function load(name: string): ValidateFunction {
  const raw = readFileSync(resolve(schemasDir, name), "utf8");
  return ajv.compile(JSON.parse(raw));
}

export const validateEnvelope = load("envelope.json");
export const validateFileReady = load("events/file-ready.json");
export const validateFormatReady = load("events/format-ready.json");
export const validateVadReady = load("events/vad-ready.json");
export const validateLanguageReady = load("events/language-ready.json");
export const validateDmeClassifyReady = load("events/dme-classify-ready.json");

export interface Envelope<P = unknown> {
  job_id: string;
  tenant_id: string;
  trace_id: string;
  span_id?: string;
  attempt_id: string;
  emitted_at: string;
  payload: P;
}

export interface FileReady {
  object_key: string;
  size_bytes: number;
  sha256: string;
}

export interface FormatReady {
  result_object: string;
  codec: string;
  sample_rate: number;
  bit_depth?: number;
  channel_count: number;
  channel_layout?: string;
  duration_s?: number;
}

export interface VadSegment {
  start_ms: number;
  end_ms: number;
}

export interface VadPerChannel {
  channel: number;
  speech_ratio: number;
  segments: VadSegment[];
}

export interface VadReady {
  result_object: string;
  per_channel: VadPerChannel[];
}

export interface LanguagePerChannel {
  channel: number;
  language: string;
  confidence: number;
}

export interface LanguageReady {
  result_object: string;
  per_channel: LanguagePerChannel[];
}

export interface DmeTimelineEntry {
  start_ms: number;
  end_ms: number;
  tag: string;
  confidence?: number;
}

export interface DmePerChannel {
  channel: number;
  timeline: DmeTimelineEntry[];
}

export interface DmeClassifyReady {
  result_object: string;
  per_channel: DmePerChannel[];
}

export const SUBJECTS = {
  WORK_FETCH:               "audio.work.fetch",
  WORK_FORMAT:              "audio.work.format",
  WORK_VAD:                 "audio.work.vad",
  WORK_LANGUAGE:            "audio.work.language",
  WORK_DME_CLASSIFY:        "audio.work.dme_classify",
  EVENT_FILE_READY:         "audio.event.file.ready",
  EVENT_FORMAT_READY:       "audio.event.format.ready",
  EVENT_VAD_READY:          "audio.event.vad.ready",
  EVENT_LANGUAGE_READY:     "audio.event.language.ready",
  EVENT_DME_CLASSIFY_READY: "audio.event.dme_classify.ready",
  EVENT_JOB_DONE:           "audio.event.job.completed",
  EVENT_JOB_FAILED:         "audio.event.job.failed"
} as const;
