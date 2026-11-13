import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../prisma.js', () => ({ prisma: {} }));
vi.mock('../storage/s3.js', () => ({
  s3: { send: vi.fn().mockResolvedValue({ Contents: [], IsTruncated: false }) },
  deleteObject: vi.fn(),
  putObject: vi.fn(),
}));

import {
  decryptBackup,
  encryptBackup,
  expiredBackups,
  loadBackupKey,
  pgDumpInvocation,
  runBackup,
} from './backup.js';
import { yearsAgo } from './purge.js';
import { handleMaintenanceJob } from './queue.js';

const key = randomBytes(32);

describe('backup encryption', () => {
  it('round-trips and does not leak the plaintext', () => {
    const plain = Buffer.from('PGDMP patient data: Juan Dela Cruz, glaucoma');
    const blob = encryptBackup(plain, key);

    expect(blob.includes(Buffer.from('Juan'))).toBe(false);
    expect(blob.subarray(0, 6).toString()).toBe('EMRBK1');
    expect(decryptBackup(blob, key).equals(plain)).toBe(true);
  });

  it('uses a fresh IV each time', () => {
    const a = encryptBackup(Buffer.from('same'), key);
    const b = encryptBackup(Buffer.from('same'), key);
    expect(a.equals(b)).toBe(false);
  });

  it('refuses a wrong key, a changed byte, a truncated file and a foreign file', () => {
    const blob = encryptBackup(Buffer.from('important'), key);

    expect(() => decryptBackup(blob, randomBytes(32))).toThrow();
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 20] ^= 0xff;
    expect(() => decryptBackup(tampered, key)).toThrow();
    expect(() => decryptBackup(blob.subarray(0, 10), key)).toThrow(/Not an encrypted EMR backup/);
    expect(() => decryptBackup(Buffer.from('plain text file of reasonable length here'), key)).toThrow(/Not an encrypted/);
  });
});

describe('backup key', () => {
  it('is required, and must be 32 bytes', () => {
    expect(() => loadBackupKey(undefined)).toThrow(/not set/);
    expect(() => loadBackupKey(Buffer.from('short').toString('base64'))).toThrow(/32 bytes/);
    expect(loadBackupKey(key.toString('base64')).equals(key)).toBe(true);
  });
});

describe('pg_dump invocation', () => {
  it('keeps the password out of the process arguments and drops the ?schema= suffix', () => {
    const { args, env } = pgDumpInvocation('postgresql://clinic:s3cr%40t@db.internal:5433/clinic?schema=public');
    expect(args.join(' ')).not.toContain('s3cr');
    expect(env.PGPASSWORD).toBe('s3cr@t');
    expect(args).toEqual(expect.arrayContaining(['--host', 'db.internal', '--port', '5433', '--username', 'clinic', '--dbname', 'clinic']));
    expect(args).toContain('--format=custom');
  });
});

describe('runBackup', () => {
  it('writes an encrypted dump to the backup bucket, never the plaintext', async () => {
    const send = vi.fn().mockResolvedValue({ Contents: [], IsTruncated: false });
    const dump = Buffer.from('PGDMP-binary-dump-of-patient-records');

    const result = await runBackup({
      dump: async () => dump,
      client: { send } as never,
      key,
      now: () => new Date('2026-11-09T02:00:00Z'),
    });

    const put = send.mock.calls.map((c) => c[0]).find((cmd) => cmd.constructor.name === 'PutObjectCommand');
    expect(put.input.Key).toBe('db/2026-11-09/emr-2026-11-09T02-00-00-000Z.dump.enc');
    expect(put.input.Bucket).toBe('clinic-backups');
    expect(put.input.ServerSideEncryption).toBe('AES256');
    expect((put.input.Body as Buffer).includes(Buffer.from('patient-records'))).toBe(false);
    expect(decryptBackup(put.input.Body as Buffer, key).equals(dump)).toBe(true);
    expect(result).toMatchObject({ databaseKey: put.input.Key, filesCopied: 0 });
  });

  it('refuses an empty dump rather than backing up nothing', async () => {
    await expect(
      runBackup({ dump: async () => Buffer.alloc(0), client: { send: vi.fn() } as never, key }),
    ).rejects.toThrow(/empty/);
  });
});

describe('expiredBackups', () => {
  const day = (n: number) => new Date(Date.UTC(2026, 10, 9) - n * 86_400_000);
  const now = new Date('2026-11-09T12:00:00Z');

  it('selects only backups older than the retention period', () => {
    const objects = [
      { Key: 'db/a', LastModified: day(0) },
      { Key: 'db/b', LastModified: day(29) },
      { Key: 'db/c', LastModified: day(31) },
      { Key: 'db/d', LastModified: day(60) },
    ];
    expect(expiredBackups(objects, now, 30).sort()).toEqual(['db/c', 'db/d']);
  });

  it('never selects the newest backup, even if everything is old', () => {
    const objects = [
      { Key: 'db/old1', LastModified: day(90) },
      { Key: 'db/old2', LastModified: day(100) },
    ];
    expect(expiredBackups(objects, now, 30)).toEqual(['db/old2']);
    expect(expiredBackups([{ Key: 'db/only', LastModified: day(500) }], now, 30)).toEqual([]);
  });
});

describe('yearsAgo', () => {
  it('moves back whole calendar years', () => {
    expect(yearsAgo(new Date('2026-11-09T00:00:00Z'), 5).toISOString()).toBe('2021-11-09T00:00:00.000Z');
  });
});

describe('maintenance job routing', () => {
  it('rejects an unknown job', async () => {
    await expect(handleMaintenanceJob({ name: 'nope' })).rejects.toThrow(/Unknown maintenance job/);
  });
});
