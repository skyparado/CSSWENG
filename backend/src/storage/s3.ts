import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { env } from '../env.js';

/**
 * S3-compatible client. Points at MinIO in local dev (S3_ENDPOINT set) and at
 * real S3 in production (endpoint unset → AWS default). Server-side encryption
 * is requested on every upload.
 */
export const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT || undefined,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials:
    env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? {
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        }
      : undefined,
});

/**
 * Ensure the configured bucket exists. Idempotent — safe to call at startup.
 * Needed for local dev (MinIO/s3mock start empty); in production the bucket is
 * usually provisioned by infrastructure and this is a cheap no-op.
 */
export async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
  } catch {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
    } catch {
      // Another process may have created it between the head and create.
    }
  }
}

export interface StoredObject {
  bucket: string;
  key: string;
  size: number;
  contentType: string;
}

/** Upload a buffer with server-side encryption (AES-256). */
export async function putObject(
  key: string,
  body: Buffer,
  contentType = 'application/pdf',
): Promise<StoredObject> {
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      ServerSideEncryption: 'AES256',
    }),
  );
  return { bucket: env.S3_BUCKET, key, size: body.byteLength, contentType };
}

/** Fetch an object body as a buffer. */
export async function getObject(key: string): Promise<Buffer> {
  const out = await s3.send(
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
  );
  const bytes = await out.Body!.transformToByteArray();
  return Buffer.from(bytes);
}
