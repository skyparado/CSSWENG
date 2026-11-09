import { useEffect, useState } from 'react';
import { documentRequestCreateSchema, type DocumentRequestCreate } from '@clinic/schemas';
import { api, patientFromRoute, type PatientRef, type SafetyAlert } from '../api';
import PatientPicker from '../PatientPicker';
import SignDialog from '../SignDialog';
import { go, useLoad, useRoute, useSession } from '../session';

type Item = { drug: string; dosage: string; frequency: string; duration: string; notes: string };
type Fields = {
  items: Item[];
  diagnosis: string;
  recommendation: string;
  restFrom: string;
  restTo: string;
  license: string;
};
const blankItem: Item = { drug: '', dosage: '', frequency: '', duration: '', notes: '' };
const blank: Fields = { items: [{ ...blankItem }], diagnosis: '', recommendation: '', restFrom: '', restTo: '', license: '' };

/** Common ophthalmic medicines offered in the medicine field (free text is still allowed). */
const COMMON_DRUGS = [
  'Timolol 0.5% eye drops',
  'Latanoprost 0.005% eye drops',
  'Brimonidine 0.2% eye drops',
  'Dorzolamide 2% eye drops',
  'Moxifloxacin 0.5% eye drops',
  'Tobramycin 0.3% eye drops',
  'Tobramycin + Dexamethasone eye drops',
  'Prednisolone acetate 1% eye drops',
  'Loteprednol 0.5% eye drops',
  'Ketorolac 0.5% eye drops',
  'Olopatadine 0.1% eye drops',
  'Cyclopentolate 1% eye drops',
  'Artificial tears',
  'Acetazolamide 250 mg tablet',
];

/** A blob as an object URL for <img>/<iframe>, revoked when it changes. */
function useObjectUrl(blob?: Blob) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return setUrl(undefined);
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

