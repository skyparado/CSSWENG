import { prisma } from '../prisma.js';
import { printSummary, seedDemo } from './seedDemo.js';

/**
 * Entry point for the demo seed.
 *
 *   npm run db:seed:demo --workspace backend
 *       Loads the demo data. In production it also needs DEMO_SEED=true, so it
 *       can never run by accident on a live clinic's database.
 *
 *   node dist/demo/cli.js --if-enabled
 *       Used at container start. Does nothing unless DEMO_SEED=true, and does
 *       nothing if the demo data is already there, so it is safe on every restart.
 */
const ifEnabled = process.argv.includes('--if-enabled');
const enabled = process.env.DEMO_SEED === 'true';

async function main() {
  if (ifEnabled && !enabled) return;
  if (process.env.NODE_ENV === 'production' && !enabled) {
    console.error('Refusing to load demo data in production unless DEMO_SEED=true is set.');
    process.exit(1);
  }

  const result = await seedDemo();
  if (result === 'already-seeded') {
    console.log('Demo data is already loaded. Nothing to do. (To start over, rebuild the database: scripts/rebuild-demo-db.sh)');
    return;
  }
  printSummary(result);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
