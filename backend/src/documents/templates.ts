import type {
  MedicalCertificatePayload,
  PrescriptionPayload,
} from '@clinic/schemas';

/** Minimal HTML escaping for interpolated template values. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(d: Date): string {
  return new Intl.DateTimeFormat('en-PH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(d);
}

const baseStyle = `
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #111827; margin: 0; padding: 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .clinic { color: #374151; font-size: 13px; margin-bottom: 24px; }
  .meta { font-size: 13px; color: #374151; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e5e7eb; }
  th { background: #f3f4f6; }
  .sig { margin-top: 64px; font-size: 13px; }
  .sig .line { border-top: 1px solid #111827; width: 260px; padding-top: 4px; }
  .label { color: #6b7280; }
`;

export function renderPrescriptionHtml(p: PrescriptionPayload): string {
  const rows = p.items
    .map(
      (it) => `
        <tr>
          <td>${esc(it.drug)}</td>
          <td>${esc(it.dosage)}</td>
          <td>${esc(it.frequency)}</td>
          <td>${esc(it.duration)}</td>
          <td>${esc(it.notes ?? '')}</td>
        </tr>`,
    )
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}</style></head><body>
    <h1>Prescription</h1>
    <div class="clinic">${esc(p.clinicName)}</div>
    <div class="meta">
      <div><span class="label">Patient:</span> ${esc(p.patientName)}${
        p.patientAge !== undefined ? ` (${esc(p.patientAge)} y/o)` : ''
      }</div>
      <div><span class="label">Date:</span> ${esc(fmtDate(p.issuedOn))}</div>
    </div>
    <table>
      <thead><tr><th>Drug</th><th>Dosage</th><th>Frequency</th><th>Duration</th><th>Notes</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="sig">
      <div class="line">${esc(p.prescriberName)}</div>
      ${p.prescriberLicense ? `<div class="label">License No. ${esc(p.prescriberLicense)}</div>` : ''}
    </div>
  </body></html>`;
}

export function renderMedicalCertificateHtml(
  p: MedicalCertificatePayload,
): string {
  const rest =
    p.restFromDate && p.restToDate
      ? `<p>The patient is advised to rest from <strong>${esc(
          fmtDate(p.restFromDate),
        )}</strong> to <strong>${esc(fmtDate(p.restToDate))}</strong>.</p>`
      : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}</style></head><body>
    <h1>Medical Certificate</h1>
    <div class="clinic">${esc(p.clinicName)}</div>
    <div class="meta"><span class="label">Date:</span> ${esc(fmtDate(p.issuedOn))}</div>
    <p>This is to certify that <strong>${esc(p.patientName)}</strong> was examined and found to have:</p>
    <p><strong>${esc(p.diagnosis)}</strong></p>
    ${p.recommendation ? `<p>${esc(p.recommendation)}</p>` : ''}
    ${rest}
    <div class="sig">
      <div class="line">${esc(p.prescriberName)}</div>
      ${p.prescriberLicense ? `<div class="label">License No. ${esc(p.prescriberLicense)}</div>` : ''}
    </div>
  </body></html>`;
}
