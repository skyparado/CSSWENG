import type { ReactNode } from 'react';
import { allergyText, formatDate, fullName, initials, SEX_LABEL, type Allergy, type PatientDetail } from '../clinicalApi';

/** Breadcrumb trail, e.g. Patients › Maria Santos › Compare Results. */
export function Crumbs({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {items.map((c, i) => (
        <span key={c.label}>
          {i > 0 && <span aria-hidden> › </span>}
          {c.href ? <a href={c.href}>{c.label}</a> : <span aria-current="page">{c.label}</span>}
        </span>
      ))}
    </nav>
  );
}

/** "P-00231 · 60 y/o Female · 0917 555 1234 · HMO: Maxicare" */
export function patientLine(p: PatientDetail) {
  return [
    p.patientNumber,
    `${p.age} y/o ${SEX_LABEL[p.sex]}`,
    p.mobileNumber,
    p.hmoProvider ? `HMO: ${p.hmoProvider}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** S06/S07/S08 header card: initials, name, identifiers, and the screen's actions. */
export function PatientHeader({ patient, extra, children }: { patient: PatientDetail; extra?: string; children?: ReactNode }) {
  return (
    <section className="card patient-head">
      <span className="avatar" aria-hidden>
        {initials(patient)}
      </span>
      <div className="grow">
        <h1>{fullName(patient)}</h1>
        <p className="muted">
          {patientLine(patient)}
          {extra ? ` · ${extra}` : ''}
        </p>
      </div>
      {children && <div className="row">{children}</div>}
    </section>
  );
}

/** Allergy banner shown on every clinical screen. */
export function AllergyBanner({ allergies }: { allergies: Allergy[] }) {
  if (allergies.length === 0) return <p className="notice">No known allergies recorded.</p>;
  return (
    <p className="alert allergy" role="alert">
      <span aria-hidden>⚠ </span>ALLERGY: {allergyText(allergies)}
    </p>
  );
}

export const visitLine = (v: { visitDate: string }) => formatDate(v.visitDate);
