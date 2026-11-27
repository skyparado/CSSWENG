import { Router } from 'express';
import { asyncHandler } from '../http.js';
import { requireAuth, requireRole } from '../auth/guards.js';
import { clearStubSmsOutbox, stubSmsOutbox } from '../reminders/gateway.js';

/**
 * Development SMS outbox: the messages the SMS stub would have sent, newest
 * first, so the reminder text can be checked in a demo or a test the way
 * Mailpit shows email. Mounted only outside production and only while
 * SMS_PROVIDER=stub (app.ts); a real provider's own dashboard replaces it.
 * Doctor only. Numbers are masked to the last 3 digits.
 */
export const smsOutboxRouter = Router();
smsOutboxRouter.use(requireAuth, requireRole('DOCTOR'));

/** GET /api/dev/sms-outbox */
smsOutboxRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ items: stubSmsOutbox() });
  }),
);

/** DELETE /api/dev/sms-outbox — empty it before a test or a demo run. */
smsOutboxRouter.delete(
  '/',
  asyncHandler(async (_req, res) => {
    clearStubSmsOutbox();
    res.status(204).end();
  }),
);
