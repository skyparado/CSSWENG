import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type _Object,
} from '@aws-sdk/client-s3';
import { env } from '../env.js';
import { s3 as sourceS3 } from '../storage/s3.js';

/** First bytes of every encrypted backup: format name and version. */
const MAGIC = Buffer.from('EMRBK1');
const IV_LEN = 12;
const TAG_LEN = 16;

export const DB_PREFIX = 'db/';
export const FILES_PREFIX = 'files/';

/** Backup key from BACKUP_ENCRYPTION_KEY: 32 random bytes, base64. Throws with a clear message if unusable. */
export function loadBackupKey(raw: string | undefined = env.BACKUP_ENCRYPTION_KEY): Buffer {
  if (!raw) throw new Error('BACKUP_ENCRYPTION_KEY is not set; backups are not taken without encryption');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return key;
}

/** AES-256-GCM. Layout: MAGIC | iv (12) | ciphertext | auth tag (16). */
export function encryptBackup(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
}

/** Reverse of encryptBackup. Throws if the key is wrong or a single byte was changed. */
export function decryptBackup(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < MAGIC.length + IV_LEN + TAG_LEN || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Not an encrypted EMR backup');
  }
  const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const body = blob.subarray(MAGIC.length + IV_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** The separate backup location. BACKUP_S3_* values fall back to the main S3_* settings. */
export function createBackupClient(): S3Client {
  const accessKeyId = env.BACKUP_S3_ACCESS_KEY_ID ?? env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.BACKUP_S3_SECRET_ACCESS_KEY ?? env.S3_SECRET_ACCESS_KEY;
  return new S3Client({
    region: env.BACKUP_S3_REGION ?? env.S3_REGION,
    endpoint: env.BACKUP_S3_ENDPOINT ?? (env.S3_ENDPOINT || undefined),
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
  });
}

/** pg_dump connection arguments from DATABASE_URL, with the password kept out of the process arguments. */
export function pgDumpInvocation(databaseUrl: string): { args: string[]; env: Record<string, string> } {
  const url = new URL(databaseUrl);
  return {
    args: [
      '--format=custom', // compressed, restorable with pg_restore
      '--no-owner',
      '--host', url.hostname,
      '--port', url.port || '5432',
      '--username', decodeURIComponent(url.username),
      '--dbname', url.pathname.replace(/^\//, ''),
    ],
    env: url.password ? { PGPASSWORD: decodeURIComponent(url.password) } : {},
  };
}

/** Dump the whole database with pg_dump and return the bytes. */
export function dumpDatabase(): Promise<Buffer> {
  const { args, env: pgEnv } = pgDumpInvocation(env.DATABASE_URL);
  return new Promise((resolve, reject) => {
    const child = spawn(env.PG_DUMP_PATH, args, { env: { ...process.env, ...pgEnv } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => reject(new Error(`Could not run ${env.PG_DUMP_PATH}: ${e.message}`)));
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`pg_dump exited with ${code}: ${Buffer.concat(err).toString().slice(0, 500)}`)),
    );
  });
}

export interface BackupDeps {
  dump: () => Promise<Buffer>;
  client: S3Client;
  key: Buffer;
  now: () => Date;
}

async function listAll(client: S3Client, bucket: string, prefix: string): Promise<_Object[]> {
  const found: _Object[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    found.push(...(page.Contents ?? []));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return found;
}

export interface BackupResult {
  databaseKey: string;
  databaseBytes: number;
  filesCopied: number;
  filesTotal: number;
}

/**
 * One backup run: dump the database, encrypt it and write it to the backup
 * location, then copy any stored files (images, scans, signed PDFs) that are not
 * there yet. Report exports are temporary and are not backed up.
 */
export async function runBackup(deps?: Partial<BackupDeps>): Promise<BackupResult> {
  // Defaults are built lazily so that a missing key fails clearly, and an injected one is not overridden.
  const d: BackupDeps = {
    dump: deps?.dump ?? dumpDatabase,
    client: deps?.client ?? createBackupClient(),
    key: deps?.key ?? loadBackupKey(),
    now: deps?.now ?? (() => new Date()),
  };
  const stamp = d.now().toISOString();
  const databaseKey = `${DB_PREFIX}${stamp.slice(0, 10)}/emr-${stamp.replace(/[:.]/g, '-')}.dump.enc`;

  const dump = await d.dump();
  if (dump.byteLength === 0) throw new Error('pg_dump produced an empty file');
  const encrypted = encryptBackup(dump, d.key);
  await d.client.send(
    new PutObjectCommand({
      Bucket: env.BACKUP_S3_BUCKET,
      Key: databaseKey,
      Body: encrypted,
      ContentType: 'application/octet-stream',
      ServerSideEncryption: 'AES256',
    }),
  );

  const source = (await listAll(sourceS3, env.S3_BUCKET, '')).filter((o) => o.Key && !o.Key.startsWith('exports/'));
  const already = new Set((await listAll(d.client, env.BACKUP_S3_BUCKET, FILES_PREFIX)).map((o) => o.Key));
  let filesCopied = 0;
  for (const obj of source) {
    const target = `${FILES_PREFIX}${obj.Key}`;
    if (already.has(target)) continue;
    const got = await sourceS3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: obj.Key }));
    await d.client.send(
      new PutObjectCommand({
        Bucket: env.BACKUP_S3_BUCKET,
        Key: target,
        Body: Buffer.from(await got.Body!.transformToByteArray()),
        ContentType: got.ContentType,
        ServerSideEncryption: 'AES256',
      }),
    );
    filesCopied += 1;
  }
  return { databaseKey, databaseBytes: encrypted.byteLength, filesCopied, filesTotal: source.length };
}

/**
 * Which database backups are past retention. The newest backup is never
 * returned, so a retention bug or a long outage can never delete the last copy.
 */
export function expiredBackups(
  objects: Array<{ Key?: string; LastModified?: Date }>,
  now: Date,
  retentionDays: number,
): string[] {
  const dated = objects
    .filter((o): o is { Key: string; LastModified: Date } => Boolean(o.Key && o.LastModified))
    .sort((a, b) => b.LastModified.getTime() - a.LastModified.getTime());
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  return dated.slice(1).filter((o) => o.LastModified.getTime() < cutoff).map((o) => o.Key);
}

/** Delete database backups older than BACKUP_RETENTION_DAYS (never the newest). Returns the keys removed. */
export async function purgeOldBackups(
  client: S3Client = createBackupClient(),
  now: Date = new Date(),
  retentionDays: number = env.BACKUP_RETENTION_DAYS,
): Promise<string[]> {
  const expired = expiredBackups(await listAll(client, env.BACKUP_S3_BUCKET, DB_PREFIX), now, retentionDays);
  for (const Key of expired) {
    await client.send(new DeleteObjectCommand({ Bucket: env.BACKUP_S3_BUCKET, Key }));
  }
  return expired;
}
