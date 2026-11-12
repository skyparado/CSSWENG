import { useState, type FormEvent } from 'react';
import {
  adminApi,
  formatDateTime,
  type AuditEntry,
  type AuditFilters,
  type AuditVerifyResult,
} from '../adminApi';
import { useLoad, useSession } from '../session';

const PAGE_SIZE = 50;

/**
 * Event types worth offering in the dropdown. Kept in step with
 * backend/src/audit/actions.ts; an action the server writes but this list
 * misses is still reachable through the free-text search.
 */
const ACTIONS: Array<{ value: string; label: string; group: string }> = [
  { value: 'LOGIN_SUCCESS', label: 'Sign-in succeeded', group: 'Access' },
  { value: 'LOGIN_FAILED', label: 'Sign-in failed', group: 'Access' },
  { value: 'ACCOUNT_LOCKED', label: 'Account locked', group: 'Access' },
  { value: 'LOGOUT', label: 'Sign-out', group: 'Access' },
  { value: 'ACCESS_REFUSED', label: 'Access refused', group: 'Access' },
  { value: 'USER_CREATED', label: 'Account created', group: 'Accounts' },
  { value: 'USER_UPDATED', label: 'Account updated', group: 'Accounts' },
  { value: 'USER_APPROVED', label: 'Account approved', group: 'Accounts' },
  { value: 'USER_REJECTED', label: 'Account rejected', group: 'Accounts' },
  { value: 'USER_REVOKED', label: 'Account revoked', group: 'Accounts' },
  { value: 'USER_REINSTATED', label: 'Account reinstated', group: 'Accounts' },
  { value: 'USER_UNLOCKED', label: 'Account unlocked', group: 'Accounts' },
  { value: 'USER_PASSWORD_RESET', label: 'Password reset', group: 'Accounts' },
  { value: 'USER_CLINICS_ASSIGNED', label: 'Clinics assigned', group: 'Accounts' },
  { value: 'PATIENT_CHART_VIEWED', label: 'Chart viewed', group: 'Patients' },
  { value: 'PATIENT_VOIDED', label: 'Patient voided', group: 'Patients' },
  { value: 'CLINICAL_IMAGE_UPLOADED', label: 'Image uploaded', group: 'Images' },
  { value: 'IMAGE_ANNOTATION_SAVED', label: 'Annotation saved', group: 'Images' },
  { value: 'INTAKE_SESSION_STARTED', label: 'Intake started', group: 'Intake' },
  { value: 'INTAKE_SESSION_SUBMITTED', label: 'Intake submitted', group: 'Intake' },
  { value: 'INTAKE_SESSION_CANCELLED', label: 'Intake cancelled', group: 'Intake' },
  { value: 'HTTP_REQUEST', label: 'Raw HTTP request', group: 'Other' },
];

const ACTION_GROUPS = [...new Set(ACTIONS.map((a) => a.group))];

/** Blank filter set. `hideHttpNoise` starts on, see the comment below. */
const EMPTY: AuditFilters = {
  q: '',
  action: '',
  resourceType: '',
  resourceId: '',
  clinicId: '',
  from: '',
  to: '',
  // The middleware writes an HTTP_REQUEST row for every single request. Left
  // visible it buries the named events, so the screen hides it by default and
  // offers a toggle for when you genuinely want the raw trail.
  hideHttpNoise: true,
};

/**
 * S19 Audit Log. Doctor only.
 *
 * Search across the axes QA asked for (user, event type, date range, patient
 * or other record, clinic), verify the hash chain, and export the filtered
 * view as CSV or PDF. Entries are append-only at the database level, so there
 * is deliberately no edit or delete here.
 */
