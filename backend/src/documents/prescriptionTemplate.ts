import type { PrescriptionPayload } from '@clinic/schemas';
import { baseStyle, esc, fmtDate, letterhead, signature } from './templateShared.js';

/** Prescription, laid out like Dr. Pacio's prescription pad. */
export function renderPrescriptionHtml(p: PrescriptionPayload, signatureDataUri?: string): string {
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
    ${letterhead(p.clinicName, p.clinicAddress, p.clinicPhone)}
    <h1>Prescription</h1>
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
    ${signature(p.prescriberName, p.prescriberLicense, signatureDataUri, {
      s2: p.prescriberS2,
      issued: fmtDate(p.issuedOn),
      ptr: p.prescriberPtr,
    })}
  </body></html>`;
}
