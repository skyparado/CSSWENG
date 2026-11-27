/**
 * Pieces shared by every document Dr. Pacio issues: the letterhead, the signature
 * block and the page style. The two documents are in prescriptionTemplate.ts
 * and certificateTemplate.ts.
 */
/** Minimal HTML escaping for interpolated template values. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtDate(d: Date): string {
  return new Intl.DateTimeFormat('en-PH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Manila',
  }).format(d);
}

/** How Dr. Pacio's prescription pad prints her name and practice. */
const DOCTOR_LINE = 'Angeline Edrielle M. Pacio, RMT, MD';
const PRACTICE_LINE = 'General Practice';
/** Her pad says "SCHEDULE: BY APPOINTMENT". It is always printed, whatever the clinic's opening hours are. */
const SCHEDULE_LINE = 'BY APPOINTMENT';

/**
 * Letterhead shared by every document Dr. Pacio issues, laid out like her pad:
 * name, practice, then SCHEDULE and CONTACT NUMBER on their own lines above a rule.
 */
export function letterhead(
  clinicName: string,
  clinicAddress?: string,
  clinicPhone?: string,
): string {
  return `<div class="letterhead">
    <div class="dr">${esc(DOCTOR_LINE)}</div>
    <div class="practice">${esc(PRACTICE_LINE)}</div>
    <div class="clinic">${esc(clinicName)}${clinicAddress ? ` &middot; ${esc(clinicAddress)}` : ''}</div>
    <div class="contact">
      <div>SCHEDULE: ${esc(SCHEDULE_LINE)}</div>
      ${clinicPhone ? `<div>CONTACT NUMBER: ${esc(clinicPhone)}</div>` : ''}
    </div>
  </div>`;
}

/**
 * Signature block, bottom right like her pad: name, Lic No., S2. No., Date of
 * Issue, PTR No. (PTR and S2 only on prescriptions). `signatureDataUri` is the
 * Doctor's uploaded signature image, passed only when the document is signed;
 * unsigned renders carry a draft stamp.
 */
export function signature(
  name: string,
  license?: string,
  signatureDataUri?: string,
  extras: { s2?: string; issued?: string; ptr?: string } = {},
): string {
  const mark = signatureDataUri
    ? `<img class="sig-img" src="${esc(signatureDataUri)}" alt="Signature">`
    : '<div class="draft">DRAFT · NOT SIGNED</div>';
  const row = (label: string, value?: string) =>
    value ? `<div class="label">${label} <span class="val">${esc(value)}</span></div>` : '';
  return `<div class="sig">
      <div class="sig-space">${mark}</div>
      <div class="line">${esc(name)}</div>
      ${row('Lic No.', license)}
      ${row('S2. No.', extras.s2)}
      ${row('Date of Issue', extras.issued)}
      ${row('PTR No.', extras.ptr)}
    </div>`;
}

export const baseStyle = `
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #111827; margin: 0; padding: 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .letterhead { text-align: center; font-size: 13px; border-bottom: 2px solid #111827; padding-bottom: 12px; margin-bottom: 24px; }
  .letterhead .dr { font-size: 22px; font-style: italic; font-family: Georgia, 'Times New Roman', serif; }
  .letterhead .practice { font-size: 14px; margin-top: 2px; }
  .clinic { color: #374151; font-size: 12px; margin-top: 4px; }
  .contact { text-align: left; margin-top: 14px; font-size: 13px; }
  .sig-space { height: 56px; display: flex; align-items: flex-end; }
  .sig-img { max-height: 56px; max-width: 260px; }
  .draft { color: #b91c1c; border: 2px dashed #b91c1c; padding: 4px 10px; font-weight: bold; letter-spacing: 1px; transform: rotate(-6deg); }
  .meta { font-size: 13px; color: #374151; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e5e7eb; }
  th { background: #f3f4f6; }
  .sig { margin: 32px 0 0 auto; width: 280px; font-size: 13px; }
  .sig .line { border-top: 1px solid #111827; width: 260px; padding-top: 4px; }
  .label { color: #374151; }
  .val { color: #111827; }
`;