export default function AuditLog() {
  const { clinic } = useSession();
  // Draft is what the form holds; applied is what the query uses, so typing
  // in a box does not fire a request per keystroke.
  const [draft, setDraft] = useState<AuditFilters>(EMPTY);
  const [applied, setApplied] = useState<AuditFilters>(EMPTY);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [verify, setVerify] = useState<AuditVerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const { data, error } = useLoad(
    () => adminApi.listAudit({ ...toQuery(applied), page, pageSize: PAGE_SIZE }),
    [JSON.stringify(applied), page],
  );

  function apply(e: FormEvent) {
    e.preventDefault();
    setPage(1);
    setApplied(draft);
  }

  function reset() {
    setDraft(EMPTY);
    setApplied(EMPTY);
    setPage(1);
  }

  async function runVerify() {
    setVerifying(true);
    setVerifyError(null);
    setVerify(null);
    try {
      setVerify(await adminApi.verifyChain());
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifying(false);
    }
  }

  const exportFilters = toQuery(applied);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <div className="row between">
        <div>
          <h1>Audit Log</h1>
          <p className="muted">
            Every recorded action, oldest changes preserved. Entries cannot be
            edited or deleted, including by the doctor.
          </p>
        </div>
        <div className="row actions-row">
          <a
            className="btn"
            href={adminApi.auditExportUrl('csv', exportFilters)}
            download
          >
            Export CSV
          </a>
          <a
            className="btn"
            href={adminApi.auditExportUrl('pdf', exportFilters)}
            download
          >
            Export PDF
          </a>
          <button type="button" onClick={runVerify} disabled={verifying}>
            {verifying ? 'Checking...' : 'Verify chain'}
          </button>
        </div>
      </div>

      {verifyError && (
        <p className="error" role="alert">
          {verifyError}
        </p>
      )}
      {verify && (
        <p className={verify.ok ? 'notice' : 'error'} role="status">
          {verify.ok ? (
            <>
              Chain intact across all {verify.total} entries. No sign of
              tampering.
            </>
          ) : (
            <>
              Chain broken at {verify.breakages.length}{' '}
              {verify.breakages.length === 1 ? 'entry' : 'entries'} of{' '}
              {verify.total}. First break:{' '}
              {formatDateTime(verify.breakages[0]?.createdAt ?? null)} (
              {verify.breakages[0]?.reason.replace(/_/g, ' ')}). Treat the log
              as compromised and escalate.
            </>
          )}
        </p>
      )}

      <form className="card audit-filters" onSubmit={apply} role="search">
        <div className="audit-filter-grid">
          <div>
            <label htmlFor="audit-q">Search</label>
            <input
              id="audit-q"
              placeholder="Email, action or path"
              value={draft.q ?? ''}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            />
          </div>

          <div>
            <label htmlFor="audit-action">Event type</label>
            <select
              id="audit-action"
              value={draft.action ?? ''}
              onChange={(e) => setDraft({ ...draft, action: e.target.value })}
            >
              <option value="">Any event</option>
              {ACTION_GROUPS.map((group) => (
                <optgroup key={group} label={group}>
                  {ACTIONS.filter((a) => a.group === group).map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="audit-resource-type">Record type</label>
            <select
              id="audit-resource-type"
              value={draft.resourceType ?? ''}
              onChange={(e) => setDraft({ ...draft, resourceType: e.target.value })}
            >
              <option value="">Any record</option>
              <option value="Patient">Patient</option>
              <option value="User">User account</option>
              <option value="Appointment">Appointment</option>
              <option value="Document">Document</option>
              <option value="ClinicalImage">Clinical image</option>
              <option value="TabletIntakeSession">Intake session</option>
            </select>
          </div>

          <div>
            <label htmlFor="audit-resource-id">Record ID</label>
            <input
              id="audit-resource-id"
              placeholder="Patient or record id"
              value={draft.resourceId ?? ''}
              onChange={(e) => setDraft({ ...draft, resourceId: e.target.value })}
            />
          </div>

          <div>
            <label htmlFor="audit-from">From</label>
            <input
              id="audit-from"
              type="date"
              value={draft.from ?? ''}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </div>

          <div>
            <label htmlFor="audit-to">To</label>
            <input
              id="audit-to"
              type="date"
              value={draft.to ?? ''}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </div>
        </div>

        <div className="row between audit-filter-footer">
          <label className="checkbox-row" htmlFor="audit-hide-noise">
            <input
              id="audit-hide-noise"
              type="checkbox"
              checked={draft.hideHttpNoise ?? false}
              onChange={(e) => setDraft({ ...draft, hideHttpNoise: e.target.checked })}
            />
            Hide raw HTTP request rows
          </label>
          <div className="row actions-row">
            {clinic && (
              <label className="checkbox-row" htmlFor="audit-this-clinic">
                <input
                  id="audit-this-clinic"
                  type="checkbox"
                  checked={draft.clinicId === clinic.id}
                  onChange={(e) =>
                    setDraft({ ...draft, clinicId: e.target.checked ? clinic.id : '' })
                  }
                />
                This clinic only
              </label>
            )}
            <button type="button" onClick={reset}>
              Clear
            </button>
            <button type="submit" className="primary">
              Search
            </button>
          </div>
        </div>
      </form>

      <section className="card">
        {error && <p className="error">{error}</p>}
        {!data && !error && <p>Loading...</p>}
        {data && data.items.length === 0 && (
          <p className="muted">No entries match these filters.</p>
        )}
        {data && data.items.length > 0 && (
          <table className="audit-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>User</th>
                <th>Record</th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((entry) => (
                <AuditRow
                  key={entry.id}
                  entry={entry}
                  open={expanded === entry.id}
                  onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)}
                />
              ))}
            </tbody>
          </table>
        )}
        {data && data.total > 0 && (
          <div className="pager">
            <span className="muted">
              {data.total.toLocaleString()}{' '}
              {data.total === 1 ? 'entry' : 'entries'}
            </span>
            <div className="row">
              <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Prev
              </button>
              <span>
                Page {page} of {pages}
              </span>
              <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Next
              </button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function AuditRow({
  entry,
  open,
  onToggle,
}: {
  entry: AuditEntry;
  open: boolean;
  onToggle: () => void;
}) {
  const label = ACTIONS.find((a) => a.value === entry.action)?.label ?? entry.action;
  const failed = entry.statusCode !== null && entry.statusCode >= 400;

  return (
    <>
      <tr className={failed ? 'audit-row-failed' : undefined}>
        <td className="muted nowrap">{formatDateTime(entry.createdAt)}</td>
        <td>
          <span className={`audit-action audit-action-${entry.action.toLowerCase()}`}>
            {label}
          </span>
        </td>
        <td>
          {entry.userEmail ?? <span className="muted">not signed in</span>}
          {entry.userRole && <span className="muted"> ({entry.userRole})</span>}
        </td>
        <td className="muted">
          {entry.resourceType ? (
            <>
              {entry.resourceType}
              {entry.resourceId && <span className="audit-id"> {entry.resourceId}</span>}
            </>
          ) : (
            '--'
          )}
        </td>
        <td className={failed ? 'error' : 'muted'}>{entry.statusCode ?? '--'}</td>
        <td>
          <button type="button" onClick={onToggle} aria-expanded={open}>
            {open ? 'Hide' : 'Details'}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="audit-detail-row">
          <td colSpan={6}>
            <dl className="audit-detail">
              <dt>Request</dt>
              <dd>
                {entry.method ?? '--'} {entry.path ?? '--'}
              </dd>
              <dt>IP address</dt>
              <dd>{entry.ipAddress ?? '--'}</dd>
              <dt>User agent</dt>
              <dd className="audit-wrap">{entry.userAgent ?? '--'}</dd>
              {entry.metadata !== null && entry.metadata !== undefined && (
                <>
                  <dt>Details</dt>
                  <dd>
                    <pre className="audit-metadata">
                      {JSON.stringify(entry.metadata, null, 2)}
                    </pre>
                  </dd>
                </>
              )}
              <dt>Entry hash</dt>
              <dd className="audit-hash">{entry.entryHash}</dd>
              <dt>Previous hash</dt>
              <dd className="audit-hash">
                {entry.previousHash || <span className="muted">first entry in the chain</span>}
              </dd>
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Drop empty strings and widen the date inputs to cover the whole day. A bare
 * date lands at midnight, so an unadjusted "to" would exclude everything that
 * happened during the day the doctor picked.
 */
function toQuery(filters: AuditFilters): AuditFilters {
  const out: AuditFilters = {};
  if (filters.q) out.q = filters.q;
  if (filters.action) out.action = filters.action;
  if (filters.resourceType) out.resourceType = filters.resourceType;
  if (filters.resourceId) out.resourceId = filters.resourceId;
  if (filters.clinicId) out.clinicId = filters.clinicId;
  if (filters.hideHttpNoise) out.hideHttpNoise = true;
  if (filters.from) out.from = new Date(`${filters.from}T00:00:00`).toISOString();
  if (filters.to) out.to = new Date(`${filters.to}T23:59:59.999`).toISOString();
  return out;
}
