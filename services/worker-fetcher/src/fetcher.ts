import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { ApiError, BUCKET } from "@audio-api/node-common";

export interface FetchArgs {
  url: string;
  jobId: string;
  s3: S3Client;
  fetchImpl?: typeof fetch;
}

export interface FetchResult {
  object_key: string;
  size_bytes: number;
  sha256: string;
}

export async function fetchToObjectStore(args: FetchArgs): Promise<FetchResult> {
  const f = args.fetchImpl ?? fetch;
  const res = await f(args.url);
  if (!res.ok) throw new ApiError("INPUT_UNREACHABLE", `INPUT_UNREACHABLE: fetch failed ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash("sha256").update(buf).digest("hex");
  const key = `working/${args.jobId}/source.bin`;
  await args.s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf }));
  return { object_key: key, size_bytes: buf.length, sha256: sha };
}
