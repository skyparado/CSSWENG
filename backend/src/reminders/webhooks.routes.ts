import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import type { DeliveryStatus } from '@prisma/client';
import { z } from 'zod';
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { asyncHandler, HttpError } from '../http.js';
import { recordDeliveryReport } from '../followups/outreach.service.js';

/**
 * Delivery reports from the SMS provider ("delivered" or "failed"). Providers
 * are not signed in users, so these routes sit outside the session and prove
 * the caller another way: Twilio's request signature, or a shared secret for
 * any other provider. The only thing a report can change is the delivery status
 * of one outreach row and of its send record (Database Design 1.5).
 */
export const smsWebhooksRouter = Router();

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Apply a provider report to the outreach row and the reminder send record. Returns rows updated. */
export async function applyDeliveryReport(providerMessageId: string, status: DeliveryStatus): Promise<number> {
  const rows = await recordDeliveryReport(providerMessageId, status);
  await prisma.reminderDelivery.updateMany({ where: { providerMessageId }, data: { deliveryStatus: status } });
  return rows;
}

/**
 * Twilio signs each callback: base64(HMAC-SHA1(authToken, url + each POST
 * parameter name and value, sorted by name)). `url` must be the public URL
 * Twilio was given, which is why PUBLIC_BASE_URL has to be set.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return createHmac('sha1', authToken).update(data).digest('base64');
}

const TWILIO_STATUS: Record<string, DeliveryStatus | undefined> = {
  delivered: 'DELIVERED',
  undelivered: 'FAILED',
  failed: 'FAILED',
  // queued, accepted, sending, sent, read: not final, nothing to record yet
};

smsWebhooksRouter.post(
  '/twilio',
  express.urlencoded({ extended: false }),
  asyncHandler(async (req, res) => {
    if (!env.TWILIO_AUTH_TOKEN || !env.PUBLIC_BASE_URL) throw new HttpError(404, 'Not found');
    const params = req.body as Record<string, string>;
    const expected = twilioSignature(
      env.TWILIO_AUTH_TOKEN,
      `${env.PUBLIC_BASE_URL}/api/webhooks/sms/twilio`,
      params,
    );
    if (!safeEqual(req.get('x-twilio-signature') ?? '', expected)) throw new HttpError(403, 'Invalid signature');

    const status = TWILIO_STATUS[(params.MessageStatus ?? '').toLowerCase()];
    if (status && params.MessageSid) await applyDeliveryReport(params.MessageSid, status);
    res.status(204).end();
  }),
);

const genericReportSchema = z.object({
  providerMessageId: z.string().min(1).max(200),
  status: z.enum(['DELIVERED', 'FAILED']),
});

/** POST /api/webhooks/sms/generic?secret=... { providerMessageId, status } — for any provider that can call a URL. */
smsWebhooksRouter.post(
  '/generic',
  asyncHandler(async (req, res) => {
    if (!env.SMS_WEBHOOK_SECRET) throw new HttpError(404, 'Not found');
    const given = (req.query.secret as string | undefined) ?? req.get('x-webhook-secret') ?? '';
    if (!safeEqual(given, env.SMS_WEBHOOK_SECRET)) throw new HttpError(403, 'Invalid secret');

    const report = genericReportSchema.parse(req.body);
    const updated = await applyDeliveryReport(report.providerMessageId, report.status);
    res.json({ updated });
  }),
);
