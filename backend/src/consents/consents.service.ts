import type { PatientConsent, ReminderChannel } from '@prisma/client';
import { prisma } from '../prisma.js';

/**
 * The patient's current reminder consent for a channel, or null.
 *
 * The latest decision wins: a later refusal overrides an earlier grant. A
 * consent only counts when it was granted and has not been withdrawn
 * (FR-5.5.6, Database Design 1.5 "Reminder consent enforced").
 */
export async function findActiveReminderConsent(
  patientId: string,
  channel: ReminderChannel,
): Promise<PatientConsent | null> {
  const latest = await prisma.patientConsent.findFirst({
    where: { patientId, consentType: 'REMINDER', channel },
    orderBy: { consentedAt: 'desc' },
  });
  if (!latest || !latest.isGranted || latest.withdrawnAt) return null;
  return latest;
}
