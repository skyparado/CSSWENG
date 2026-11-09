import { useState, type FormEvent } from 'react';
import {
  ApiError,
  api,
  patientName,
  type Allergy,
  type Medication,
  type MedicationInput,
  type MedicationSource,
  type MedicationStatus,
  type SafetyAlert,
} from '../api';
import PatientPicker from '../PatientPicker';
import { go, useLoad, useSession } from '../session';
import { zonedParts } from '../time';

const STATUS_LABEL: Record<MedicationStatus, string> = { ACTIVE: 'Active', ON_HOLD: 'On hold', DISCONTINUED: 'Stopped' };
const STATUS_TONE: Record<MedicationStatus, string> = { ACTIVE: 'ok', ON_HOLD: 'warn', DISCONTINUED: '' };
const SOURCE_LABEL: Record<MedicationSource, string> = {
  PRESCRIBED_HERE: 'Prescribed here',
  PATIENT_REPORTED: 'Patient reported',
  OTHER_DOCTOR: 'Other doctor',
  OTC: 'Over the counter',
};
const SEVERITY_LABEL = { MILD: 'Mild', MODERATE: 'Moderate', SEVERE: 'Severe' } as const;

type Filter = 'ALL' | MedicationStatus;

/** Patient id from "#/patients/<id>/medications". */
export const patientIdFromMedicationsRoute = (route: string) => /^\/patients\/([^/?]+)\/medications/.exec(route)?.[1];

/** What changed between two versions of one medication, for the history list. */
function describeChange(now: Medication, before?: Medication): string {
  if (!before) return `${now.medicationName} started`;
  if (before.status !== now.status) {
    if (now.status === 'DISCONTINUED') return `${now.medicationName} stopped${now.discontinuationReason ? `: ${now.discontinuationReason}` : ''}`;
    if (now.status === 'ON_HOLD') return `${now.medicationName} put on hold`;
    return `${now.medicationName} resumed`;
  }
  const changes: string[] = [];
  if (before.dose !== now.dose) changes.push(`dose changed from ${before.dose} to ${now.dose}`);
  if (before.frequency !== now.frequency) changes.push(`frequency changed from ${before.frequency} to ${now.frequency}`);
  if (before.medicationName !== now.medicationName) changes.push(`renamed from ${before.medicationName}`);
  return `${now.medicationName} ${changes.join(', ') || 'updated'}`;
}

