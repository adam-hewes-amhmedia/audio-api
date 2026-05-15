export interface JobAnalyses { analyses: string[]; }

const FANOUT_AFTER_FORMAT = new Set(["vad", "language", "dme_classify"]);

export function nextStepsAfterFileReady(_job: JobAnalyses): string[] {
  return ["format"];
}

export function nextStepsAfterFormatReady(job: JobAnalyses): string[] {
  return job.analyses.filter(a => FANOUT_AFTER_FORMAT.has(a));
}
