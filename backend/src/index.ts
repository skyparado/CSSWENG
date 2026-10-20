import { createApp } from './app.js';
import { env } from './env.js';
import { prisma } from './prisma.js';
import { shutdown, warmUp } from './documents/pdf.service.js';
import { ensureBucket } from './storage/s3.js';

async function main() {
  const app = createApp();

  // Start the warm Puppeteer instance so the first PDF render is fast.
  warmUp().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Puppeteer warm-up failed (PDF rendering will retry lazily):', err);
  });

  // Ensure the document storage bucket exists (local dev starts empty).
  ensureBucket().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Could not ensure S3 bucket (will retry on first upload):', err);
  });

  const server = app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });

  const stop = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`\n${signal} received, shutting down…`);
    server.close();
    await shutdown();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
