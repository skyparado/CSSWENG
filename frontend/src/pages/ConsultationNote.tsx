import { useCallback, useEffect, useRef, useState } from 'react';
import { EXAM_FIELDS, ExamFindingSchema, type ComparisonResponse } from '@clinic/schemas';
import {
  ClinicalApiError,
  clinicalApi,
  ENCOUNTER_LABEL,
  formatDate,
  fullName,
  type ChartSummary,
  type Diagnosis,
  type Encounter,
  type Eye,
  type Finding,
  type Note,
  type NoteContent,
} from '../clinicalApi';
import { go, useSession } from '../session';
import { AllergyBanner, Crumbs, patientLine } from './PatientParts';

type FieldKey = keyof typeof EXAM_FIELDS;
const FIELDS = Object.keys(EXAM_FIELDS) as FieldKey[];
const EYES: Array<Exclude<Eye, 'OU'>> = ['OD', 'OS'];
const AUTOSAVE_MS = 1500;

type Draft = Pick<NoteContent, 'subjective' | 'assessment' | 'plan' | 'diagnosisItems'>;
const EMPTY_DRAFT: Draft = { subjective: null, assessment: null, plan: null, diagnosisItems: [] };

const cellKey = (field: string, eye: string) => `${field}:${eye}`;
const defaultUnit = (field: FieldKey) => EXAM_FIELDS[field].units[0] ?? null;

/** Previous visit's value for each field and eye, from the comparison endpoint. */
function previousValues(cmp: ComparisonResponse | undefined, visitDate: string) {
  const out = new Map<string, string>();
  let date: string | undefined;
  if (!cmp) return { values: out, date };
  const before = cmp.columns.map((c, i) => ({ ...c, i })).filter((c) => c.date < visitDate);
  for (const row of cmp.rows) {
    for (let k = before.length - 1; k >= 0; k--) {
      const cell = row.cells[before[k]!.i];
      if (cell) {
        out.set(cellKey(row.name, row.eye ?? ''), cell.value);
        if (!date || before[k]!.date > date) date = before[k]!.date;
        break;
      }
    }
  }
  return { values: out, date };
}

