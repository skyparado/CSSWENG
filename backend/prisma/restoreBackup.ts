/**
 * Restoring from a nightly backup (SDD 8.6). It lists the backups in the backup
 * bucket, downloads one, decrypts it, and can restore it into a NEW, EMPTY
 * database and compare its row counts with the live database. It never writes
 * to the live database.
 *
 *   npm run db:restore-backup --workspace backend -- --list
 *
 * Restore into a fresh database in one step (creates it, restores, compares,
 * and with --cleanup drops the database it created afterwards):
 *
 *   npm run db:restore-backup --workspace backend -- --key db/2026-11-09/emr-....dump.enc --into clinic_restored --create
 *   npm run db:restore-backup --workspace backend -- --key db/... --into clinic_restored --create --cleanup
 *
 * Or only decrypt to a plain pg_dump file and run pg_restore yourself:
 *
 *   npm run db:restore-backup --workspace backend -- --key db/... --out restore.dump
 *
 * Stored files (images, scans, signed PDFs) are copied as they are under the
 * `files/` prefix of the same bucket; copy them back to the document bucket
 * with any S3 tool.
 *
 * Needs the same BACKUP_ENCRYPTION_KEY and BACKUP_S3_* settings as the API, and
 * the PostgreSQL client tools (pg_restore, psql) next to PG_DUMP_PATH or on the PATH.
 */
import 'dotenv/config';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { env } from '../src/env.js';
import { DB_PREFIX, createBackupClient, decryptBackup, loadBackupKey } from '../src/maintenance/backup.js';
import {
  assertSafeDatabaseName,
  compareCounts,
  createDatabase,
  dropDatabase,
  restoreDump,
  rowCounts,
  urlForDatabase,
} from '../src/maintenance/restore.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(name);

const USAGE = 'Usage: --list   or   --key <db/...dump.enc> --out <file>   or   --key <db/...dump.enc> --into <empty_db> [--create] [--cleanup]';

async function main() {
  const client = createBackupClient();

  if (flag('--list')) {
    const out = await client.send(new ListObjectsV2Command({ Bucket: env.BACKUP_S3_BUCKET, Prefix: DB_PREFIX }));
    const items = (out.Contents ?? []).sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0));
    if (items.length === 0) console.log('No database backups found.');
    for (const o of items) console.log(`${o.LastModified?.toISOString()}  ${String(o.Size).padStart(12)}  ${o.Key}`);
    return;
  }

  const key = arg('--key');
  const outFile = arg('--out');
  const into = arg('--into');
  if (!key || (!outFile && !into)) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const liveName = new URL(env.DATABASE_URL).pathname.replace(/^\//, '');
  if (into) {
    assertSafeDatabaseName(into);
    if (into === liveName) throw new Error(`Refusing to restore into the live database "${liveName}". Pick a new name.`);
  }

  const got = await client.send(new GetObjectCommand({ Bucket: env.BACKUP_S3_BUCKET, Key: key }));
  const encrypted = Buffer.from(await got.Body!.transformToByteArray());
  const plain = decryptBackup(encrypted, loadBackupKey()); // throws if the key is wrong or the file was altered
  console.log(`Decrypted ${encrypted.byteLength} encrypted bytes (${plain.byteLength} bytes of dump).`);

  if (outFile) {
    writeFileSync(outFile, plain);
    console.log(`Wrote ${outFile}.`);
    if (!into) {
      console.log(`Next: restore it into an empty database, or run again with --into <name> --create.`);
      return;
    }
  }

  const dumpFile = join(tmpdir(), `emr-restore-${process.pid}.dump`);
  writeFileSync(dumpFile, plain);
  const targetUrl = urlForDatabase(env.DATABASE_URL, into!);
  let created = false;
  try {
    if (flag('--create')) {
      await createDatabase(env.DATABASE_URL, into!);
      created = true;
      console.log(`Created empty database ${into}.`);
    }
    await restoreDump(dumpFile, targetUrl);
    console.log(`Restored the backup into ${into}.`);

    const [live, restored] = await Promise.all([rowCounts(env.DATABASE_URL), rowCounts(targetUrl)]);
    const width = Math.max(...Object.keys(restored).map((t) => t.length), 5);
    console.log(`\n${'Table'.padEnd(width)}  ${'Live'.padStart(8)}  ${'Restored'.padStart(8)}`);
    for (const t of Object.keys(restored)) {
      console.log(`${t.padEnd(width)}  ${String(live[t] ?? '-').padStart(8)}  ${String(restored[t]).padStart(8)}`);
    }
    const diffs = compareCounts(live, restored);
    console.log(
      diffs.length === 0
        ? `\nAll ${Object.keys(restored).length} tables match the live database.`
        : `\n${diffs.length} table(s) differ from the live database. Expected only if records were added after this backup was taken: ${diffs.map((d) => d.table).join(', ')}`,
    );
  } finally {
    rmSync(dumpFile, { force: true });
    // Only ever drop a database this run created, never one that was already there.
    if (flag('--cleanup') && created) {
      await dropDatabase(env.DATABASE_URL, into!);
      console.log(`Dropped ${into}.`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
