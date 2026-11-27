import type { MedicalCertificatePayload } from '@clinic/schemas';
import { baseStyle, esc, fmtDate, letterhead, signature } from './templateShared.js';

/** Medical certificate. It has no PTR or S2 number. */
export function renderMedicalCertificateHtml(
  p: MedicalCertificatePayload,
  signatureDataUri?: string,
): string {
  const rest =
    p.restFromDate && p.restToDate
      ? `<p>The patient is advised to rest from <strong>${esc(
          fmtDate(p.restFromDate),
        )}</strong> to <strong>${esc(fmtDate(p.restToDate))}</strong>.</p>`
      : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}</style></head><body>
    ${letterhead(p.clinicName, p.clinicAddress, p.clinicPhone)}
    <h1>Medical Certificate</h1>
    <div class="meta"><span class="label">Date:</span> ${esc(fmtDate(p.issuedOn))}</div>
    <p>This is to certify that <strong>${esc(p.patientName)}</strong> was examined and found to have:</p>
    <p><strong>${esc(p.diagnosis)}</strong></p>
    ${p.recommendation ? `<p>${esc(p.recommendation)}</p>` : ''}
    ${rest}
    ${signature(p.prescriberName, p.prescriberLicense, signatureDataUri)}
  </body></html>`;
}
