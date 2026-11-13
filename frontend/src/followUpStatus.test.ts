import { describe, expect, it } from 'vitest';
import { isOpen, reminderLabel, shortDueDate, statusView } from './followUpStatus';

const TODAY = '2026-11-10';

describe('statusView', () => {
  it.each([
    ['COMPLETED', '2026-11-01', 'Done'],
    ['SCHEDULED', '2026-11-01', 'Booked'], // booked beats overdue
    ['DECLINED', '2026-11-20', 'Declined'],
    ['UNREACHABLE', '2026-11-20', 'Unreachable'],
  ])('shows a %s task as %s whatever its date', (status, dueDate, label) => {
    expect(statusView({ status, dueDate }, TODAY).label).toBe(label);
  });

  it.each([
    ['2026-11-09', 'Overdue', 'bad'],
    ['2026-10-01', 'Overdue', 'bad'],
    ['2026-11-10', 'Due today', 'warn'],
    ['2026-11-11', 'Due this week', 'warn'],
    ['2026-11-17', 'Due this week', 'warn'],
    ['2026-11-18', 'Open', ''],
  ])('shows an open task due %s as %s', (dueDate, label, tone) => {
    expect(statusView({ status: 'OPEN', dueDate: `${dueDate}T00:00:00.000Z` }, TODAY)).toEqual({ label, tone });
  });
});

describe('reminderLabel', () => {
  it('prefers SMS, then email, otherwise says there is no consent', () => {
    expect(reminderLabel({ SMS: true, EMAIL: true })).toEqual({ text: 'SMS on file', ok: true });
    expect(reminderLabel({ SMS: false, EMAIL: true })).toEqual({ text: 'Email on file', ok: true });
    expect(reminderLabel({ SMS: false, EMAIL: false })).toEqual({ text: 'No consent', ok: false });
    expect(reminderLabel(undefined)).toEqual({ text: 'No consent', ok: false });
  });
});

describe('helpers', () => {
  it('formats a due date without a time zone shift', () => {
    expect(shortDueDate('2026-10-12T00:00:00.000Z')).toBe('Oct 12');
  });

  it('treats open and booked tasks as workable', () => {
    expect(isOpen({ status: 'OPEN' })).toBe(true);
    expect(isOpen({ status: 'SCHEDULED' })).toBe(true);
    expect(isOpen({ status: 'COMPLETED' })).toBe(false);
  });
});
