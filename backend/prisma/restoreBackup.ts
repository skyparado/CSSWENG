/**
 * Restoring from a nightly backup (SDD 8.6). This script does the part that
 * needs the encryption key: it lists the backups in the backup bucket, downloads
 * one and decrypts it to a plain pg_dump file. It never touches the live
 * database; you run pg_restore yourself, on purpose, as the last step.
 *
 *   npm run db:restore-backup --workspace backend -- --list
 *   npm run db:restore-backup --workspace backend -- --key db/2026-11-09/emr-....dump.enc --out restore.dump
 *
 * Then restore into an EMPTY database (a fresh one, to check the backup first):
 *
 *   createdb clinic_restored
 *   pg_restore --no-owner --dbname clinic_restored restore.dump
 *
 * Stored files (images, scans, signed PDFs) are copied as they are under the
 * `files/` prefix of the same bucket; copy them back to the document bucket
 * with any S3 tool.
 *
 * Needs the same BACKUP_ENCRYPTION_KEY and BACKUP_S3_* settings as the API.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { env } from '../src/env.js';
import { DB_PREFIX, createBackupClient, decryptBackup, loadBackupKey } from '../src/maintenance/backup.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const client = createBackupClient();

  if (process.argv.includes('--list')) {
    const out = await client.send(new ListObjectsV2Command({ Bucket: env.BACKUP_S3_BUCKET, Prefix: DB_PREFIX }));
    const items = (out.Contents ?? []).sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0));
    if (items.length === 0) console.log('No database backups found.');
    for (const o of items) console.log(`${o.LastModified?.toISOString()}  ${String(o.Size).padStart(12)}  ${o.Key}`);
    return;
  }

  const key = arg('--key');
  const outFile = arg('--out');
  if (!key || !outFile) {
    console.error('Usage: --list   or   --key <db/...dump.enc> --out <file>');
    process.exitCode = 2;
    return;
  }
  const got = await client.send(new GetObjectCommand({ Bucket: env.BACKUP_S3_BUCKET, Key: key }));
  const encrypted = Buffer.from(await got.Body!.transformToByteArray());
  const plain = decryptBackup(encrypted, loadBackupKey()); // throws if the key is wrong or the file was altered
  writeFileSync(outFile, plain);
  console.log(`Decrypted ${encrypted.byteLength} bytes to ${outFile}.`);
  console.log(`Next: createdb clinic_restored && pg_restore --no-owner --dbname clinic_restored ${outFile}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
