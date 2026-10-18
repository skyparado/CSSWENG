import puppeteer, { type Browser } from 'puppeteer';
import { env } from '../env.js';

/**
 * Warm Puppeteer instance.
 *
 * A single headless Chromium is launched once and kept running, so each render
 * only opens/closes a page — meeting the 5-second PDF target (SRS §3.5). Call
 * `warmUp()` at server start and `shutdown()` on exit.
 */
let browserPromise: Promise<Browser> | null = null;

async function launch(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    executablePath: env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

/** Start (or reuse) the warm browser. Safe to call multiple times. */
export async function warmUp(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launch();
  }
  return browserPromise;
}

async function getBrowser(): Promise<Browser> {
  const browser = await warmUp();
  // If Chromium died, relaunch transparently.
  if (!browser.connected) {
    browserPromise = launch();
    return browserPromise;
  }
  return browser;
}

/** Render an HTML string to a PDF buffer (A4). */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}

/** Close the warm browser (call on process shutdown). */
export async function shutdown(): Promise<void> {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    browserPromise = null;
    if (browser) await browser.close().catch(() => undefined);
  }
}
