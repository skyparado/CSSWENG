import { useState, type FormEvent } from 'react';
import {
  adminApi,
  formatDateTime,
  ROLE_LABEL,
  STATUS_LABEL,
  type AdminUser,
  type UserRole,
  type UserStatus,
} from '../adminApi';
import { useLoad, useSession } from '../session';
import type { Clinic } from '../api';

const PAGE_SIZE = 20;

/** Status tabs, in the order a doctor works through them. */
const TABS: Array<{ value: UserStatus | 'ALL'; label: string }> = [
  { value: 'PENDING', label: 'Pending approval' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'LOCKED', label: 'Locked' },
  { value: 'REVOKED', label: 'Revoked' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'ALL', label: 'All accounts' },
];

/**
 * S18 User Accounts. Doctor only; the sidebar hides the link for a Secretary
 * and the API refuses her anyway.
 *
 * Covers the whole account lifecycle the SRS asks for: approve or reject a
 * request, revoke or reinstate access, unlock an account that hit the
 * failed-login threshold, and set a new password. Every one of these writes
 * an audit entry on the server.
 */
export default function Users() {
  // The Doctor sees every clinic, so this is the full list to choose from
  // when authorizing an account (US-04, US-06).
  const { user: currentUser, clinics: allClinics } = useSession();
  const [tab, setTab] = useState<UserStatus | 'ALL'>('PENDING');
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [resetFor, setResetFor] = useState<AdminUser | null>(null);
  const [approveFor, setApproveFor] = useState<AdminUser | null>(null);
  const [clinicsFor, setClinicsFor] = useState<AdminUser | null>(null);

  const { data, error, reload } = useLoad(
    () =>
      adminApi.listUsers({
        ...(tab === 'ALL' ? {} : { status: tab }),
        page,
        pageSize: PAGE_SIZE,
      }),
    [tab, page],
  );

  /** Run one account action, then refresh the list. */
  async function act(
    target: AdminUser,
    label: string,
    run: () => Promise<unknown>,
  ) {
    setActionError(null);
    setNotice(null);
    setBusyId(target.id);
    try {
      await run();
      setNotice(`${label} ${target.fullName}.`);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <div className="row between">
        <div>
          <h1>User Accounts</h1>
          <p className="muted">
            Approve, revoke and unlock staff accounts. Every change here is
            recorded in the audit log.
          </p>
        </div>
        <button type="button" className="primary" onClick={() => setShowCreate(true)}>
          + New Account
        </button>
      </div>

      <div className="pills" role="group" aria-label="Filter by status">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            aria-pressed={tab === t.value}
            onClick={() => {
              setTab(t.value);
              setPage(1);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}

      <section className="card">
        {error && <p className="error">{error}</p>}
        {!data && !error && <p>Loading...</p>}
        {data && data.items.length === 0 && (
          <p className="muted">
            {tab === 'PENDING'
              ? 'No accounts are waiting for approval.'
              : 'No accounts in this status.'}
          </p>
        )}
        {data && data.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Clinics</th>
                <th>Last sign-in</th>
                <th>Decided</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.fullName}</strong>
                    {u.id === currentUser.id && <span className="muted"> (you)</span>}
                  </td>
                  <td className="muted">{u.email}</td>
                  <td>
                    {ROLE_LABEL[u.role]}
                    {/* Only worth showing when the doctor granted something
                        other than what was asked for. */}
                    {u.requestedRole && u.requestedRole !== u.role && (
                      <span className="muted"> (asked for {ROLE_LABEL[u.requestedRole]})</span>
                    )}
                  </td>
                  <td>
                    <span className={`status-chip status-${u.status.toLowerCase()}`}>
                      {STATUS_LABEL[u.status]}
                    </span>
                  </td>
                  <td className="muted">
                    {u.role === 'DOCTOR' ? (
                      // Doctors are not restricted by assignment, so listing
                      // clinics for them would imply a limit that is not real.
                      <span>All clinics</span>
                    ) : u.clinicIds.length === 0 ? (
                      <span className="status-chip status-pending">None yet</span>
                    ) : (
                      clinicNames(allClinics, u.clinicIds)
                    )}
                  </td>
                  <td className="muted">{formatDateTime(u.lastLoginAt)}</td>
                  <td className="muted">{formatDateTime(u.approvedAt)}</td>
                  <td>
                    <RowActions
                      user={u}
                      isSelf={u.id === currentUser.id}
                      busy={busyId === u.id}
                      onAct={act}
                      onResetPassword={() => setResetFor(u)}
                      onApprove={() => setApproveFor(u)}
                      onAssignClinics={() => setClinicsFor(u)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && data.total > 0 && (
          <div className="pager">
            <span className="muted">
              {data.total} {data.total === 1 ? 'account' : 'accounts'}
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

      {showCreate && (
        <CreateAccountDialog
          onClose={() => setShowCreate(false)}
          onCreated={(created) => {
            setShowCreate(false);
            setNotice(`Created the account for ${created.fullName}.`);
            setTab('ACTIVE');
            setPage(1);
            reload();
          }}
        />
      )}

      {approveFor && (
        <ApproveDialog
          user={approveFor}
          allClinics={allClinics}
          onClose={() => setApproveFor(null)}
          onDone={(message) => {
            setApproveFor(null);
            setNotice(message);
            reload();
          }}
        />
      )}

      {clinicsFor && (
        <AssignClinicsDialog
          user={clinicsFor}
          allClinics={allClinics}
          onClose={() => setClinicsFor(null)}
          onDone={(message) => {
            setClinicsFor(null);
            setNotice(message);
            reload();
          }}
        />
      )}

      {resetFor && (
        <ResetPasswordDialog
          user={resetFor}
          onClose={() => setResetFor(null)}
          onDone={() => {
            const name = resetFor.fullName;
            setResetFor(null);
            setNotice(`Set a new password for ${name}. Give it to them in person.`);
            reload();
          }}
        />
      )}
    </>
  );
}

/** The buttons that make sense for one account, given its current status. */
function RowActions({
  user,
  isSelf,
  busy,
  onAct,
  onResetPassword,
  onApprove,
  onAssignClinics,
}: {
  user: AdminUser;
  isSelf: boolean;
  busy: boolean;
  onAct: (u: AdminUser, label: string, run: () => Promise<unknown>) => void;
  onResetPassword: () => void;
  onApprove: () => void;
  onAssignClinics: () => void;
}) {
  // A doctor locking or revoking herself would be locked out of the only
  // account that can undo it, so those actions are hidden on her own row.
  const canChangeAccess = !isSelf;

  return (
    <div className="row actions-row">
      {user.status === 'PENDING' && (
        <>
          {/* Opens a dialog rather than approving outright: the Doctor has to
              choose the role and the clinics in the same decision. */}
          <button type="button" className="primary" disabled={busy} onClick={onApprove}>
            Review and approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAct(user, 'Rejected', () => adminApi.rejectUser(user.id))}
          >
            Reject
          </button>
        </>
      )}

      {user.status === 'ACTIVE' && canChangeAccess && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onAct(user, 'Revoked access for', () => adminApi.revokeUser(user.id))}
        >
          Revoke
        </button>
      )}

      {user.status === 'LOCKED' && (
        <>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => onAct(user, 'Unlocked', () => adminApi.unlockUser(user.id))}
          >
            Unlock
          </button>
          {canChangeAccess && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAct(user, 'Revoked access for', () => adminApi.revokeUser(user.id))}
            >
              Revoke
            </button>
          )}
        </>
      )}

      {(user.status === 'REVOKED' || user.status === 'REJECTED') && (
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => onAct(user, 'Reinstated', () => adminApi.reinstateUser(user.id))}
        >
          Reinstate
        </button>
      )}

      {user.status !== 'PENDING' && user.status !== 'REJECTED' && (
        <>
          {/* A Doctor is not limited by assignment, so the control would be
              misleading on her row. */}
          {user.role === 'SECRETARY' && (
            <button type="button" disabled={busy} onClick={onAssignClinics}>
              Clinics
            </button>
          )}
          <button type="button" disabled={busy} onClick={onResetPassword}>
            Reset password
          </button>
        </>
      )}
    </div>
  );
}

