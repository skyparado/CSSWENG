import { describe, it, expect } from 'vitest';
import {
  renderPrescriptionHtml,
  renderMedicalCertificateHtml,
} from './templates.js';

describe('document templates', () => {
  it('renders prescription items and escapes HTML', () => {
    const html = renderPrescriptionHtml({
      patientName: 'Juan <b>Dela Cruz</b>',
      clinicName: 'Mabuhay Clinic',
      prescriberName: 'Dr. Reyes',
      issuedOn: new Date('2026-01-10T00:00:00Z'),
      items: [
        { drug: 'Amoxicillin', dosage: '500mg', frequency: '3x/day', duration: '7 days' },
      ],
    });
    expect(html).toContain('Amoxicillin');
    expect(html).toContain('Juan &lt;b&gt;Dela Cruz&lt;/b&gt;'); // escaped
    expect(html).not.toContain('<b>Dela Cruz</b>');
  });

  it('renders a medical certificate with a rest period', () => {
    const html = renderMedicalCertificateHtml({
      patientName: 'Maria Santos',
      clinicName: 'Mabuhay Clinic',
      prescriberName: 'Dr. Reyes',
      issuedOn: new Date('2026-01-10T00:00:00Z'),
      diagnosis: 'Acute bronchitis',
      restFromDate: new Date('2026-01-10T00:00:00Z'),
      restToDate: new Date('2026-01-13T00:00:00Z'),
    });
    expect(html).toContain('Medical Certificate');
    expect(html).toContain('Acute bronchitis');
    expect(html).toContain('advised to rest');
  });
});
