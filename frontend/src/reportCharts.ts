import type { ReportResult } from './api';

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
}

export interface ChartSpec {
  title: string;
  data: Array<Record<string, string | number>>;
  /** The field that labels each bar. */
  xKey: string;
  series: ChartSeries[];
  /** Bars run left to right (long labels, such as diagnoses). */
  horizontal?: boolean;
}

const NAVY = '#1d4a85';
const AMBER = '#b45309';
const RED = '#b91c1c';
const GREEN = '#15803d';
const GREY = '#6b7280';

/** "Nov 2" from a YYYY-MM-DD date, independent of the browser's time zone. */
const shortDate = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));

const num = (v: string | number | undefined) => (typeof v === 'number' ? v : Number(v) || 0);

/**
 * What to draw for each report, from the same rows the table shows (so the
 * chart can never disagree with the table). Returns null when there is nothing to plot.
 */
export function chartFor(r: ReportResult): ChartSpec | null {
  if (r.rows.length === 0) return null;

  switch (r.report) {
    case 'patient-volume': {
      // One bar per day, adding up the clinics that day.
      const byDay = new Map<string, { label: string; booked: number; walkIn: number }>();
      for (const row of r.rows) {
        const date = String(row.date);
        const d = byDay.get(date) ?? { label: shortDate(date), booked: 0, walkIn: 0 };
        d.booked += num(row.booked);
        d.walkIn += num(row.walkIn);
        byDay.set(date, d);
      }
      return {
        title: 'Visits per day',
        data: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, d]) => d),
        xKey: 'label',
        series: [
          { key: 'booked', label: 'Booked', color: NAVY },
          { key: 'walkIn', label: 'Walk-in', color: AMBER },
        ],
      };
    }
    case 'follow-up-compliance':
      return {
        title: 'Follow-ups by outcome',
        data: r.rows.map((row) => ({ ...row, label: String(row.clinic) })),
        xKey: 'label',
        series: [
          { key: 'onTime', label: 'On time', color: GREEN },
          { key: 'late', label: 'Late', color: AMBER },
          { key: 'overdue', label: 'Overdue', color: RED },
          { key: 'declined', label: 'Declined', color: GREY },
          { key: 'unreachable', label: 'Unreachable', color: '#9ca3af' },
        ],
      };
    case 'overdue-patients': {
      const byTask = new Map<string, number>();
      for (const row of r.rows) byTask.set(String(row.task), (byTask.get(String(row.task)) ?? 0) + 1);
      return {
        title: 'Overdue tasks by type',
        data: [...byTask.entries()].map(([label, count]) => ({ label, count })),
        xKey: 'label',
        series: [{ key: 'count', label: 'Overdue tasks', color: RED }],
      };
    }
    case 'common-diagnoses':
      return {
        title: 'Most common diagnoses',
        data: r.rows.slice(0, 10).map((row) => ({ label: String(row.diagnosis), count: num(row.count) })),
        xKey: 'label',
        series: [{ key: 'count', label: 'Visits', color: NAVY }],
        horizontal: true,
      };
    case 'user-access-activity':
      return {
        title: 'Activity per user',
        data: r.rows.map((row) => ({ label: String(row.user), recordViews: num(row.recordViews), changes: num(row.changes) })),
        xKey: 'label',
        series: [
          { key: 'recordViews', label: 'Record views', color: NAVY },
          { key: 'changes', label: 'Changes', color: AMBER },
        ],
      };
  }
}

/** The tabs a role may open (SDD Table 7-1): the Secretary sees patient volume only. */
export const REPORT_TABS: Array<{ key: ReportResult['report']; label: string; doctorOnly: boolean }> = [
  { key: 'patient-volume', label: 'Patient Volume', doctorOnly: false },
  { key: 'follow-up-compliance', label: 'Follow-Up Compliance', doctorOnly: true },
  { key: 'overdue-patients', label: 'Overdue Patients', doctorOnly: true },
  { key: 'common-diagnoses', label: 'Common Diagnoses', doctorOnly: true },
  { key: 'user-access-activity', label: 'User Access Activity', doctorOnly: true },
];

export const visibleTabs = (role: 'DOCTOR' | 'SECRETARY') => REPORT_TABS.filter((t) => role === 'DOCTOR' || !t.doctorOnly);
