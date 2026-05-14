import { ulid } from "ulid";
export const jobId    = () => `j_${ulid()}`;
export const tokenId  = () => `t_${ulid()}`;
export const traceId  = () => Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32);
export const attemptId = (jobId: string, stage: string) => `${jobId}:${stage}:1`;
