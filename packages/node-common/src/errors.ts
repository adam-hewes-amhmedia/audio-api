import { ErrorCode, httpStatusFor } from "@audio-api/contracts";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode | string,
    message: string,
    public stage?: string,
    public traceId?: string
  ) { super(message); }

  toHttp() {
    return {
      status: httpStatusFor(this.code),
      body: { code: this.code, message: this.message, stage: this.stage, trace_id: this.traceId }
    };
  }
}
