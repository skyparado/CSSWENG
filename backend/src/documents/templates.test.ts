import { describe, it, expect } from 'vitest';
import {
  renderPrescriptionHtml,
  renderMedicalCertificateHtml,
} from './templates.js';

describe('document templates', () => {
  it('renders prescription items and escapes HTML', () => {
    const html = renderPrescriptionHtml({
      patientName: 'Juan <b>Dela Cruz</b>',
      clinicName: 'UERM',
      clinicAddress: 'Aurora Blvd, Quezon City',
      prescriberName: 'Angeline Pacio, MD',
      issuedOn: new Date('2026-01-10T00:00:00Z'),
      items: [
        { drug: 'Moxifloxacin 0.5% eye drops', dosage: '1 drop', frequency: '4x/day, both eyes', duration: '7 days' },
      ],
    });
    expect(html).toContain('Moxifloxacin');
    expect(html).toContain('General Ophthalmologist');
    expect(html).toContain('Aurora Blvd, Quezon City');
    expect(html).toContain('Juan &lt;b&gt;Dela Cruz&lt;/b&gt;'); // escaped
    expect(html).not.toContain('<b>Dela Cruz</b>');
  });

  it('stamps unsigned documents as drafts and embeds the signature once signed', () => {
    const p = {
      patientName: 'Maria Santos',
      clinicName: 'Happy Eyes',
      prescriberName: 'Angeline Pacio, MD',
      issuedOn: new Date('2026-01-10T00:00:00Z'),
      items: [{ drug: 'Timolol', dosage: '1 drop', frequency: 'BID', duration: '30 days' }],
    };
    expect(renderPrescriptionHtml(p)).toContain('DRAFT · NOT SIGNED');
    const signed = renderPrescriptionHtml(p, 'data:image/png;base64,AAAA');
    expect(signed).toContain('<img class="sig-img" src="data:image/png;base64,AAAA"');
    expect(signed).not.toContain('DRAFT');
  });

  it('renders a medical certificate with a rest period', () => {
    const html = renderMedicalCertificateHtml({
      patientName: 'Maria Santos',
      clinicName: 'Happy Eyes',
      prescriberName: 'Angeline Pacio, MD',
      issuedOn: new Date('2026-01-10T00:00:00Z'),
      diagnosis: 'Bacterial conjunctivitis, both eyes',
      restFromDate: new Date('2026-01-10T00:00:00Z'),
      restToDate: new Date('2026-01-13T00:00:00Z'),
    });
    expect(html).toContain('Medical Certificate');
    expect(html).toContain('Bacterial conjunctivitis');
    expect(html).toContain('Diplomate, Philippine Board of Ophthalmology');
    expect(html).toContain('advised to rest');
  });
});
