import { spawn } from 'node:child_process';
import { basename, dirname, extname, join } from 'node:path';
import { env } from '../env.js';
import { pgDumpInvocation } from './backup.js';

/**
 * Restoring a decrypted backup into an EMPTY database (SDD 8.6), driven by the
 * PostgreSQL command-line tools so it works the same on a laptop and in the
 * container: psql to create, check and count, pg_restore to load the dump.
 * It never writes to the live database: the target must be a different,
 * empty database.
 */

/**
 * Path of a PostgreSQL tool. An explicit setting wins; otherwise it sits next to
 * PG_DUMP_PATH (so on Windows, setting PG_DUMP_PATH to ...\bin\pg_dump.exe is
 * enough), or is found on the PATH.
 */
export function pgToolPath(
  tool: 'pg_restore' | 'psql',
  dumpPath = env.PG_DUMP_PATH,
  explicit = tool === 'pg_restore' ? env.PG_RESTORE_PATH : env.PSQL_PATH,
): string {
  if (explicit) return explicit;
  if (basename(dumpPath) === dumpPath) return tool; // a bare "pg_dump": use the PATH
  return join(dirname(dumpPath), tool + extname(dumpPath));
}

/** The same connection URL pointed at another database on the same server. */
export function urlForDatabase(databaseUrl: string, database: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  url.search = ''; // drop ?schema=public and other Prisma-only options
  return url.toString();
}

/** Database names we create or restore into: plain identifiers only, never quoted input. */
export function assertSafeDatabaseName(name: string): void {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`Database name "${name}" must be lowercase letters, digits and underscores`);
  }
}

function spawnTool(command: string, args: string[], databaseUrl: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { env: pgEnv } = pgDumpInvocation(databaseUrl); // PGPASSWORD, kept out of the arguments
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...pgEnv } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => reject(new Error(`Could not run ${command}: ${e.message}`)));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
  });
}

async function run(command: string, args: string[], databaseUrl: string): Promise<string> {
  const r = await spawnTool(command, args, databaseUrl);
  if (r.code !== 0) throw new Error(`${basename(command)} exited with ${r.code}: ${r.stderr.slice(0, 500)}`);
  return r.stdout;
}

/**
 * pg_restore errors that do not affect the restored data. A dump made by a newer
 * pg_dump (e.g. 18 on a Windows laptop) sets parameters an older server (16)
 * does not know, such as transaction_timeout; pg_restore reports that as an
 * error and carries on.
 */
const HARMLESS_RESTORE_ERROR = /unrecognized configuration parameter "transaction_timeout"/;

/** True when every error pg_restore reported is a harmless one. Exported for tests. */
export function onlyHarmlessRestoreErrors(stderr: string): boolean {
  const errors = stderr.split(/\r?\n/).filter((l) => /error:/i.test(l) && !/errors ignored on restore/i.test(l));
  return errors.length > 0 && errors.every((l) => HARMLESS_RESTORE_ERROR.test(l));
}

/** Connection arguments for psql / pg_restore, without the password. */
function connectionArgs(databaseUrl: string): string[] {
  return pgDumpInvocation(databaseUrl).args.filter((a) => a !== '--format=custom' && a !== '--no-owner');
}

/** Run one SQL statement with psql and return its unaligned, tuples-only output. */
export function psql(databaseUrl: string, sql: string): Promise<string> {
  return run(pgToolPath('psql'), [...connectionArgs(databaseUrl), '--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', sql], databaseUrl);
}

export async function createDatabase(serverUrl: string, name: string): Promise<void> {
  assertSafeDatabaseName(name);
  await psql(serverUrl, `CREATE DATABASE ${name}`);
}

export async function dropDatabase(serverUrl: string, name: string): Promise<void> {
  assertSafeDatabaseName(name);
  await psql(serverUrl, `DROP DATABASE IF EXISTS ${name}`);
}

/** Number of tables in the public schema: 0 means empty. */
export async function countTables(databaseUrl: string): Promise<number> {
  const out = await psql(databaseUrl, `SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'`);
  return Number(out.trim());
}

/** Exact row count of every table in the public schema, by table name. */
export async function rowCounts(databaseUrl: string): Promise<Record<string, number>> {
  const out = await psql(
    databaseUrl,
    `SELECT table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  const counts: Record<string, number> = {};
  for (const line of out.split(/\r?\n/)) {
    const [table, n] = line.split('|');
    if (table && n !== undefined) counts[table] = Number(n);
  }
  return counts;
}

/** Load a plain pg_dump file (custom format) into an existing, empty database. */
export async function restoreDump(dumpFile: string, targetUrl: string): Promise<void> {
  if ((await countTables(targetUrl)) > 0) {
    throw new Error('The target database is not empty. Restore only into a new, empty database.');
  }
  const r = await spawnTool(pgToolPath('pg_restore'), [...connectionArgs(targetUrl), '--no-owner', dumpFile], targetUrl);
  if (r.code !== 0 && !onlyHarmlessRestoreErrors(r.stderr)) {
    throw new Error(`pg_restore exited with ${r.code}: ${r.stderr.slice(0, 500)}`);
  }
}

export interface CountDifference {
  table: string;
  source: number | undefined;
  restored: number | undefined;
}

/** Tables whose row counts differ between the two databases (empty when they match). */
export function compareCounts(source: Record<string, number>, restored: Record<string, number>): CountDifference[] {
  const tables = [...new Set([...Object.keys(source), ...Object.keys(restored)])].sort();
  return tables
    .filter((t) => source[t] !== restored[t])
    .map((table) => ({ table, source: source[table], restored: restored[table] }));
}
