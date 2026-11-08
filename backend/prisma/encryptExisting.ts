/**
 * One-off backfill: encrypt rows that were written as plaintext before the
 * `/// @encrypted` markers were added to these columns:
 *
 *   FollowUp.reason, OutreachLog.patientResponse,
 *   Medication.instructions, Medication.indication, Allergy.reaction
 *
 * Reads the raw column with $queryRaw (so nothing is decrypted or guessed at),
 * and re-saves any value that is not already ciphertext through the extended
 * Prisma client, which encrypts on write. Safe to re-run: ciphertext is skipped.
 *
 *   npm run db:encrypt-existing --workspace backend            # dry run
 *   npm run db:encrypt-existing --workspace backend -- --apply # write
 *
 * Needs DATABASE_URL and PRISMA_FIELD_ENCRYPTION_KEY (same key as the API).
 */
import 'dotenv/config';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma.js';

const CIPHERTEXT_PREFIX = 'v1.aesgcm256.';

const TARGETS = [
  { model: 'followUp', table: 'FollowUp', column: 'reason' },
  { model: 'outreachLog', table: 'OutreachLog', column: 'patientResponse' },
  { model: 'medication', table: 'Medication', column: 'instructions' },
  { model: 'medication', table: 'Medication', column: 'indication' },
  { model: 'allergy', table: 'Allergy', column: 'reaction' },
] as const;

async function main() {
  const apply = process.argv.includes('--apply');
  let total = 0;

  for (const { model, table, column } of TARGETS) {
    const rows = await prisma.$queryRaw<Array<{ id: string; value: string }>>(
      Prisma.sql`SELECT "id", ${Prisma.raw(`"${column}"`)} AS value
                 FROM ${Prisma.raw(`"${table}"`)}
                 WHERE ${Prisma.raw(`"${column}"`)} IS NOT NULL
                   AND ${Prisma.raw(`"${column}"`)} NOT LIKE ${CIPHERTEXT_PREFIX + '%'}`,
    );
    console.log(`${table}.${column}: ${rows.length} plaintext row(s)`);
    total += rows.length;
    if (!apply) continue;

    for (const row of rows) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any)[model].update({
        where: { id: row.id },
        data: { [column]: row.value },
      });
    }
  }

  console.log(
    apply ? `Encrypted ${total} value(s).` : `Dry run: ${total} value(s) would be encrypted. Re-run with --apply.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
