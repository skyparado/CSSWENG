import { useState } from 'react';
import { withPatient } from '../api';
import {
  clinicalApi,
  ENCOUNTER_LABEL,
  formatDate,
  fullName,
  type ChartSummary,
  type Finding,
} from '../clinicalApi';
import { go, useLoad, useSession } from '../session';
import { AllergyBanner, Crumbs, PatientHeader } from './PatientParts';
import TrendChart from './TrendChart';

type Tab = 'summary' | 'visits' | 'medications' | 'documents';

const TASK_LABEL: Record<string, string> = {
  FOLLOW_UP: 'Follow-up',
  CHECK_UP: 'Check-up',
  LAB_TEST: 'Lab test',
  INJECTION: 'Injection',
  PROCEDURE: 'Procedure',
};

const DOC_LABEL = { PRESCRIPTION: 'Prescription', MEDICAL_CERTIFICATE: 'Medical certificate' } as const;

function noteBadge(v: ChartSummary['recentVisits'][number]) {
  if (v.noteStatus === 'SIGNED') return <span className="badge ok">Signed</span>;
  return <span className="badge bad">Unsigned note</span>;
}

/** "OD 20/150 · OS 20/150" for one field of the latest exam. */
function eyes(findings: Finding[], field: string) {
  const of = (eye: string) => findings.find((f) => f.fieldName === field && f.eye === eye);
  return (['OD', 'OS'] as const).map((eye) => {
    const f = of(eye);
    return (
      <span key={eye}>
        {eye} {f ? `${f.valueText}${f.unit && f.unit !== 'Snellen' ? ` ${f.unit}` : ''}` : '—'}
      </span>
    );
  });
}

/** S06 Patient Chart Summary. */
export default function PatientChart({ patientId }: { patientId: string }) {
  const { user } = useSession();
  const doctor = user.role === 'DOCTOR';
  const [tab, setTab] = useState<Tab>('summary');
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<string>();
  const { data, error } = useLoad(() => clinicalApi.summary(patientId), [patientId]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p>Loading…</p>;
  const p = data.patient;
  const ref = { id: p.id, firstName: p.firstName, lastName: p.lastName, email: p.email };

  // Resume today's open visit instead of starting a second one.
  const newNote = async () => {
    setFailure(undefined);
    const open = data.recentVisits.find((v) => v.status === 'OPEN');
    if (open) return go(`/patients/${p.id}/visits/${open.id}`);
    setStarting(true);
    try {
      const enc = await clinicalApi.startVisit({ patientId: p.id, type: 'FOLLOW_UP' });
      go(`/patients/${p.id}/visits/${enc.id}`);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  };

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'summary', label: 'Summary' },
    { id: 'visits', label: 'Visits & Notes' },
    { id: 'medications', label: 'Medications' },
    { id: 'documents', label: 'Documents' },
  ];

  return (
    <>
      <Crumbs items={[{ label: 'Patients', href: '#/patients' }, { label: fullName(p) }]} />
      <PatientHeader patient={p}>
        {doctor && (
          <>
            <button className="primary" onClick={() => void newNote()} disabled={starting}>
              + New Note
            </button>
            <a className="btn" href={`#${withPatient('/documents/new', ref)}&type=PRESCRIPTION`}>
              Prescription
            </a>
            <a className="btn" href={`#${withPatient('/documents/new', ref)}&type=MEDICAL_CERTIFICATE`}>
              Certificate
            </a>
          </>
        )}
      </PatientHeader>
      {failure && <p className="error">{failure}</p>}
      <AllergyBanner allergies={data.allergies} />

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
        {doctor && (
          <button role="tab" aria-selected={false} onClick={() => go(`/patients/${p.id}/compare`)}>
            Exam &amp; Labs
          </button>
        )}
      </div>

      {tab === 'summary' && <Summary data={data} doctor={doctor} onTab={setTab} />}
      {tab === 'visits' && <Visits data={data} />}
      {tab === 'medications' && <Medications data={data} />}
      {tab === 'documents' && <Documents data={data} />}

      <p className="muted small">
        Signed notes are locked; corrections are added as dated addenda. Every view of this chart is recorded in the audit log.
      </p>
    </>
  );
}