const draftKey = (clinicId: string, patientId: string, type: string) => `draft:${clinicId}:${patientId}:${type}`;
const ymd = (d?: Date | string) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/** S14 Prescription and Medical Certificate Editor (Doctor only). */
export default function DocumentEditor() {
  const { user, clinic } = useSession();
  const route = useRoute();
  const params = new URLSearchParams(route.split('?')[1] ?? '');
  const requestId = params.get('request') ?? undefined; // fulfil a logged request
  const reviseId = params.get('revise') ?? undefined; // new version of a signed document

  const [type, setType] = useState<DocumentRequestCreate['type']>(
    params.get('type') === 'MEDICAL_CERTIFICATE' ? 'MEDICAL_CERTIFICATE' : 'PRESCRIPTION',
  );
  const [patient, setPatient] = useState<PatientRef | undefined>(() => patientFromRoute(route));
  const prescriberName = user.fullName; // server always uses the signed-in Doctor
  const [fields, setFields] = useState<Fields>(blank);
  const [previous, setPrevious] = useState<{ id: string; version: number }>();
  const [savedAt, setSavedAt] = useState<string>();
  const [acks, setAcks] = useState<Record<string, { acked: boolean; reason: string }>>({});
  const [preview, setPreview] = useState<Blob>();
  const [createdId, setCreatedId] = useState<string>();
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const previewUrl = useObjectUrl(preview);
  const set = (patch: Partial<Fields>) => setFields((f) => ({ ...f, ...patch }));
  const { items } = fields;

  // Prefill from a logged request (patient, type) or from the version being revised (everything).
  useEffect(() => {
    const id = requestId ?? reviseId;
    if (!id) return;
    api.documentRequest(id).then((r) => {
      setType(r.type);
      setPatient(r.patient);
      if (reviseId && r.payload && r.document) {
        const p = r.payload as Record<string, unknown> & { items?: Array<Partial<Item>> };
        setPrevious({ id: r.document.id, version: r.document.version });
        setFields({
          items: p.items?.map((it) => ({ ...blankItem, ...it, notes: it.notes ?? '' })) ?? blank.items,
          diagnosis: String(p.diagnosis ?? ''),
          recommendation: String(p.recommendation ?? ''),
          restFrom: ymd(p.restFromDate as string | undefined),
          restTo: ymd(p.restToDate as string | undefined),
          license: String(p.prescriberLicense ?? ''),
        });
      }
    }, (e: Error) => setError(e.message));
  }, [requestId, reviseId, user.fullName]);

  // Auto-saved draft on this device: restore it when a patient and type are chosen.
  const key = patient && draftKey(clinic!.id, patient.id, type);
  useEffect(() => {
    if (!key || reviseId) return;
    const saved = sessionStorage.getItem(key);
    if (saved) {
      const d = JSON.parse(saved) as Fields & { savedAt: string };
      setFields({ ...blank, ...d });
      setSavedAt(d.savedAt);
    } else {
      setSavedAt(undefined);
    }
  }, [key, reviseId]);
  useEffect(() => {
    if (!key || reviseId || JSON.stringify(fields) === JSON.stringify(blank)) return;
    const t = setTimeout(() => {
      const at = new Date().toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
      sessionStorage.setItem(key, JSON.stringify({ ...fields, savedAt: at }));
      setSavedAt(at);
    }, 800);
    return () => clearTimeout(t);
  }, [key, reviseId, fields]);

  const signature = useLoad(() => api.signature().catch(() => undefined), []);
  const signatureUrl = useObjectUrl(signature.data);
  const allergies = useLoad(
    () => (patient ? api.allergies(patient.id).then((r) => r.items) : Promise.resolve([])),
    [patient?.id],
  );
  const currentMeds = useLoad(
    () => (patient ? api.medications(patient.id).then((r) => r.items.map((m) => m.medicationName)) : Promise.resolve([])),
    [patient?.id],
  );

  // Safety alerts (duplicate medicine, allergy) for each prescribed drug.
  const drugs = type === 'PRESCRIPTION' ? [...new Set(items.map((i) => i.drug.trim()).filter(Boolean))] : [];
  const drugsKey = drugs.join('\n');
  const [alerts, setAlerts] = useState<Record<string, SafetyAlert[]>>({});
  useEffect(() => {
    if (!patient || drugs.length === 0) return setAlerts({});
    const t = setTimeout(() => {
      void Promise.all(drugs.map((d) => api.checkMedication(patient.id, d).then((r) => [d, r.alerts] as const)))
        .then((pairs) => setAlerts(Object.fromEntries(pairs.filter(([, a]) => a.length > 0))))
        .catch(() => setAlerts({}));
    }, 500);
    return () => clearTimeout(t);
  }, [patient?.id, drugsKey]); // drugsKey stands for `drugs`
  const unacknowledged = Object.keys(alerts).filter((d) => !acks[d]?.acked);

  const common = {
    patientName: patient ? `${patient.firstName} ${patient.lastName}` : '',
    clinicName: clinic!.name, // replaced server-side by the stored clinic
    prescriberName,
    prescriberLicense: fields.license || undefined,
    issuedOn: new Date(),
  };
  const draft = {
    clinicId: clinic!.id,
    patientId: patient?.id ?? '',
    requestId,
    previousVersionId: previous?.id,
    safetyAcknowledgements: Object.entries(alerts).flatMap(([drug, list]) =>
      list.map((a) => ({ drug, message: a.message, reason: acks[drug]?.reason || undefined })),
    ),
    ...(type === 'PRESCRIPTION'
      ? { type, payload: { ...common, items: items.map((it) => ({ ...it, notes: it.notes || undefined })) } }
      : {
          type,
          payload: {
            ...common,
            diagnosis: fields.diagnosis,
            recommendation: fields.recommendation || undefined,
            restFromDate: fields.restFrom ? new Date(fields.restFrom) : undefined,
            restToDate: fields.restTo ? new Date(fields.restTo) : undefined,
          },
        }),
  };
  const parsed = documentRequestCreateSchema.safeParse(draft);
  const body = parsed.success ? parsed.data : undefined;
  const bodyKey = JSON.stringify({ ...draft, safetyAcknowledgements: undefined, payload: { ...draft.payload, issuedOn: undefined } });

  // Live preview, debounced while typing. Keyed on content (minus the ever-changing issuedOn).
  useEffect(() => {
    setCreatedId(undefined); // any edit invalidates a document created by a failed sign attempt
    if (!body) return;
    const t = setTimeout(() => void api.previewDocument(body).then(setPreview, (e: Error) => setError(e.message)), 500);
    return () => clearTimeout(t);
  }, [bodyKey]);

  const finish = () => {
    if (key) sessionStorage.removeItem(key);
    go('/documents');
  };
  const create = async () => {
    if (createdId) return createdId;
    const { document } = await api.createDocument(body!);
    setCreatedId(document.id);
    return document.id;
  };
  const saveDraft = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await create();
      finish();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const uploadSignature = (file?: File) => {
    if (!file) return;
    api.uploadSignature(file).then(signature.reload, (e: Error) => setError(e.message));
  };
  const setItem = (i: number, patch: Partial<Item>) => set({ items: items.map((it, j) => (j === i ? { ...it, ...patch } : it)) });
  const ready = !!body && unacknowledged.length === 0 && !busy;
  const label = type === 'PRESCRIPTION' ? 'Prescription' : 'Medical Certificate';
  const version = previous ? previous.version + 1 : 1;

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Prescription and Medical Certificate</h1>
        <div className="pills" role="group" aria-label="Document type">
          <button aria-pressed={type === 'PRESCRIPTION'} disabled={!!previous} onClick={() => setType('PRESCRIPTION')}>Prescription</button>
          <button aria-pressed={type === 'MEDICAL_CERTIFICATE'} disabled={!!previous} onClick={() => setType('MEDICAL_CERTIFICATE')}>
            Medical Certificate
          </button>
        </div>
      </div>

      <section className="card row" style={{ marginBottom: 20, justifyContent: 'space-between' }}>
        <div style={{ flex: 1 }}>
          <label htmlFor="doc-patient" style={{ marginTop: 0 }}>Patient *</label>
          <PatientPicker id="doc-patient" value={patient} onChange={setPatient} />
        </div>
        <span className="badge warn">
          {previous ? `New version ${version} of a signed ${label.toLowerCase()}` : requestId ? 'Requested · Draft' : 'Draft'}
        </span>
      </section>
      {(allergies.data?.length ?? 0) > 0 && (
        <p className="alert" role="alert">
          ⚠ ALLERGY:{' '}
          {allergies.data!.map((a) => `${a.allergenName}${a.reaction ? ` (${a.reaction})` : ''}`).join(' · ')}
        </p>
      )}

      <div className="grid2" style={{ gap: 20, alignItems: 'start', marginTop: 20 }}>
        <section className="card">
          {type === 'PRESCRIPTION' ? (
            <>
              <h2>Medicines</h2>
              <datalist id="drug-options">
                {[...new Set([...(currentMeds.data ?? []), ...COMMON_DRUGS])].map((d) => <option key={d} value={d} />)}
              </datalist>
              {items.map((it, i) => {
                const itemAlerts = alerts[it.drug.trim()] ?? [];
                const ack = acks[it.drug.trim()];
                return (
                  <div key={i}>
                    <fieldset className="med" aria-label={`Medicine ${i + 1}`}>
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <strong>Medicine {i + 1}</strong>
                        {items.length > 1 && (
                          <button type="button" onClick={() => set({ items: items.filter((_, j) => j !== i) })}>Remove</button>
                        )}
                      </div>
                      <label htmlFor={`drug-${i}`}>Medicine *</label>
                      <input id={`drug-${i}`} list="drug-options" value={it.drug} onChange={(e) => setItem(i, { drug: e.target.value })} />
                      <div className="grid2">
                        <div>
                          <label htmlFor={`dosage-${i}`}>Dose</label>
                          <input id={`dosage-${i}`} value={it.dosage} onChange={(e) => setItem(i, { dosage: e.target.value })} />
                        </div>
                        <div>
                          <label htmlFor={`frequency-${i}`}>Frequency</label>
                          <input id={`frequency-${i}`} value={it.frequency} onChange={(e) => setItem(i, { frequency: e.target.value })} />
                        </div>
                      </div>
                      <label htmlFor={`duration-${i}`}>Duration</label>
                      <input id={`duration-${i}`} value={it.duration} onChange={(e) => setItem(i, { duration: e.target.value })} />
                      <label htmlFor={`notes-${i}`}>Instructions</label>
                      <input id={`notes-${i}`} value={it.notes} onChange={(e) => setItem(i, { notes: e.target.value })} />
                    </fieldset>
                    {itemAlerts.length > 0 && (
                      <div className={`alert-box${ack?.acked ? ' ok' : ''}`} role="alert" aria-label={`Safety alert for ${it.drug}`}>
                        <h3>⚠ Safety alert{ack?.acked ? ' (acknowledged)' : ''}</h3>
                        {itemAlerts.map((a) => <p key={a.message} style={{ margin: '4px 0' }}>{a.message}</p>)}
                        {!ack?.acked && (
                          <>
                            <label className="sr-only" htmlFor={`ack-${i}`}>Reason</label>
                            <input
                              id={`ack-${i}`}
                              placeholder="Reason (optional)"
                              value={ack?.reason ?? ''}
                              onChange={(e) => setAcks({ ...acks, [it.drug.trim()]: { acked: false, reason: e.target.value } })}
                            />
                            <div className="row" style={{ marginTop: 8 }}>
                              <button type="button" onClick={() => setItem(i, { drug: '' })}>Review medicines</button>
                              <button
                                type="button"
                                className="primary"
                                onClick={() => setAcks({ ...acks, [it.drug.trim()]: { acked: true, reason: ack?.reason ?? '' } })}
                              >
                                Acknowledge and continue
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              <button type="button" style={{ width: '100%' }} onClick={() => set({ items: [...items, { ...blankItem }] })}>
                + Add medicine
              </button>
            </>
          ) : (
            <>
              <h2>Certificate</h2>
              <label htmlFor="diagnosis">Diagnosis *</label>
              <textarea id="diagnosis" rows={3} value={fields.diagnosis} onChange={(e) => set({ diagnosis: e.target.value })} />
              <label htmlFor="recommendation">Recommendation</label>
              <textarea id="recommendation" rows={2} value={fields.recommendation} onChange={(e) => set({ recommendation: e.target.value })} />
              <div className="grid2">
                <div>
                  <label htmlFor="rest-from">Rest from</label>
                  <input id="rest-from" type="date" value={fields.restFrom} onChange={(e) => set({ restFrom: e.target.value })} />
                </div>
                <div>
                  <label htmlFor="rest-to">Rest to</label>
                  <input id="rest-to" type="date" value={fields.restTo} onChange={(e) => set({ restTo: e.target.value })} />
                </div>
              </div>
            </>
          )}

          <h2 style={{ marginTop: 24 }}>Prescriber</h2>
          <div className="grid2">
            <div>
              <label htmlFor="prescriber">Name</label>
              <input id="prescriber" value={prescriberName} readOnly />
            </div>
            <div>
              <label htmlFor="license">License No.</label>
              <input id="license" value={fields.license} onChange={(e) => set({ license: e.target.value })} />
            </div>
          </div>
          <label htmlFor="signature-file">Signature image (PNG or JPEG)</label>
          {signatureUrl ? (
            <img className="sig-img" src={signatureUrl} alt="Your signature" />
          ) : (
            <p className="muted">No signature uploaded yet. Upload one to sign documents.</p>
          )}
          <input id="signature-file" type="file" accept="image/png,image/jpeg" onChange={(e) => uploadSignature(e.target.files?.[0])} />
        </section>

        <section className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>PDF Preview</h2>
            <span className="muted">{label} · Version {version}</span>
          </div>
          {previewUrl ? (
            <iframe className="preview" title="PDF preview" src={previewUrl} />
          ) : (
            <p className="muted">Choose a patient and fill the required fields to see the preview.</p>
          )}
        </section>
      </div>

      <div className="card footer-bar" style={{ marginTop: 20 }}>
        <span className="muted" style={{ marginRight: 'auto' }}>
          {savedAt ? `Draft · saved automatically at ${savedAt} on this device` : 'Draft · not saved yet'}
          {unacknowledged.length > 0 && <span className="error"> · Acknowledge the safety alerts to continue</span>}
        </span>
        {error && <span className="error" role="alert">{error}</span>}
        <button onClick={() => go('/documents')}>Cancel</button>
        <button disabled={!ready} onClick={() => void saveDraft()}>Save Draft</button>
        <button className="primary" disabled={!ready || !signatureUrl} onClick={() => setSigning(true)}>
          Sign {label}
        </button>
      </div>

      {signing && (
        <SignDialog
          title={`Sign ${label.toLowerCase()}`}
          onClose={() => setSigning(false)}
          onSign={async (password) => {
            await api.signDocument(await create(), password);
            finish();
          }}
        />
      )}
    </>
  );
}
