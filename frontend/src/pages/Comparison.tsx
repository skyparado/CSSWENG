import { useState } from 'react';
import { EXAM_FIELDS, LAB_TESTS, type ComparisonCell, type ComparisonRow } from '@clinic/schemas';
import { clinicalApi, formatDate, fullName } from '../clinicalApi';
import { go, useLoad, useSession } from '../session';
import { AllergyBanner, Crumbs, PatientHeader } from './PatientParts';
import TrendChart from './TrendChart';

type Show = 'exam' | 'lab' | 'both';
const SHOW_LABEL: Record<Show, string> = { both: 'Exam findings and labs', exam: 'Exam findings only', lab: 'Lab results only' };
const DEFAULT_FIELDS = ['VA', 'IOP'];

/** "+2 mmHg", "−0.4 %", "No change". Differences are shown, never interpreted. */
function changeText(row: ComparisonRow): string {
  // Only rows with two or more numeric values have a change to show.
  const last = [...row.cells].reverse().find((c) => c?.change !== null && c?.change !== undefined);
  if (!last || last.change === null) return '—';
  if (last.change === 0) return 'No change';
  const sign = last.change > 0 ? '+' : '−';
  return `${sign}${Math.abs(last.change)} ${row.unit ?? ''}`.trim();
}

function Cell({ cell }: { cell: ComparisonCell | null }) {
  if (!cell) return <span className="muted">—</span>;
  return (
    <>
      <span title={cell.method ?? undefined}>{cell.value}</span>
      {cell.flag && <span className="badge bad tag">{cell.flag === 'HIGH' ? 'High' : 'Low'}</span>}
      {cell.amended && (
        <span className="badge bad tag" title={cell.originalValue ? `Before correction: ${cell.originalValue}` : undefined}>
          Amended
        </span>
      )}
    </>
  );
}

