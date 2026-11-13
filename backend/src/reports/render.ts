import type { ReportResult } from '@clinic/schemas';

/**
 * Spreadsheet programs run any cell that starts with = + - @ as a formula, so a
 * patient or user name like "=HYPERLINK(...)" could execute when the CSV is
 * opened. Text cells that start with one of those characters get a leading
 * apostrophe. Numbers are written as they are.
 */
function csvCell(value: string | number): string {
  if (typeof value === 'number') return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV with a UTF-8 byte-order mark (so Excel reads accents correctly) and CRLF line ends. */
export function toCsv(result: ReportResult): string {
  const header = result.columns.map((c) => csvCell(c.label)).join(',');
  const lines = result.rows.map((row) => result.columns.map((c) => csvCell(row[c.key] ?? '')).join(','));
  return `﻿${[header, ...lines].join('\r\n')}\r\n`;
}

const escapeHtml = (v: string | number) =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A self-contained A4 page for the PDF renderer: no external fonts, scripts or images. */
export function toHtml(result: ReportResult, generatedAt: Date = new Date()): string {
  const summary = result.summary
    .map(
      (s) =>
        `<div class="stat ${s.tone ?? ''}"><b>${escapeHtml(s.value)}</b><span>${escapeHtml(s.label)}</span></div>`,
    )
    .join('');
  const head = result.columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('');
  const body = result.rows
    .map((r) => `<tr>${result.columns.map((c) => `<td>${escapeHtml(r[c.key] ?? '')}</td>`).join('')}</tr>`)
    .join('');
  const empty = result.rows.length === 0 ? `<p class="muted">No data for this period.</p>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(result.title)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1f2937; font-size: 11px; margin: 0; padding: 16mm 14mm; }
  h1 { font-size: 20px; margin: 0 0 4px; color: #1d4a85; }
  .meta { color: #6b7280; margin-bottom: 14px; }
  .stats { display: flex; gap: 10px; margin-bottom: 16px; }
  .stat { flex: 1; border-left: 4px solid #1d4a85; background: #f4f7fb; padding: 8px 10px; }
  .stat b { display: block; font-size: 22px; color: #1d4a85; }
  .stat.bad { border-color: #b91c1c; } .stat.bad b { color: #b91c1c; }
  .stat.warn { border-color: #b45309; } .stat.warn b { color: #b45309; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; background: #eaf1fb; color: #1d4a85; padding: 6px; border-bottom: 2px solid #1d4a85; }
  td { padding: 5px 6px; border-bottom: 1px solid #dde3ec; }
  .muted { color: #6b7280; }
  .foot { margin-top: 14px; color: #6b7280; font-size: 10px; }
</style></head><body>
<h1>${escapeHtml(result.title)}</h1>
<div class="meta">${escapeHtml(result.clinicName)} · ${escapeHtml(result.from)} to ${escapeHtml(result.to)}</div>
<div class="stats">${summary}</div>
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
${empty}
${result.note ? `<p class="foot">${escapeHtml(result.note)}</p>` : ''}
<p class="foot">Generated ${escapeHtml(generatedAt.toISOString())}. Confidential: contains patient information protected under RA 10173.</p>
</body></html>`;
}
