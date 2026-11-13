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

export interface ReminderConsentView {
  active: boolean;
  isGranted: boolean;
  consentedAt: Date;
  withdrawnAt: Date | null;
  recordedBy: { fullName: string };
}

/** The latest reminder consent decision per channel, with who recorded it (S12). */
export async function latestReminderConsents(
  patientId: string,
): Promise<Partial<Record<ReminderChannel, ReminderConsentView>>> {
  const rows = await prisma.patientConsent.findMany({
    where: { patientId, consentType: 'REMINDER' },
    orderBy: { consentedAt: 'desc' },
    include: { recordedBy: { select: { fullName: true } } },
  });
  const out: Partial<Record<ReminderChannel, ReminderConsentView>> = {};
  for (const r of rows) {
    if (!r.channel || out[r.channel]) continue;
    out[r.channel] = {
      active: r.isGranted && !r.withdrawnAt,
      isGranted: r.isGranted,
      consentedAt: r.consentedAt,
      withdrawnAt: r.withdrawnAt,
      recordedBy: r.recordedBy,
    };
  }
  return out;
}