/** Readable clinic names for a set of ids, falling back to the raw id. */
function clinicNames(all: Clinic[], ids: string[]): string {
  return ids
    .map((id) => all.find((c) => c.id === id)?.name ?? id)
    .join(', ');
}

/** Shared clinic checkbox group used by both authorization dialogs. */
function ClinicPicker({
  all,
  selected,
  onChange,
  idPrefix,
}: {
  all: Clinic[];
  selected: string[];
  onChange: (next: string[]) => void;
  idPrefix: string;
}) {
  function toggle(id: string, on: boolean) {
    onChange(on ? [...selected, id] : selected.filter((c) => c !== id));
  }

  if (all.length === 0) {
    return <p className="muted">No active clinics to assign.</p>;
  }

  return (
    <div className="clinic-picker" role="group" aria-label="Clinics">
      {all.map((c) => (
        <label className="checkbox-row" key={c.id} htmlFor={`${idPrefix}-${c.id}`}>
          <input
            id={`${idPrefix}-${c.id}`}
            type="checkbox"
            checked={selected.includes(c.id)}
            onChange={(e) => toggle(c.id, e.target.checked)}
          />
          {c.name}
        </label>
      ))}
    </div>
  );
}

/**
 * Approve a pending account: confirm the role and choose the clinics in one
 * decision (US-04, US-06, SDD gap H2). The requested role is pre-selected so
 * the common case is one click, but the Doctor can grant something else and
 * the granted role is what gets enforced.
 */