/** S08 Laboratory and Examination Comparison (Doctor only). */
export default function Comparison({ patientId, currentEncounterId }: { patientId: string; currentEncounterId?: string }) {
  const { user, clinic } = useSession();
  const [show, setShow] = useState<Show>('both');
  const [fields, setFields] = useState<string[]>(DEFAULT_FIELDS);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [applied, setApplied] = useState({ show, fields, from, to });
  const [addingLab, setAddingLab] = useState(false);

  const summary = useLoad(() => clinicalApi.summary(patientId), [patientId]);
  const cmp = useLoad(
    () =>
      clinicalApi.comparison(patientId, {
        show: applied.show,
        fields: applied.fields.length ? applied.fields.join(',') : undefined,
        from: applied.from || undefined,
        to: applied.to || undefined,
        currentEncounterId,
      }),
    [patientId, applied, currentEncounterId],
  );

  if (user.role !== 'DOCTOR') return <p>Only the doctor can compare results.</p>;
  if (summary.error) return <p className="error">{summary.error}</p>;
  if (!summary.data) return <p>Loading…</p>;
  const p = summary.data.patient;
  const data = cmp.data;

  const toggleField = (f: string) => setFields(fields.includes(f) ? fields.filter((x) => x !== f) : [...fields, f]);

  // One chart per unit, so mmHg and logMAR never share an axis.
  const groups = new Map<string, NonNullable<typeof data>['chart']['series']>();
  for (const s of data?.chart.series ?? []) {
    const key = `${s.kind}:${s.unit}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }

  return (
    <>
      <Crumbs
        items={[
          { label: 'Patients', href: '#/patients' },
          { label: fullName(p), href: `#/patients/${p.id}` },
          { label: 'Compare Results' },
        ]}
      />
      <h1>Laboratory and Examination Comparison</h1>
      <PatientHeader patient={p} extra={clinic?.name}>
        <button onClick={() => go(`/patients/${p.id}`)}>Back to Chart</button>
        <button className="primary" onClick={() => setAddingLab(true)}>
          + Add Lab Result
        </button>
      </PatientHeader>
      <AllergyBanner allergies={summary.data.allergies} />

      <form
        className="card filters"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({ show, fields, from, to });
        }}
      >
        <div>
          <label htmlFor="show">Show</label>
          <select id="show" value={show} onChange={(e) => setShow(e.target.value as Show)}>
            {(Object.keys(SHOW_LABEL) as Show[]).map((s) => (
              <option key={s} value={s}>
                {SHOW_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <fieldset disabled={show === 'lab'}>
          <legend>Fields</legend>
          <div className="row">
            {Object.entries(EXAM_FIELDS).map(([key, def]) => (
              <button key={key} type="button" className="chip-toggle" aria-pressed={fields.includes(key)} onClick={() => toggleField(key)}>
                {def.label}
              </button>
            ))}
          </div>
        </fieldset>
        <div>
          <label htmlFor="from">From</label>
          <input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label htmlFor="to">To</label>
          <input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <button className="primary">Compare</button>
      </form>

      {cmp.error && <p className="error">{cmp.error}</p>}
      {!data && !cmp.error && <p>Loading…</p>}
      {data && (
        <div className="compare-grid">
          <section className="card scroll-x">
            {data.rows.length === 0 ? (
              <p className="muted">Nothing recorded for these filters.</p>
            ) : (
              <table className="compare">
                <thead>
                  <tr>
                    <th>Field / eye</th>
                    {data.columns.map((c) => (
                      <th key={c.date} className={c.isCurrent ? 'current' : ''}>
                        {formatDate(c.date, false)}
                        {c.isCurrent ? ' (current)' : ''}
                      </th>
                    ))}
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.key}>
                      <th scope="row">
                        {row.label}
                        {row.eye ? `, ${row.eye}` : ''}
                        <div className="muted small">
                          {row.kind === 'LAB' ? 'Lab' : 'Exam'}
                          {row.unit ? ` · ${row.unit}` : ''}
                          {row.unitDiffers && <span className="badge bad tag">Unit differs</span>}
                        </div>
                      </th>
                      {row.cells.map((cell, i) => (
                        <td key={data.columns[i]!.date} className={data.columns[i]!.isCurrent ? 'current' : ''}>
                          <Cell cell={cell} />
                        </td>
                      ))}
                      <td>{changeText(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <div className="stack">
            {[...groups.entries()].map(([key, series]) => (
              <section className="card" key={key}>
                <h2>
                  {[...new Set(series.map((s) => s.name.replace(/ (OD|OS|OU)$/, '')))].join(', ')} trend ({series[0]!.unit})
                </h2>
                <TrendChart chart={data.chart} series={series} label={`${series[0]!.name} trend`} />
              </section>
            ))}
            <section className="card legend">
              <h2>Legend</h2>
              <dl>
                <dt>
                  <span className="badge bad tag">High</span>
                </dt>
                <dd>Outside the reference range</dd>
                <dt>
                  <span className="badge bad tag">Amended</span>
                </dt>
                <dd>Corrected after signing; original kept</dd>
                <dt>
                  <span className="badge bad tag">Unit differs</span>
                </dt>
                <dd>Shown separately, not converted</dd>
              </dl>
            </section>
          </div>
        </div>
      )}
      <p className="muted small">
        Every value is shown with its date, unit and method. Signed values are locked; corrections are amendments. Every view is recorded in the
        audit log.
      </p>

      {addingLab && (
        <AddLabResult
          patientId={p.id}
          onClose={(saved) => {
            setAddingLab(false);
            if (saved) cmp.reload();
          }}
        />
      )}
    </>
  );
}

function AddLabResult({ patientId, onClose }: { patientId: string; onClose: (saved: boolean) => void }) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const [form, setForm] = useState({
    testName: LAB_TESTS[0]!.name,
    resultValue: '',
    resultUnit: LAB_TESTS[0]!.units[0]!,
    referenceRange: '',
    collectionDate: today,
    laboratoryName: '',
  });
  const [error, setError] = useState<string>();
  const units = LAB_TESTS.find((t) => t.name === form.testName)?.units ?? [];
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  const save = async () => {
    setError(undefined);
    try {
      await clinicalApi.addLabResult({ patientId, ...form, referenceRange: form.referenceRange || null });
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="backdrop" role="presentation">
      <form
        className="card dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lab-title"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 id="lab-title">Add Lab Result</h2>
        <label htmlFor="lab-test">Test</label>
        <select
          id="lab-test"
          value={form.testName}
          onChange={(e) => {
            const def = LAB_TESTS.find((t) => t.name === e.target.value)!;
            setForm({ ...form, testName: def.name, resultUnit: def.units[0]! });
          }}
        >
          {LAB_TESTS.map((t) => (
            <option key={t.name}>{t.name}</option>
          ))}
        </select>
        <div className="grid2">
          <div>
            <label htmlFor="lab-value">Result</label>
            <input id="lab-value" value={form.resultValue} onChange={set('resultValue')} required />
          </div>
          <div>
            <label htmlFor="lab-unit">Unit</label>
            <select id="lab-unit" value={form.resultUnit} onChange={set('resultUnit')}>
              {units.map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </div>
        </div>
        <label htmlFor="lab-range">Reference range</label>
        <input id="lab-range" value={form.referenceRange} onChange={set('referenceRange')} placeholder="e.g. 4.0-5.6" />
        <div className="grid2">
          <div>
            <label htmlFor="lab-date">Collection date</label>
            <input id="lab-date" type="date" max={today} value={form.collectionDate} onChange={set('collectionDate')} required />
          </div>
          <div>
            <label htmlFor="lab-name">Laboratory</label>
            <input id="lab-name" value={form.laboratoryName} onChange={set('laboratoryName')} required />
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="footer-bar">
          <button type="button" onClick={() => onClose(false)}>
            Cancel
          </button>
          <button className="primary">Save Result</button>
        </div>
      </form>
    </div>
  );
}