function Summary({ data, doctor, onTab }: { data: ChartSummary; doctor: boolean; onTab: (t: Tab) => void }) {
  const p = data.patient;
  const exam = data.latestExam;
  const iopSeries = data.iopTrend?.series ?? [];
  return (
    <div className="chart-grid">
      <div className="stack">
        <section className="card">
          <h2>Medical History</h2>
          {doctor ? (
            <>
              <p>{p.medicalHistory || <span className="muted">None recorded.</span>}</p>
              {p.ophthalmicHistory && (
                <>
                  <h3>Eye history</h3>
                  <p>{p.ophthalmicHistory}</p>
                </>
              )}
            </>
          ) : (
            <p className="muted">Visible to the doctor only.</p>
          )}
        </section>
        <section className="card">
          <div className="row between">
            <h2>Current Medications</h2>
            <button className="link" onClick={() => onTab('medications')}>
              View all
            </button>
          </div>
          {data.medications.length === 0 && <p className="muted">No active medications.</p>}
          <ul className="plain">
            {data.medications.slice(0, 3).map((m) => (
              <li key={m.id} className="row between">
                <div>
                  <strong>
                    {m.medicationName} {m.strength}
                  </strong>
                  <div className="muted small">
                    {m.dose}, {m.frequency}
                  </div>
                </div>
                <span className="badge ok">Active</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="stack">
        {doctor && (
          <section className="card">
            <div className="row between">
              <h2>Latest Examination{exam ? ` · ${formatDate(exam.visitDate, false)}` : ''}</h2>
              <a href={`#/patients/${p.id}/compare`}>Compare</a>
            </div>
            {!exam && <p className="muted">No examination recorded yet.</p>}
            {exam && (
              <>
                <h3>Visual acuity</h3>
                <p className="row spread">{eyes(exam.findings, 'VA')}</p>
                <h3>Eye pressure (IOP)</h3>
                <p className="row spread">{eyes(exam.findings, 'IOP')}</p>
                {exam.assessment && <p>Impression: {exam.assessment}</p>}
              </>
            )}
            {data.iopTrend && iopSeries.length > 0 && (
              <TrendChart chart={data.iopTrend} label="IOP trend (mmHg)" height={160} />
            )}
          </section>
        )}
        <section className="card">
          <div className="row between">
            <h2>Recent Visits</h2>
            <button className="link" onClick={() => onTab('visits')}>
              All visits
            </button>
          </div>
          <VisitTable visits={data.recentVisits.slice(0, 3)} patientId={p.id} doctor={doctor} />
        </section>
      </div>

      <div className="stack">
        <section className="card">
          <h2>Follow-Ups and Procedures</h2>
          {data.followUps.length === 0 && <p className="muted">Nothing scheduled.</p>}
          <table>
            <tbody>
              {data.followUps.map((f) => (
                <tr key={f.id}>
                  <td>
                    <strong>{formatDate(f.dueDate, false)}</strong>
                  </td>
                  <td>{f.reason || TASK_LABEL[f.taskType]}</td>
                  <td>
                    {f.status === 'SCHEDULED' ? <span className="badge ok">Booked</span> : <span className="badge bad">Due</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <div className="row between">
            <h2>Documents</h2>
            <button className="link" onClick={() => onTab('documents')}>
              View all
            </button>
          </div>
          <DocumentList docs={data.documents.slice(0, 3)} />
        </section>
      </div>
    </div>
  );
}

function VisitTable({ visits, patientId, doctor }: { visits: ChartSummary['recentVisits']; patientId: string; doctor: boolean }) {
  if (visits.length === 0) return <p className="muted">No visits yet.</p>;
  return (
    <table>
      <tbody>
        {visits.map((v) => (
          <tr key={v.id} className="nowrap">
            <td>
              {doctor ? (
                <a href={`#/patients/${patientId}/visits/${v.id}`}>{formatDate(v.visitDate)}</a>
              ) : (
                formatDate(v.visitDate)
              )}
            </td>
            <td>{ENCOUNTER_LABEL[v.type]}</td>
            <td className="muted">{v.clinicName}</td>
            <td>{noteBadge(v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Visits({ data }: { data: ChartSummary }) {
  const { user } = useSession();
  const doctor = user.role === 'DOCTOR';
  const { data: all, error } = useLoad(() => clinicalApi.encounters(data.patient.id), [data.patient.id]);
  if (error) return <p className="error">{error}</p>;
  if (!all) return <p>Loading…</p>;
  const visits = all.items.map((e) => ({
    id: e.id,
    visitDate: e.visitDate,
    type: e.type,
    status: e.status,
    clinicName: '',
    noteStatus: e.noteStatus,
  }));
  return (
    <section className="card">
      <h2>Visits &amp; Notes</h2>
      <VisitTable visits={visits} patientId={data.patient.id} doctor={doctor} />
    </section>
  );
}

function Medications({ data }: { data: ChartSummary }) {
  return (
    <section className="card">
      <h2>Current Medications</h2>
      {data.medications.length === 0 && <p className="muted">No active medications.</p>}
      {data.medications.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Medicine</th>
              <th>Dose</th>
              <th>Frequency</th>
              <th>Route</th>
              <th>Instructions</th>
            </tr>
          </thead>
          <tbody>
            {data.medications.map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>
                    {m.medicationName} {m.strength}
                  </strong>
                </td>
                <td>{m.dose}</td>
                <td>{m.frequency}</td>
                <td>{m.route}</td>
                <td>{m.instructions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function DocumentList({ docs }: { docs: ChartSummary['documents'] }) {
  if (docs.length === 0) return <p className="muted">No documents yet.</p>;
  return (
    <table>
      <tbody>
        {docs.map((d) => (
          <tr key={d.id}>
            <td>
              {DOC_LABEL[d.type]} · {formatDate(d.createdAt.slice(0, 10), false)}
              {d.version > 1 ? ` (v${d.version})` : ''}
            </td>
            <td className="muted">{d.signedAt ? 'Signed PDF' : 'Draft'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Documents({ data }: { data: ChartSummary }) {
  return (
    <section className="card">
      <div className="row between">
        <h2>Documents</h2>
        <a href="#/documents">Open document requests</a>
      </div>
      <DocumentList docs={data.documents} />
    </section>
  );
}