/** S07 Consultation Note and Examination Findings (Doctor only). */
export default function ConsultationNote({ patientId, encounterId }: { patientId: string; encounterId: string }) {
  const { user, clinic } = useSession();
  const [summary, setSummary] = useState<ChartSummary>();
  const [encounter, setEncounter] = useState<Encounter>();
  const [note, setNote] = useState<Note | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [findings, setFindings] = useState<Map<string, Finding>>(new Map());
  const [cells, setCells] = useState<Record<string, { value: string; unit: string | null }>>({});
  const [cellErrors, setCellErrors] = useState<Record<string, string>>({});
  const [previous, setPrevious] = useState<{ values: Map<string, string>; date?: string }>({ values: new Map() });
  const [saveState, setSaveState] = useState<{ at?: Date; saving?: boolean; error?: string }>({});
  const [confirming, setConfirming] = useState(false);
  const [loadError, setLoadError] = useState<string>();

  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const saving = useRef<Promise<Note | null>>(Promise.resolve(null));
  const latest = useRef({ draft, note });
  latest.current = { draft, note };

  const load = useCallback(async () => {
    const [s, enc, f] = await Promise.all([
      clinicalApi.summary(patientId),
      clinicalApi.encounter(encounterId),
      clinicalApi.findings(encounterId),
    ]);
    const cmp = await clinicalApi.comparison(patientId, { show: 'exam', currentEncounterId: encounterId }).catch(() => undefined);
    setSummary(s);
    setEncounter(enc);
    setNote(enc.note ?? null);
    if (enc.note) {
      const { subjective, assessment, plan, diagnosisItems } = enc.note;
      setDraft({ subjective, assessment, plan, diagnosisItems });
    }
    const current = new Map(f.items.filter((x) => !x.superseded).map((x) => [cellKey(x.fieldName, x.eye), x]));
    setFindings(current);
    const initial: Record<string, { value: string; unit: string | null }> = {};
    for (const field of FIELDS)
      for (const eye of EYES) {
        const x = current.get(cellKey(field, eye));
        initial[cellKey(field, eye)] = { value: x?.valueText ?? '', unit: x?.unit ?? defaultUnit(field) };
      }
    setCells(initial);
    setPrevious(previousValues(cmp, enc.visitDate));
  }, [patientId, encounterId]);

  useEffect(() => {
    load().catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [load]);

  /** Save the whole draft (the server replaces it). Calls are chained so versions stay in order. */
  const saveDraft = useCallback((): Promise<Note | null> => {
    clearTimeout(timer.current);
    if (!dirty.current) return saving.current;
    dirty.current = false;
    saving.current = saving.current.then(async () => {
      const { draft: d, note: n } = latest.current;
      setSaveState((s) => ({ ...s, saving: true, error: undefined }));
      try {
        const saved = await clinicalApi.saveDraft(encounterId, { ...d, version: n?.version });
        latest.current.note = saved;
        setNote(saved);
        setSaveState({ at: new Date() });
        return saved;
      } catch (err) {
        const msg =
          err instanceof ClinicalApiError && err.status === 409
            ? 'This note was changed elsewhere. Reload to see the latest version before editing.'
            : err instanceof Error
              ? err.message
              : String(err);
        setSaveState({ error: msg });
        return null;
      }
    });
    return saving.current;
  }, [encounterId]);

  const edit = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    dirty.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveDraft(), AUTOSAVE_MS);
  };

  // Save anything pending when leaving the screen.
  useEffect(() => () => void saveDraft(), [saveDraft]);

  if (user.role !== 'DOCTOR') return <p>Only the doctor can write consultation notes.</p>;
  if (loadError) return <p className="error">{loadError}</p>;
  if (!summary || !encounter) return <p>Loading…</p>;

  const p = summary.patient;
  const signed = note?.status === 'SIGNED';
  const locked = signed || encounter.status === 'SIGNED';

  /** Save one examination cell when the doctor leaves it. Empty removes the finding. */
  const saveCell = async (field: FieldKey, eye: Exclude<Eye, 'OU'>) => {
    const key = cellKey(field, eye);
    const cell = cells[key]!;
    const existing = findings.get(key);
    const value = cell.value.trim();
    if (value === (existing?.valueText ?? '') && (cell.unit ?? null) === (existing?.unit ?? defaultUnit(field))) return;

    const body = { eye, fieldName: field, valueText: value, unit: cell.unit };
    try {
      if (!value) {
        if (existing) await clinicalApi.deleteFinding(encounterId, existing.id);
        findings.delete(key);
      } else {
        const check = ExamFindingSchema.safeParse(body);
        if (!check.success) throw new Error(check.error.issues[0]?.message ?? 'Invalid value');
        const saved = existing
          ? await clinicalApi.replaceFinding(encounterId, existing.id, body)
          : await clinicalApi.addFinding(encounterId, body);
        findings.set(key, saved);
      }
      setFindings(new Map(findings));
      setCellErrors(({ [key]: _gone, ...rest }) => rest);
    } catch (err) {
      setCellErrors((e) => ({ ...e, [key]: err instanceof Error ? err.message : String(err) }));
    }
  };

  const sign = async () => {
    setConfirming(false);
    dirty.current = true; // make sure the note exists and the version is current
    const saved = await saveDraft();
    if (!saved) return;
    try {
      const done = await clinicalApi.signNote(encounterId, saved.version);
      setNote(done);
      setEncounter({ ...encounter, status: 'SIGNED' });
    } catch (err) {
      setSaveState({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  const changed = (key: string, value: string) => {
    const prev = previous.values.get(key);
    return Boolean(prev && value && prev !== value);
  };

  return (
    <>
      <Crumbs
        items={[
          { label: 'Patients', href: '#/patients' },
          { label: fullName(p), href: `#/patients/${p.id}` },
          { label: signed ? 'Consultation Note' : 'New Consultation Note' },
        ]}
      />
      <section className="card patient-head">
        <h1 className="grow">{fullName(p)}</h1>
        <span className="muted">
          {patientLine(p).split(' · ').slice(0, 2).join(' · ')} · Visit: {formatDate(encounter.visitDate)} ·{' '}
          {ENCOUNTER_LABEL[encounter.type]} · {clinic?.name}
        </span>
        <span className={`badge ${signed ? 'ok' : 'warn'}`}>{signed ? 'Signed' : 'Draft'}</span>
      </section>
      <AllergyBanner allergies={summary.allergies} />

      <div className="note-grid">
        <div className="stack">
          <section className="card">
            <h2>Subjective · Chief Complaint and History</h2>
            {locked ? (
              <p className="pre">{note?.subjective || <span className="muted">Not recorded.</span>}</p>
            ) : (
              <>
                <label htmlFor="subjective" className="sr-only">
                  Subjective
                </label>
                <textarea
                  id="subjective"
                  rows={4}
                  value={draft.subjective ?? ''}
                  onChange={(e) => edit({ subjective: e.target.value })}
                />
              </>
            )}
          </section>

          <section className="card">
            <div className="row between">
              <h2>Objective · Examination Findings</h2>
              <a href={`#/patients/${p.id}/compare?current=${encounterId}`}>Compare with previous</a>
            </div>
            <table className="findings">
              <thead>
                <tr>
                  <th>Finding</th>
                  <th>OD (right eye)</th>
                  <th>OS (left eye)</th>
                  <th>Previous{previous.date ? ` · ${formatDate(previous.date, false)}` : ''}</th>
                </tr>
              </thead>
              <tbody>
                {FIELDS.map((field) => {
                  const def = EXAM_FIELDS[field];
                  return (
                    <tr key={field}>
                      <th scope="row">
                        {def.label}
                        {def.units.length > 1 && !locked && (
                          <select
                            aria-label={`${def.label} unit`}
                            className="unit"
                            value={cells[cellKey(field, 'OD')]?.unit ?? ''}
                            onChange={(e) =>
                              setCells((c) => {
                                const next = { ...c };
                                for (const eye of EYES) next[cellKey(field, eye)] = { ...next[cellKey(field, eye)]!, unit: e.target.value };
                                return next;
                              })
                            }
                          >
                            {def.units.map((u) => (
                              <option key={u}>{u}</option>
                            ))}
                          </select>
                        )}
                      </th>
                      {EYES.map((eye) => {
                        const key = cellKey(field, eye);
                        const cell = cells[key] ?? { value: '', unit: null };
                        return (
                          <td key={eye}>
                            {locked ? (
                              <span className={changed(key, findings.get(key)?.valueText ?? '') ? 'changed' : ''}>
                                {findings.get(key)?.valueText ?? '—'}
                              </span>
                            ) : (
                              <>
                                <input
                                  aria-label={`${def.label} ${eye}`}
                                  className={changed(key, cell.value) ? 'changed' : ''}
                                  value={cell.value}
                                  onChange={(e) => setCells((c) => ({ ...c, [key]: { ...cell, value: e.target.value } }))}
                                  onBlur={() => void saveCell(field, eye)}
                                  aria-invalid={Boolean(cellErrors[key])}
                                />
                                {def.units.length === 1 && <span className="muted small"> {def.units[0]}</span>}
                                {cellErrors[key] && <p className="error field-error">{cellErrors[key]}</p>}
                              </>
                            )}
                          </td>
                        );
                      })}
                      <td className="muted">
                        {EYES.map((eye) => previous.values.get(cellKey(field, eye)) ?? '—').join(' · ')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="muted small">Values that changed from the previous visit are highlighted in red.</p>
          </section>

          <section className="card">
            <h2>Assessment and Plan</h2>
            <Diagnoses
              items={locked ? (note?.diagnosisItems ?? []) : draft.diagnosisItems}
              locked={locked}
              onChange={(diagnosisItems) => edit({ diagnosisItems })}
            />
            <label htmlFor="assessment">Assessment</label>
            {locked ? (
              <p className="pre">{note?.assessment || <span className="muted">Not recorded.</span>}</p>
            ) : (
              <textarea id="assessment" rows={2} value={draft.assessment ?? ''} onChange={(e) => edit({ assessment: e.target.value })} />
            )}
            <label htmlFor="plan">Plan</label>
            {locked ? (
              <p className="pre">{note?.plan || <span className="muted">Not recorded.</span>}</p>
            ) : (
              <textarea id="plan" rows={3} value={draft.plan ?? ''} onChange={(e) => edit({ plan: e.target.value })} />
            )}
          </section>

          {signed && note && <Addenda note={note} encounterId={encounterId} onAdded={(a) => setNote({ ...note, addenda: [...note.addenda, a] })} />}
        </div>

        <div className="stack">
          <FollowUpCard patientId={p.id} clinicId={clinic!.id} existing={summary.followUps} />
        </div>
      </div>

      <div className="footer-bar sticky">
        <div className="grow">
          {saveState.error ? (
            <span className="error" role="alert">
              {saveState.error}
            </span>
          ) : signed ? (
            <span>
              Signed {note?.signedAt ? new Date(note.signedAt).toLocaleString('en-PH') : ''}
              {note?.integrity === 'MISMATCH' && <strong className="error"> · Content does not match its signature</strong>}
            </span>
          ) : (
            <span className="muted" aria-live="polite">
              Draft · {saveState.saving ? 'saving…' : saveState.at ? `saved automatically at ${saveState.at.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })}` : 'not saved yet'}
            </span>
          )}
          <div className="muted small">Once signed, the note is locked. Later corrections are added as dated addenda.</div>
        </div>
        {!signed && (
          <>
            <button type="button" onClick={() => go(`/patients/${p.id}`)}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                dirty.current = true;
                void saveDraft();
              }}
            >
              Save Draft
            </button>
            <button type="button" className="primary" onClick={() => setConfirming(true)}>
              Sign and Lock Note
            </button>
          </>
        )}
        {signed && (
          <button type="button" onClick={() => go(`/patients/${p.id}`)}>
            Back to Chart
          </button>
        )}
      </div>

      {confirming && (
        <div className="backdrop" role="presentation">
          <div className="card dialog" role="dialog" aria-modal="true" aria-labelledby="sign-title">
            <h2 id="sign-title">Sign and lock this note?</h2>
            <p>After signing, the note and this visit's findings can no longer be edited. Corrections are added as dated addenda.</p>
            <div className="footer-bar">
              <button type="button" onClick={() => setConfirming(false)}>
                Keep editing
              </button>
              <button type="button" className="primary" onClick={() => void sign()}>
                Sign and Lock
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Diagnoses({ items, locked, onChange }: { items: Diagnosis[]; locked: boolean; onChange: (d: Diagnosis[]) => void }) {
  const [adding, setAdding] = useState('');
  return (
    <div className="row diagnoses">
      <strong>Diagnosis</strong>
      {items.length === 0 && locked && <span className="muted">None recorded.</span>}
      {items.map((d, i) => (
        <span key={`${d.label}-${i}`} className="chip">
          {d.label}
          {d.eye ? `, ${d.eye}` : ''}
          {!locked && (
            <button type="button" className="chip-x" aria-label={`Remove ${d.label}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
              ×
            </button>
          )}
        </span>
      ))}
      {!locked && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (adding.trim()) onChange([...items, { label: adding.trim() }]);
            setAdding('');
          }}
        >
          <label htmlFor="new-diagnosis" className="sr-only">
            Add diagnosis
          </label>
          <input id="new-diagnosis" placeholder="Add diagnosis" value={adding} onChange={(e) => setAdding(e.target.value)} />
          <button type="submit">+ Add diagnosis</button>
        </form>
      )}
    </div>
  );
}

function Addenda({ note, encounterId, onAdded }: { note: Note; encounterId: string; onAdded: (a: Note['addenda'][number]) => void }) {
  const [reason, setReason] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setError(undefined);
    if (!reason.trim() || !text.trim()) return setError('Give a reason and write what is being added or corrected.');
    setBusy(true);
    try {
      onAdded(await clinicalApi.addAddendum(encounterId, { addendumReason: reason.trim(), plan: text.trim() }));
      setReason('');
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Addenda</h2>
      {note.addenda.length === 0 && <p className="muted">No addenda.</p>}
      <ol className="history">
        {note.addenda.map((a) => (
          <li key={a.id}>
            <strong>{a.signedAt ? new Date(a.signedAt).toLocaleString('en-PH') : ''}</strong> · {a.addendumReason}
            {[a.subjective, a.objective, a.assessment, a.plan].filter(Boolean).map((t, i) => (
              <p key={i} className="pre">
                {t}
              </p>
            ))}
          </li>
        ))}
      </ol>
      <h3>Add a dated addendum</h3>
      <label htmlFor="addendum-reason">Reason for addendum</label>
      <input id="addendum-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Late entry, correction" />
      <label htmlFor="addendum-text">Addendum</label>
      <textarea id="addendum-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      {error && <p className="error">{error}</p>}
      <div className="footer-bar">
        <button type="button" className="primary" disabled={busy} onClick={() => void add()}>
          Sign Addendum
        </button>
      </div>
    </section>
  );
}

const RETURN_IN = [
  { weeks: 1, label: '1 week' },
  { weeks: 2, label: '2 weeks' },
  { weeks: 4, label: '4 weeks' },
  { weeks: 8, label: '2 months' },
  { weeks: 12, label: '3 months' },
  { weeks: 26, label: '6 months' },
];
const TASK_TYPES = [
  { value: 'FOLLOW_UP', label: 'Follow-up visit' },
  { value: 'CHECK_UP', label: 'Check-up' },
  { value: 'LAB_TEST', label: 'Laboratory test' },
  { value: 'INJECTION', label: 'Injection' },
  { value: 'PROCEDURE', label: 'Procedure' },
];

const addWeeks = (weeks: number) => {
  const d = new Date();
  d.setDate(d.getDate() + weeks * 7);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
};

function FollowUpCard({ patientId, clinicId, existing }: { patientId: string; clinicId: string; existing: ChartSummary['followUps'] }) {
  const [weeks, setWeeks] = useState(4);
  const [dueDate, setDueDate] = useState(addWeeks(4));
  const [taskType, setTaskType] = useState('FOLLOW_UP');
  const [reason, setReason] = useState('');
  const [added, setAdded] = useState<Array<{ dueDate: string; reason: string }>>([]);
  const [error, setError] = useState<string>();

  const add = async () => {
    setError(undefined);
    if (!reason.trim()) return setError('Give a reason, e.g. “Follow-up with OCT results”.');
    try {
      await clinicalApi.createFollowUp({ patientId, clinicId, taskType, reason: reason.trim(), dueDate });
      setAdded([...added, { dueDate, reason: reason.trim() }]);
      setReason('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const list = [...existing.map((f) => ({ dueDate: f.dueDate, reason: f.reason })), ...added];
  return (
    <section className="card">
      <h2>Follow-Up and Procedures</h2>
      <div className="grid2">
        <div>
          <label htmlFor="return-in">Return in</label>
          <select
            id="return-in"
            value={weeks}
            onChange={(e) => {
              setWeeks(Number(e.target.value));
              setDueDate(addWeeks(Number(e.target.value)));
            }}
          >
            {RETURN_IN.map((r) => (
              <option key={r.weeks} value={r.weeks}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="due-date">Due date</label>
          <input id="due-date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
      </div>
      <label htmlFor="task-type">Type</label>
      <select id="task-type" value={taskType} onChange={(e) => setTaskType(e.target.value)}>
        {TASK_TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
      <label htmlFor="follow-reason">Follow-up reason</label>
      <input id="follow-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      {error && <p className="error">{error}</p>}
      <button type="button" className="link" onClick={() => void add()}>
        + Add follow-up
      </button>
      {list.length > 0 && (
        <ul className="plain">
          {list.map((f, i) => (
            <li key={i}>
              <strong>{formatDate(f.dueDate, false)}</strong> · {f.reason}
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">The secretary will see this in the follow-up list for reminders.</p>
    </section>
  );
}