/** S10 Medications and Allergies: the current list, allergies, safety alerts and dated history. Doctor only. */
export default function Medications({ patientId }: { patientId: string }) {
  const { user, clinic } = useSession();
  const today = zonedParts(new Date(), clinic!.timezone).date;

  const patient = useLoad(() => api.patient(patientId), [patientId]);
  const meds = useLoad(() => api.medicationList(patientId), [patientId]);
  const history = useLoad(() => api.medicationList(patientId, true), [patientId]);
  const allergies = useLoad(() => api.allergies(patientId), [patientId]);

  const [filter, setFilter] = useState<Filter>('ALL');
  const [editing, setEditing] = useState<Medication | 'new'>();
  const [addingAllergy, setAddingAllergy] = useState(false);
  const [removing, setRemoving] = useState<Allergy>();
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [notice, setNotice] = useState<string>();

  const reloadAll = () => {
    meds.reload();
    history.reload();
    allergies.reload();
  };

  if (patient.error) return <p className="error">{patient.error}</p>;
  if (!patient.data || !meds.data || !allergies.data) return <p>Loading…</p>;

  const p = patient.data;
  const items = meds.data.items;
  const count = (s: Filter) => (s === 'ALL' ? items.length : items.filter((m) => m.status === s).length);
  const shown = items.filter((m) => filter === 'ALL' || m.status === filter);

  const byId = new Map((history.data?.items ?? []).map((m) => [m.id, m]));
  const events = [...(history.data?.items ?? [])]
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
    .map((m) => ({ id: m.id, at: m.recordedAt, text: describeChange(m, m.supersedesMedicationId ? byId.get(m.supersedesMedicationId) : undefined), by: m.prescribingDoctor }));
  const eventsShown = showAllHistory ? events : events.slice(0, 3);
  const fmt = (iso: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: clinic!.timezone }).format(new Date(iso));

  return (
    <>
      <p className="muted">
        <a href="#/patients">Patients</a> › {patientName(p)} › Medications and Allergies
      </p>

      <section className="card row" style={{ justifyContent: 'space-between', marginBottom: 16 }} aria-label="Patient">
        <div className="row">
          <span className="avatar" aria-hidden>{(p.firstName[0] ?? '') + (p.lastName[0] ?? '')}</span>
          <div>
            <h1 style={{ fontSize: 24 }}>{patientName(p)}</h1>
            <span className="muted">
              {[p.patientNumber, p.age !== undefined ? `${p.age} y/o ${p.sex?.[0] ?? ''}` : '', p.mobileNumber, p.hmoProvider ? `HMO: ${p.hmoProvider}` : '']
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
        </div>
        <button className="primary" onClick={() => setEditing('new')}>
          + Add Medication
        </button>
      </section>

      {allergies.data.items.length > 0 && (
        <p className="alert" role="alert" style={{ marginBottom: 16 }}>
          ⚠ ALLERGY: {allergies.data.items.map((a) => `${a.allergenName}${a.reaction ? ` (${a.reaction}${a.severity ? `, ${SEVERITY_LABEL[a.severity].toLowerCase()}` : ''})` : ''}`).join(' · ')}
        </p>
      )}
      {notice && (
        <p className="notice" role="status" style={{ marginBottom: 16 }}>
          {notice}
        </p>
      )}

      <div className="split-wide">
        <div className="stack">
          <section className="card" aria-label="Medications">
            <h2>Medications</h2>
            <div className="pills" role="group" aria-label="Filter by status" style={{ margin: '0 0 12px' }}>
              {(['ALL', 'ACTIVE', 'ON_HOLD', 'DISCONTINUED'] as const).map((f) => (
                <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {f === 'ALL' ? 'All' : STATUS_LABEL[f]} {count(f)}
                </button>
              ))}
            </div>
            {shown.length === 0 ? (
              <p className="muted">No medications in this view.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Medication</th>
                    <th>Dose and frequency</th>
                    <th>Source</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((m) => (
                    <tr key={m.id} data-testid="medication-row">
                      <td>
                        <strong>
                          {m.medicationName}
                          {m.strength ? ` ${m.strength}` : ''}
                        </strong>
                        <br />
                        <span className="muted">{m.indication}</span>
                      </td>
                      <td>
                        {m.dose}, {m.frequency}
                      </td>
                      <td>{SOURCE_LABEL[m.source]}</td>
                      <td>
                        <span className={`badge ${STATUS_TONE[m.status]}`}>{STATUS_LABEL[m.status]}</span>
                        {m.status === 'DISCONTINUED' && m.discontinuationReason && (
                          <>
                            <br />
                            <span className="muted">Reason: {m.discontinuationReason}</span>
                          </>
                        )}
                      </td>
                      <td>
                        <button aria-label={`Update ${m.medicationName}`} onClick={() => setEditing(m)}>
                          Update
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="card" aria-label="Medication history">
            <h2>Medication history</h2>
            {events.length === 0 && <p className="muted">Nothing recorded yet.</p>}
            <ul className="history" style={{ fontSize: 16 }}>
              {eventsShown.map((e) => (
                <li key={e.id}>
                  <strong>{fmt(e.at)}</strong>
                  <br />
                  {e.text} · {e.by}
                </li>
              ))}
            </ul>
            {events.length > 3 && (
              <button style={{ border: 0, padding: 0 }} onClick={() => setShowAllHistory(!showAllHistory)}>
                {showAllHistory ? 'Show less' : 'View full history'}
              </button>
            )}
          </section>
        </div>

        <aside className="stack">
          <section className="card" aria-label="Allergies">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>Allergies</h2>
              <button onClick={() => setAddingAllergy(true)}>+ Add Allergy</button>
            </div>
            {allergies.data.items.length === 0 && <p className="muted">No allergies recorded.</p>}
            {allergies.data.items.map((a) => (
              <div key={a.id} className="allergy" data-testid="allergy-row">
                <strong>{a.allergenName}</strong>
                <br />
                <span className="muted">
                  Reaction: {a.reaction || 'not recorded'}
                  {a.severity ? '' : ' · Severity not recorded'}
                </span>
                {a.severity && (
                  <div>
                    <span className={`badge ${a.severity === 'SEVERE' ? 'bad' : 'warn'}`}>{SEVERITY_LABEL[a.severity]}</span>
                  </div>
                )}
                <button style={{ border: 0, padding: 0, fontSize: 14 }} onClick={() => setRemoving(a)} aria-label={`Remove ${a.allergenName}`}>
                  Remove
                </button>
              </div>
            ))}
          </section>
        </aside>
      </div>

      <p className="muted" style={{ marginTop: 16 }}>
        Medication changes keep the earlier entry in the history. Every change is recorded in the audit log.
      </p>

      {editing && (
        <MedicationDialog
          key={editing === 'new' ? 'new' : editing.id}
          patientId={patientId}
          existing={editing === 'new' ? undefined : editing}
          defaultDoctor={user.fullName}
          today={today}
          onClose={() => setEditing(undefined)}
          onSaved={(msg) => {
            setEditing(undefined);
            setNotice(msg);
            reloadAll();
          }}
        />
      )}
      {addingAllergy && (
        <AllergyDialog
          patientId={patientId}
          onClose={() => setAddingAllergy(false)}
          onSaved={(alerts) => {
            setAddingAllergy(false);
            setNotice(
              alerts.length > 0
                ? `Allergy recorded. Check these current medications: ${alerts.map((a) => a.message).join(' ')}`
                : 'Allergy recorded.',
            );
            reloadAll();
          }}
        />
      )}
      {removing && (
        <RemoveAllergyDialog
          allergy={removing}
          onClose={() => setRemoving(undefined)}
          onDone={() => {
            setRemoving(undefined);
            reloadAll();
          }}
        />
      )}
    </>
  );
}

/** Landing at "#/medications": pick a patient, then go to their S10. */
export function MedicationsLanding() {
  return (
    <>
      <h1>Medications and Allergies</h1>
      <p className="muted">Choose a patient to review or update their medication list.</p>
      <section className="card" style={{ maxWidth: 520 }}>
        <label htmlFor="med-patient">Patient</label>
        <PatientPicker id="med-patient" onChange={(p) => p && go(`/patients/${p.id}/medications`)} />
      </section>
    </>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="backdrop" role="presentation">
      <div className="card dialog wide" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} style={{ border: 0 }}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Add or update a medication. A refused save shows the safety alerts, which the Doctor must acknowledge (FR-5.6.7). */
function MedicationDialog({
  patientId,
  existing,
  defaultDoctor,
  today,
  onClose,
  onSaved,
}: {
  patientId: string;
  existing?: Medication;
  defaultDoctor: string;
  today: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [f, setF] = useState({
    medicationName: existing?.medicationName ?? '',
    strength: existing?.strength ?? '',
    dose: existing?.dose ?? '',
    frequency: existing?.frequency ?? '',
    route: existing?.route ?? '',
    instructions: existing?.instructions ?? '',
    indication: existing?.indication ?? '',
    startDate: existing?.startDate.slice(0, 10) ?? today,
    status: (existing?.status ?? 'ACTIVE') as MedicationStatus,
    discontinuationReason: existing?.discontinuationReason ?? '',
    source: (existing?.source ?? 'PRESCRIBED_HERE') as MedicationSource,
    prescribingDoctor: existing?.prescribingDoctor ?? defaultDoctor,
  });
  const [alerts, setAlerts] = useState<SafetyAlert[]>();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const save = (acknowledge: boolean) => {
    setBusy(true);
    setError(undefined);
    const body: MedicationInput = {
      medicationName: f.medicationName.trim(),
      strength: f.strength.trim() || undefined,
      dose: f.dose.trim(),
      frequency: f.frequency.trim(),
      route: f.route.trim(),
      instructions: f.instructions.trim() || undefined,
      indication: f.indication.trim() || undefined,
      startDate: f.startDate,
      status: f.status,
      discontinuationReason: f.status === 'DISCONTINUED' ? f.discontinuationReason.trim() : undefined,
      prescribingDoctor: f.prescribingDoctor.trim(),
      source: f.source,
      // The specific alerts the Doctor saw, so an allergy added since cannot be waved through.
      ...(acknowledge && alerts
        ? {
            acknowledgedAlerts: alerts.filter((a) => a.relatedId).map((a) => ({ type: a.type, relatedId: a.relatedId as string })),
            acknowledgementReason: reason.trim() || undefined,
          }
        : {}),
    };
    const request = existing ? api.updateMedication(existing.id, body) : api.addMedication({ ...body, patientId });
    request.then(
      (saved) => onSaved(`${saved.medicationName} ${existing ? 'updated' : 'added'}${acknowledge ? ' (safety alerts acknowledged)' : ''}.`),
      (err: Error) => {
        setBusy(false);
        if (err instanceof ApiError && err.details?.alerts?.length) {
          setAlerts(err.details.alerts); // refused until acknowledged
          setReason('');
        } else {
          setError(err.message);
        }
      },
    );
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save(false);
  };

  // The alert replaces the form so it cannot be missed (wireframe S10, item 9).
  if (alerts) {
    const critical = alerts.some((a) => a.severity === 'CRITICAL');
    const title = alerts.every((a) => a.type === 'DUPLICATE_MEDICATION') ? 'Safety alert: duplicate medicine' : alerts.every((a) => a.type === 'ALLERGY_CONFLICT') ? 'Safety alert: allergy conflict' : 'Safety alerts';
    return (
      <Modal title={title} onClose={onClose}>
        <div className={`alert-box${critical ? '' : ' warn'}`} role="alert">
          <h3>{critical ? 'Critical: ' : ''}{existing ? 'You are changing' : 'You are adding'} {f.medicationName}</h3>
          <ul style={{ margin: '4px 0', paddingLeft: 20 }}>
            {alerts.map((a, i) => (
              <li key={i} data-testid="safety-alert">
                {a.message}
              </li>
            ))}
          </ul>
        </div>
        <label htmlFor="ack-reason">Reason (optional)</label>
        <input id="ack-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row" style={{ marginTop: 16 }}>
          <button type="button" onClick={() => setAlerts(undefined)}>
            Go back
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => save(true)}>
            Acknowledge and continue
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={existing ? `Update ${existing.medicationName}` : 'Add Medication'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="grid2">
          <div>
            <label htmlFor="m-name">Medication name</label>
            <input id="m-name" value={f.medicationName} onChange={set('medicationName')} required maxLength={150} />
          </div>
          <div>
            <label htmlFor="m-strength">Strength</label>
            <input id="m-strength" value={f.strength} onChange={set('strength')} maxLength={50} />
          </div>
          <div>
            <label htmlFor="m-dose">Dose</label>
            <input id="m-dose" value={f.dose} onChange={set('dose')} required maxLength={50} />
          </div>
          <div>
            <label htmlFor="m-frequency">Frequency</label>
            <input id="m-frequency" value={f.frequency} onChange={set('frequency')} required maxLength={50} />
          </div>
          <div>
            <label htmlFor="m-route">Route</label>
            <input id="m-route" value={f.route} onChange={set('route')} required maxLength={30} />
          </div>
          <div>
            <label htmlFor="m-indication">Indication</label>
            <input id="m-indication" value={f.indication} onChange={set('indication')} maxLength={200} />
          </div>
          <div>
            <label htmlFor="m-start">Start date</label>
            <input id="m-start" type="date" value={f.startDate} onChange={set('startDate')} required />
          </div>
          <div>
            <label htmlFor="m-status">Status</label>
            <select id="m-status" value={f.status} onChange={set('status')}>
              {(Object.keys(STATUS_LABEL) as MedicationStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="m-source">Source</label>
            <select id="m-source" value={f.source} onChange={set('source')}>
              {(Object.keys(SOURCE_LABEL) as MedicationSource[]).map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="m-doctor">Prescribing doctor</label>
            <input id="m-doctor" value={f.prescribingDoctor} onChange={set('prescribingDoctor')} required maxLength={150} />
          </div>
        </div>
        {f.status === 'DISCONTINUED' && (
          <>
            <label htmlFor="m-stop">Reason for stopping</label>
            <input id="m-stop" value={f.discontinuationReason} onChange={set('discontinuationReason')} required maxLength={255} />
          </>
        )}
        <label htmlFor="m-instructions">Instructions</label>
        <textarea id="m-instructions" rows={2} value={f.instructions} onChange={set('instructions')} maxLength={500} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {existing ? 'Save change' : 'Save medication'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AllergyDialog({ patientId, onClose, onSaved }: { patientId: string; onClose: () => void; onSaved: (alerts: SafetyAlert[]) => void }) {
  const [name, setName] = useState('');
  const [reaction, setReaction] = useState('');
  const [severity, setSeverity] = useState<'' | 'MILD' | 'MODERATE' | 'SEVERE'>('');
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    api
      .addAllergy({ patientId, allergenName: name.trim(), reaction: reaction.trim() || undefined, severity: severity || undefined })
      .then((r) => onSaved(r.alerts), (err: Error) => setError(err.message));
  };
  return (
    <Modal title="Add Allergy" onClose={onClose}>
      <form onSubmit={submit}>
        <label htmlFor="a-name">Allergen</label>
        <input id="a-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        <label htmlFor="a-reaction">Reaction</label>
        <input id="a-reaction" value={reaction} onChange={(e) => setReaction(e.target.value)} maxLength={150} />
        <label htmlFor="a-severity">Severity</label>
        <select id="a-severity" value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)}>
          <option value="">Not recorded</option>
          <option value="MILD">Mild</option>
          <option value="MODERATE">Moderate</option>
          <option value="SEVERE">Severe</option>
        </select>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary">Save allergy</button>
        </div>
      </form>
    </Modal>
  );
}

function RemoveAllergyDialog({ allergy, onClose, onDone }: { allergy: Allergy; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    api.voidAllergy(allergy.id, reason.trim()).then(onDone, (err: Error) => setError(err.message));
  };
  return (
    <Modal title={`Remove ${allergy.allergenName}?`} onClose={onClose}>
      <p className="muted">The entry is hidden, not deleted. The reason is kept with it.</p>
      <form onSubmit={submit}>
        <label htmlFor="void-reason">Reason</label>
        <input id="void-reason" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={255} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary">Remove allergy</button>
        </div>
      </form>
    </Modal>
  );
}
