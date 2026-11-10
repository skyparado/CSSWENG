import type { AuditLog } from '@prisma/client';

/** Columns in the exported CSV, in order. */
const COLUMNS = [
  'createdAt',
  'action',
  'userEmail',
  'userRole',
  'resourceType',
  'resourceId',
  'method',
  'path',
  'statusCode',
  'ipAddress',
  'userAgent',
  'metadata',
  'entryHash',
] as const;

const HEADINGS: Record<(typeof COLUMNS)[number], string> = {
  createdAt: 'Timestamp (UTC)',
  action: 'Action',
  userEmail: 'User',
  userRole: 'Role',
  resourceType: 'Resource Type',
  resourceId: 'Resource ID',
  method: 'Method',
  path: 'Path',
  statusCode: 'Status',
  ipAddress: 'IP Address',
  userAgent: 'User Agent',
  metadata: 'Details',
  entryHash: 'Entry Hash',
};

function cellValue(row: AuditLog, key: (typeof COLUMNS)[number]): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Quote a CSV field. Also guards against formula injection: a value starting
 * with =, +, - or @ is prefixed with a single quote so Excel treats it as
 * text instead of running it. Audit values come from request paths and user
 * agents, which an attacker can influence.
 */
function csvCell(raw: string): string {
  const guarded = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** Render matching entries as CSV, newest last to match the chain order. */
export function toCsv(rows: AuditLog[]): string {
  const header = COLUMNS.map((c) => csvCell(HEADINGS[c])).join(',');
  const body = rows.map((row) =>
    COLUMNS.map((c) => csvCell(cellValue(row, c))).join(','),
  );
  // Leading BOM so Excel opens UTF-8 content correctly.
  return `﻿${[header, ...body].join('\r\n')}\r\n`;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Columns worth the width on a printed page. The hash goes in a detail line. */
const PDF_COLUMNS = [
  'createdAt',
  'action',
  'userEmail',
  'resourceType',
  'resourceId',
  'statusCode',
] as const;

export type PdfExportMeta = {
  generatedAt: Date;
  generatedBy: string;
  total: number;
  truncated: boolean;
  /** Human-readable summary of the filters that produced this export. */
  filterSummary: string;
};

/**
 * Build the HTML that Puppeteer turns into the audit PDF. Kept as a plain
 * string template rather than a view engine, matching how the document
 * templates in src/documents already work.
 */
export function toPdfHtml(rows: AuditLog[], meta: PdfExportMeta): string {
  const head = PDF_COLUMNS.map((c) => `<th>${escapeHtml(HEADINGS[c])}</th>`).join('');
  const body = rows
    .map((row) => {
      const cells = PDF_COLUMNS.map(
        (c) => `<td>${escapeHtml(cellValue(row, c))}</td>`,
      ).join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  const truncationNote = meta.truncated
    ? `<p class="warn">Showing the first ${rows.length} of ${meta.total} matching entries.
       Narrow the date range to export the rest.</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Audit Log Export</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         color: #1a1a1a; font-size: 9pt; }
  h1 { font-size: 15pt; margin: 0 0 2mm; color: #1d4a85; }
  .meta { color: #555; font-size: 8pt; margin: 0 0 4mm; line-height: 1.5; }
  .warn { color: #8a1f1f; font-size: 8pt; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th, td { border: 0.4pt solid #c8cdd4; padding: 1.4mm 2mm; text-align: left;
           vertical-align: top; word-break: break-word; }
  th { background: #eaf1fb; color: #1d4a85; font-size: 8pt; }
  tr { page-break-inside: avoid; }
  tbody tr:nth-child(even) { background: #f7f9fc; }
  .footer { margin-top: 4mm; color: #666; font-size: 7.5pt; }
</style>
</head>
<body>
  <h1>Audit Log Export</h1>
  <p class="meta">
    Clinics of Dr. Angeline Pacio &middot; Electronic Medical Records<br />
    Generated ${escapeHtml(meta.generatedAt.toISOString())} by ${escapeHtml(meta.generatedBy)}<br />
    Filters: ${escapeHtml(meta.filterSummary)}<br />
    ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} of ${meta.total} matching.
  </p>
  ${truncationNote}
  <table>
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>
  <p class="footer">
    Entries are append-only and chained by SHA-256. Released under the Data
    Privacy Act of 2012; handle this export as confidential patient-related
    material.
  </p>
</body>
</html>`;
}

/** One-line description of the active filters, for the export header. */
export function describeFilters(query: Record<string, unknown>): string {
  const parts: string[] = [];
  const label: Record<string, string> = {
    userId: 'user',
    action: 'action',
    resourceType: 'resource type',
    resourceId: 'resource',
    clinicId: 'clinic',
    q: 'search',
    from: 'from',
    to: 'to',
  };
  for (const [key, name] of Object.entries(label)) {
    const value = query[key];
    if (value === undefined || value === null || value === '') continue;
    const text = value instanceof Date ? value.toISOString() : String(value);
    parts.push(`${name}=${text}`);
  }
  if (query.hideHttpNoise) parts.push('generic HTTP rows hidden');
  return parts.length > 0 ? parts.join(', ') : 'none (all entries)';
}
