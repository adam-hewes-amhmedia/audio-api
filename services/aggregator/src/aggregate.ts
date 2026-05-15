type StatusMap = Record<string, string>;

export function isComplete(requested: string[], statuses: StatusMap): boolean {
  return requested.every(a => statuses[a] === "completed" || statuses[a] === "failed");
}

export interface BuildReportArgs {
  job_id: string;
  input: { duration_s: number; size_bytes: number };
  perAnalysis: Record<string, any>;
  failures: any[];
}

export function buildReport(a: BuildReportArgs) {
  const out: any = { job_id: a.job_id, input: a.input, failures: a.failures };
  if (a.perAnalysis.format) {
    const f = a.perAnalysis.format;
    out.format = {
      codec: f.codec,
      sample_rate: f.sample_rate,
      bit_depth: f.bit_depth,
      channel_count: f.channel_count,
      channel_layout: f.channel_layout,
      channels: Array.from({ length: f.channel_count }, (_, i) => ({ index: i, label: `ch${i}` }))
    };
  }
  if (a.perAnalysis.vad) {
    out.vad = { per_channel: a.perAnalysis.vad.per_channel };
  }
  if (a.perAnalysis.language) {
    out.language = { per_channel: a.perAnalysis.language.per_channel };
  }
  if (a.perAnalysis.dme_classify) {
    out.dme_classify = { per_channel: a.perAnalysis.dme_classify.per_channel };
  }
  return out;
}
