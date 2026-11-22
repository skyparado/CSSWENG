import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../src/env.js';
import { DB_PREFIX, createBackupClient, decryptBackup, loadBackupKey, listAll, restoreFiles } from '../src/maintenance/backup.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const client = createBackupClient();

  if (process.argv.includes('--list')) {
    const items = (await listAll(client, env.BACKUP_S3_BUCKET, DB_PREFIX)).sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0));
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
  writeFileSync(outFile, plain, { flag: 'wx', mode: 0o600 });
  const files = arg('--files-to');
  if (files) {
    const root = resolve(files);
    await mkdir(root, { mode: 0o700 }); // must be a new directory
    await restoreFiles(client, key, loadBackupKey(), async (file, bytes) => {
      const path = resolve(root, file.key);
      if (!path.startsWith(root + sep)) throw new Error('Invalid file path in manifest');
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    });
  }
  console.log(`Decrypted ${encrypted.byteLength} bytes to ${outFile}.`);
  console.log(`Next: createdb clinic_restored && pg_restore --no-owner --dbname clinic_restored ${outFile}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