function ApproveDialog({
  user,
  allClinics,
  onClose,
  onDone,
}: {
  user: AdminUser;
  allClinics: Clinic[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const requested = user.requestedRole ?? user.role;
  const [role, setRole] = useState<UserRole>(requested);
  const [clinicIds, setClinicIds] = useState<string[]>(user.clinicIds);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await adminApi.approveUser(user.id, {
        grantedRole: role,
        // Doctors are not restricted by assignment, so sending a list for one
        // would record a limit that is not actually enforced.
        ...(role === 'SECRETARY' ? { clinicIds } : {}),
      });
      onDone(`Approved ${user.fullName} as ${ROLE_LABEL[role]}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={`Approve ${user.fullName}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted">
          {user.email} asked for the {ROLE_LABEL[requested]} role.
        </p>

        <label htmlFor="approve-role">Grant this role</label>
        <select
          id="approve-role"
          value={role}
          onChange={(e) => setRole(e.target.value as UserRole)}
        >
          <option value="SECRETARY">Secretary</option>
          <option value="DOCTOR">Doctor</option>
        </select>
        {role !== requested && (
          <p className="muted small">
            This differs from what was requested. The role you grant here is
            the one enforced.
          </p>
        )}

        {role === 'SECRETARY' ? (
          <>
            <label>Clinics this account may work in</label>
            <ClinicPicker
              all={allClinics}
              selected={clinicIds}
              onChange={setClinicIds}
              idPrefix="approve-clinic"
            />
            {clinicIds.length === 0 && (
              <p className="muted small">
                With no clinic selected the account can sign in but cannot
                open any clinic. You can assign one later from the Clinics
                button on their row.
              </p>
            )}
          </>
        ) : (
          <p className="muted small">
            A Doctor can work in every clinic, so there is nothing to assign.
          </p>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="row actions-row dialog-actions">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Approving...' : 'Approve account'}
          </button>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Change which clinics an existing Secretary may work in. */
function AssignClinicsDialog({
  user,
  allClinics,
  onClose,
  onDone,
}: {
  user: AdminUser;
  allClinics: Clinic[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [clinicIds, setClinicIds] = useState<string[]>(user.clinicIds);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await adminApi.assignClinics(user.id, clinicIds);
      onDone(
        clinicIds.length === 0
          ? `${user.fullName} is no longer assigned to any clinic.`
          : `${user.fullName} can now work in ${clinicNames(allClinics, clinicIds)}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={`Clinics for ${user.fullName}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted">
          A Secretary can only open clinics she is assigned to. Unticking a
          clinic removes her access to it without touching the rest of the
          account.
        </p>

        <ClinicPicker
          all={allClinics}
          selected={clinicIds}
          onChange={setClinicIds}
          idPrefix="assign-clinic"
        />

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="row actions-row dialog-actions">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving...' : 'Save clinics'}
          </button>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function CreateAccountDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (u: AdminUser) => void;
}) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('SECRETARY');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const created = await adminApi.createUser({ fullName, username, email, password, role });
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="New staff account" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted">
          An account you create here is active right away, so it skips the
          approval queue.
        </p>

        <label htmlFor="new-name">Full name</label>
        <input
          id="new-name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          required
          autoFocus
        />

        <label htmlFor="new-username">Username</label>
        <input
          id="new-username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoCapitalize="none"
          spellCheck={false}
          required
          aria-describedby="new-username-help"
        />
        <p id="new-username-help" className="muted small">
          What this person types to sign in. Letters, numbers, dots,
          underscores and hyphens.
        </p>

        <label htmlFor="new-email">Email</label>
        <input
          id="new-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        <label htmlFor="new-role">Role</label>
        <select
          id="new-role"
          value={role}
          onChange={(e) => setRole(e.target.value as UserRole)}
        >
          <option value="SECRETARY">Secretary</option>
          <option value="DOCTOR">Doctor</option>
        </select>

        <label htmlFor="new-password">Temporary password</label>
        <input
          id="new-password"
          type="text"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={12}
          required
          aria-describedby="new-password-help"
        />
        <p id="new-password-help" className="muted small">
          At least 12 characters, with an uppercase letter, a lowercase letter and a number. Shown as plain
          text on purpose, so you can read it out to the person. Have them
          change it after signing in.
        </p>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="row actions-row dialog-actions">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Creating...' : 'Create account'}
          </button>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ResetPasswordDialog({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await adminApi.resetPassword(user.id, password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={`Reset password for ${user.fullName}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="muted">
          This replaces the password immediately and clears any failed sign-in
          counters. There is no email reset link, so pass the new password on
          in person.
        </p>

        <label htmlFor="reset-password">New password</label>
        <input
          id="reset-password"
          type="text"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={12}
          required
          autoFocus
        />
        <p className="muted small">At least 12 characters, with an uppercase letter, a lowercase letter and a number.</p>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="row actions-row dialog-actions">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving...' : 'Set password'}
          </button>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Plain modal shell shared by the two account dialogs. */
function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
