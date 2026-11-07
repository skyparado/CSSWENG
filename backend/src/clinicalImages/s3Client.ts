import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env.js';

/**
 * S3 (or MinIO) client wired from env. Kept at module scope so route handlers
 * reuse one HTTPS agent across requests. Tests substitute this with a mock
 * via vi.mock.
 */
let client: S3Client | undefined;

function getClient(): S3Client {
  if (!client) {
    // Credentials are optional in env (local dev may omit them, prod sets them
    // from the real environment). Only attach them when BOTH are present so
    // the SDK falls back to its default credential chain otherwise.
    const credentials =
      env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          }
        : undefined;

    client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      credentials,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
  }
  return client;
}

/**
 * Upload a byte buffer to S3 under `key` with server-side encryption
 * (SSE-S3 / AES256). This is the primary at-rest protection for clinical
 * image bytes; the field-encryption PR covers sensitive DB columns separately.
 */
export async function putObjectEncrypted(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await getClient().send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      ServerSideEncryption: 'AES256',
    }),
  );
}

export async function getObject(key: string): Promise<Buffer> {
  const res = await getClient().send(
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
  );
  if (!res.Body) throw new Error(`Empty body for S3 object ${key}`);
  const chunks: Uint8Array[] = [];
  // @ts-expect-error AWS stream types don't include asyncIterator but the Node stream does.
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function deleteObject(key: string): Promise<void> {
  await getClient().send(
    new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
  );
}

/**
 * Short-lived (5-minute) presigned GET URL. Used by the Doctor's browser to
 * download or display the image without the backend having to proxy bytes.
 */
export async function presignedGetUrl(
  key: string,
  expiresInSeconds = 300,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
  });
  return getSignedUrl(getClient(), command, { expiresIn: expiresInSeconds });
}