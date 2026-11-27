import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { startReminderWorker, stopReminderWorker } from '../reminders/worker.js';
import { startExportWorker, stopExportWorker } from '../reports/exports.queue.js';
import { startMaintenanceWorker, stopMaintenanceWorker } from './queue.js';
import { verifyBackupTools } from './backup.js';

async function main() {
  verifyBackupTools();
  await startExportWorker();
  await startMaintenanceWorker();
  if (env.REMINDERS_ENABLED) await startReminderWorker();
  const stop = async () => {
    await Promise.all([stopMaintenanceWorker(), stopExportWorker(), stopReminderWorker()]);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch(() => { console.error('Worker startup failed. Check database, Redis, backup settings and PostgreSQL client binaries.'); process.exit(1); });
