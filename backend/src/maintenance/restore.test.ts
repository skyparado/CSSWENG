import { describe, expect, it } from 'vitest';
import { assertSafeDatabaseName, compareCounts, onlyHarmlessRestoreErrors, pgToolPath, urlForDatabase } from './restore.js';

describe('restore helpers', () => {
  it('finds pg_restore and psql next to PG_DUMP_PATH, or on the PATH', () => {
     // '' = no PG_RESTORE_PATH / PSQL_PATH set, so the test does not depend on the local .env.
    expect(pgToolPath('pg_restore', 'pg_dump', '')).toBe('pg_restore');
    expect(pgToolPath('psql', '/usr/lib/postgresql/16/bin/pg_dump', '')).toMatch(/16[\\/]bin[\\/]psql$/);
    // Windows install: same folder, same .exe extension (path.join uses this OS's separator).
    expect(pgToolPath('pg_restore', 'C:/Program Files/PostgreSQL/18/bin/pg_dump.exe', '')).toMatch(/18[\\/]bin[\\/]pg_restore\.exe$/);
    // An explicit PG_RESTORE_PATH / PSQL_PATH always wins.
    expect(pgToolPath('pg_restore', 'pg_dump', 'D:/pg/pg_restore.exe')).toBe('D:/pg/pg_restore.exe');
  });

  it('points the connection URL at another database and drops Prisma-only options', () => {
    expect(urlForDatabase('postgresql://clinic:clinic@localhost:5432/clinic?schema=public', 'clinic_restored')).toBe(
      'postgresql://clinic:clinic@localhost:5432/clinic_restored',
    );
  });

  it('accepts only plain database names, so nothing can be injected into CREATE or DROP', () => {
    expect(() => assertSafeDatabaseName('clinic_restored')).not.toThrow();
    for (const bad of ['Clinic', 'clinic-restored', 'x; DROP DATABASE clinic', '', '1abc']) {
      expect(() => assertSafeDatabaseName(bad)).toThrow(/lowercase/);
    }
  });

  it('lists only the tables whose counts differ', () => {
    expect(compareCounts({ Patient: 3, Clinic: 3 }, { Patient: 3, Clinic: 3 })).toEqual([]);
    expect(compareCounts({ Patient: 4, Clinic: 3 }, { Patient: 3, Clinic: 3, Extra: 1 })).toEqual([
      { table: 'Extra', source: undefined, restored: 1 },
      { table: 'Patient', source: 4, restored: 3 },
    ]);
  });

  it('tolerates only the transaction_timeout error a newer pg_dump causes on an older server', () => {
    const versionNoise = [
      'pg_restore: error: could not execute query: ERROR:  unrecognized configuration parameter "transaction_timeout"',
      'Command was: SET transaction_timeout = 0;',
      'pg_restore: warning: errors ignored on restore: 1',
    ].join('\n');
    expect(onlyHarmlessRestoreErrors(versionNoise)).toBe(true);
    expect(onlyHarmlessRestoreErrors(`${versionNoise}\npg_restore: error: could not execute query: ERROR:  relation "Patient" already exists`)).toBe(false);
    expect(onlyHarmlessRestoreErrors('pg_restore: error: connection to server failed')).toBe(false);
    expect(onlyHarmlessRestoreErrors('')).toBe(false);
  });
});
