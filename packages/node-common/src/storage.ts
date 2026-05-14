import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

export function createStorage(): S3Client {
  return new S3Client({
    endpoint: process.env.OBJECT_STORE_ENDPOINT,
    region: process.env.OBJECT_STORE_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: process.env.OBJECT_STORE_ACCESS_KEY!,
      secretAccessKey: process.env.OBJECT_STORE_SECRET_KEY!
    },
    forcePathStyle: true
  });
}

export const BUCKET = process.env.OBJECT_STORE_BUCKET ?? "audio-api";

export async function putObject(s3: S3Client, key: string, body: Buffer | Readable, contentType?: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
}

export async function getObjectStream(s3: S3Client, key: string): Promise<Readable> {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return r.Body as Readable;
}
