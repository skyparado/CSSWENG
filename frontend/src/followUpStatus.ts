import type { FollowUp, OutreachChannel, OutreachOutcome, Priority, TaskType } from './api';

export const TASK_LABEL: Record<TaskType, string> = {
  FOLLOW_UP: 'Follow-up',
  CHECK_UP: 'Check-up',
  LAB_TEST: 'Lab test',
  INJECTION: 'Injection',
  PROCEDURE: 'Procedure',
};

export const PRIORITY_LABEL: Record<Priority, string> = { LOW: 'Low', NORMAL: 'Normal', HIGH: 'High' };

export const OUTCOME_LABEL: Record<OutreachOutcome, string> = {
  REACHED: 'Reached',
  NO_ANSWER: 'No answer',
  LEFT_MESSAGE: 'Left message',
  WRONG_NUMBER: 'Wrong number',
  DECLINED: 'Declined',
  BOOKED: 'Booked',
  SENT: 'Sent',
  FAILED: 'Failed',
};

/** Outcomes staff can choose for a call (SENT and FAILED belong to automated reminders). */
export const CALL_OUTCOMES: OutreachOutcome[] = ['REACHED', 'NO_ANSWER', 'LEFT_MESSAGE', 'WRONG_NUMBER', 'DECLINED', 'BOOKED'];

export const CHANNEL_LABEL: Record<OutreachChannel, string> = { CALL: 'Call', SMS: 'SMS', EMAIL: 'Email' };

export interface StatusView {
  label: string;
  tone: 'ok' | 'warn' | 'bad' | '';
}

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * The badge S11 shows for a task: stored status, and for an open task how its
 * due date compares with today on the clinic's calendar.
 */
export function statusView(f: Pick<FollowUp, 'status' | 'dueDate'>, today: string): StatusView {
  switch (f.status) {
    case 'COMPLETED':
      return { label: 'Done', tone: 'ok' };
    case 'SCHEDULED':
      return { label: 'Booked', tone: 'ok' };
    case 'DECLINED':
      return { label: 'Declined', tone: '' };
    case 'UNREACHABLE':
      return { label: 'Unreachable', tone: '' };
  }
  const ahead = daysBetween(today, f.dueDate.slice(0, 10)); // negative when overdue
  if (ahead < 0) return { label: 'Overdue', tone: 'bad' };
  if (ahead === 0) return { label: 'Due today', tone: 'warn' };
  if (ahead <= 7) return { label: 'Due this week', tone: 'warn' };
  return { label: 'Open', tone: '' };
}

/** "Oct 12" from a YYYY-MM-DD or ISO date, without the browser's time zone shifting the day. */
export function shortDueDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
}

/** Which reminder channel is on file for a task, for the "SMS on file" / "No consent" column. */
export function reminderLabel(consent: FollowUp['reminderConsent']): { text: string; ok: boolean } {
  if (consent?.SMS) return { text: 'SMS on file', ok: true };
  if (consent?.EMAIL) return { text: 'Email on file', ok: true };
  return { text: 'No consent', ok: false };
}

/** Whether a task can still be worked (booked, completed, declined or called off). */
export const isOpen = (f: Pick<FollowUp, 'status'>) => f.status === 'OPEN' || f.status === 'SCHEDULED';
