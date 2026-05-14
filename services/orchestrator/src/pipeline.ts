export interface JobAnalyses { analyses: string[]; }

export function nextStepsAfterFileReady(_job: JobAnalyses): string[] {
  return ["format"];
}

export function nextStepsAfterFormatReady(job: JobAnalyses): string[] {
  // Plan 1: format is the only analysis. Future plans: fan-out vad/language/dme_classify here.
  return job.analyses.filter(a => a !== "format" && ["vad", "language", "dme_classify"].includes(a));
}
