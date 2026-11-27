import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../env.js';
import { decryptBackup, dumpDatabase, encryptBackup } from './backup.js';
import { countTables, createDatabase, dropDatabase, psql, restoreDump, rowCounts, urlForDatabase } from './restore.js';

/**
 * Integration test (real Postgres and the PostgreSQL client tools) for the full
 * backup round trip (SDD 8.6): pg_dump the test database, encrypt, decrypt,
 * pg_restore into a new empty database, and compare every table's row count.
 * Needs pg_dump, pg_restore and psql (PG_DUMP_PATH, or on the PATH).
 */
const target = `clinic_roundtrip_${process.pid}`;
const targetUrl = urlForDatabase(env.DATABASE_URL, target);
const marker = `roundtrip-${randomBytes(4).toString('hex')}`;
const dumpFile = join(tmpdir(), `${target}.dump`);

beforeAll(async () => {
  // One known row, so the comparison is not just 0 = 0.
  await psql(env.DATABASE_URL, `INSERT INTO "Clinic" (id, name, "updatedAt") VALUES ('${marker}', 'Round-trip test clinic', now())`);
  await dropDatabase(env.DATABASE_URL, target);
}, 60_000);

afterAll(async () => {
  rmSync(dumpFile, { force: true });
  await dropDatabase(env.DATABASE_URL, target).catch(() => undefined);
  await psql(env.DATABASE_URL, `DELETE FROM "Clinic" WHERE id = '${marker}'`).catch(() => undefined);
}, 60_000);

describe('backup round trip (real database)', () => {
  it('dumps, encrypts, decrypts and restores into an empty database with the same row counts', async () => {
    const key = randomBytes(32);
    const dump = await dumpDatabase();
    const encrypted = encryptBackup(dump, key);
    expect(encrypted.includes(Buffer.from('Round-trip test clinic'))).toBe(false); // nothing readable at rest

    writeFileSync(dumpFile, decryptBackup(encrypted, key));
    await createDatabase(env.DATABASE_URL, target);
    expect(await countTables(targetUrl)).toBe(0);

    await restoreDump(dumpFile, targetUrl);

    const [source, restored] = await Promise.all([rowCounts(env.DATABASE_URL), rowCounts(targetUrl)]);
    expect(Object.keys(restored).length).toBeGreaterThan(10);
    expect(restored).toEqual(source);
    expect((await psql(targetUrl, `SELECT name FROM "Clinic" WHERE id = '${marker}'`)).trim()).toBe('Round-trip test clinic');
  }, 120_000);

  it('refuses to restore over a database that already has tables', async () => {
    await expect(restoreDump(dumpFile, targetUrl)).rejects.toThrow(/not empty/);
  }, 60_000);
});
