import { describe, expect, it } from 'vitest';
import type { ReportResult } from './api';
import { chartFor, visibleTabs } from './reportCharts';

const base: ReportResult = {
  report: 'patient-volume',
  title: 't',
  from: '2026-11-02',
  to: '2026-11-08',
  clinicId: null,
  clinicName: 'All clinics',
  summary: [],
  columns: [],
  rows: [],
};

describe('chartFor', () => {
  it('draws nothing for an empty report', () => {
    expect(chartFor(base)).toBeNull();
  });

  it('adds up the clinics of one day into a single stacked bar', () => {
    const chart = chartFor({
      ...base,
      rows: [
        { date: '2026-11-03', clinic: 'UERM', booked: 2, walkIn: 1, seen: 3, noShow: 0 },
        { date: '2026-11-03', clinic: 'Tamesis', booked: 1, walkIn: 0, seen: 1, noShow: 0 },
        { date: '2026-11-02', clinic: 'UERM', booked: 4, walkIn: 0, seen: 4, noShow: 0 },
      ],
    });
    expect(chart?.data).toEqual([
      { label: 'Nov 2', booked: 4, walkIn: 0 },
      { label: 'Nov 3', booked: 3, walkIn: 1 },
    ]);
    expect(chart?.series.map((s) => s.key)).toEqual(['booked', 'walkIn']);
  });

  it('plots compliance per clinic with a series for every outcome', () => {
    const chart = chartFor({ ...base, report: 'follow-up-compliance', rows: [{ clinic: 'UERM', onTime: 5, late: 1, overdue: 2, declined: 0, unreachable: 1 }] });
    expect(chart?.data[0]).toMatchObject({ label: 'UERM', onTime: 5 });
    expect(chart?.series.map((s) => s.key)).toEqual(['onTime', 'late', 'overdue', 'declined', 'unreachable']);
  });

  it('counts overdue tasks by type', () => {
    const chart = chartFor({ ...base, report: 'overdue-patients', rows: [{ task: 'Injection' }, { task: 'Check-up' }, { task: 'Injection' }] });
    expect(chart?.data).toEqual([{ label: 'Injection', count: 2 }, { label: 'Check-up', count: 1 }]);
  });

  it('shows at most the ten most common diagnoses, as horizontal bars', () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({ rank: i + 1, diagnosis: `Dx ${i + 1}`, count: 20 - i }));
    const chart = chartFor({ ...base, report: 'common-diagnoses', rows });
    expect(chart?.data).toHaveLength(10);
    expect(chart?.horizontal).toBe(true);
  });

  it('plots record views and changes per user', () => {
    const chart = chartFor({ ...base, report: 'user-access-activity', rows: [{ user: 'J. Ramos', recordViews: 7, changes: 2 }] });
    expect(chart?.data).toEqual([{ label: 'J. Ramos', recordViews: 7, changes: 2 }]);
  });
});

describe('visibleTabs', () => {
  it('gives the Doctor all five reports and the Secretary patient volume only', () => {
    expect(visibleTabs('DOCTOR')).toHaveLength(5);
    expect(visibleTabs('SECRETARY').map((t) => t.key)).toEqual(['patient-volume']);
  });
});
