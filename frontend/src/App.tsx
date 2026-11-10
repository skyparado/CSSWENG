import { useEffect, useState, type ReactNode } from 'react';
import { api, type Clinic, type User } from './api';
import { SessionContext, go, useRoute, useSession, type Session } from './session';
import ClinicSelect from './pages/ClinicSelect';
import Dashboard from './pages/Dashboard';
import Calendar from './pages/Calendar';
import DocumentEditor from './pages/DocumentEditor';
import Documents from './pages/Documents';
import Patients from './pages/Patients';
import PatientRegister from './pages/PatientRegister';
import PatientChart from './pages/PatientChart';
import ConsultationNote from './pages/ConsultationNote';
import Comparison from './pages/Comparison';
import Login from './pages/Login';
import Users from './pages/Users';
import AuditLog from './pages/AuditLog';
import Intake from './pages/Intake';
import TabletIntake, { tabletTokenFromRoute } from './pages/TabletIntake';
import SessionTimeout from './SessionTimeout';

/**
 * Patient routes (S04–S08):
 *   /patients                                   S04 search and list
 *   /patients/new                               S05 registration
 *   /patients/:id                               S06 chart summary
 *   /patients/:id/visits/:encounterId           S07 consultation note
 *   /patients/:id/compare[?current=:encounterId] S08 comparison
 */
function patientPage(route: string): ReactNode | undefined {
  const [path, query = ''] = route.split('?');
  const parts = path!.split('/').filter(Boolean);
  if (parts[0] !== 'patients') return undefined;
  if (parts.length === 1) return <Patients />;
  if (parts[1] === 'new' && parts.length === 2) return <PatientRegister />;
  const id = parts[1]!;
  if (parts.length === 2) return <PatientChart key={id} patientId={id} />;
  if (parts[2] === 'visits' && parts[3]) return <ConsultationNote key={parts[3]} patientId={id} encounterId={parts[3]} />;
  if (parts[2] === 'compare') {
    const current = new URLSearchParams(query).get('current') ?? undefined;
    return <Comparison key={id} patientId={id} currentEncounterId={current} />;
  }
  return undefined;
}

/** Sidebar entries; `doctorOnly` items are hidden from the Secretary (SDD role matrix). */
const MENU: Array<{ label: string; path: string; doctorOnly?: boolean }> = [
  { label: 'Dashboard', path: '/dashboard' },
  { label: 'Patients', path: '/patients' },
  { label: 'Follow-Ups', path: '/follow-ups' },
  { label: 'Appointments', path: '/appointments' },
  { label: 'Documents', path: '/documents' },
  { label: 'Patient Intake', path: '/intake' },
  { label: 'Reports', path: '/reports' },
  { label: 'User Accounts', path: '/users', doctorOnly: true },
  { label: 'Audit Log', path: '/audit', doctorOnly: true },
];

export default function App() {
  const [user, setUser] = useState<User | null>();
  const [clinics, setClinics] = useState<Clinic[]>();
  const route = useRoute();

  // The patient-facing tablet form (S16) is its own surface: no staff
  // session, no app shell, authenticated only by the token in the URL. It
  // has to be checked before anything that assumes a signed-in user.
  const tabletToken = tabletTokenFromRoute(route);

  useEffect(() => {
    // Skip the session probe on the tablet. It would always 401 there, and
    // the failed call just adds noise to the audit log.
    if (tabletToken) return;
    api.me().then((r) => setUser(r.user), () => setUser(null));
  }, [tabletToken]);
  useEffect(() => {
    // On failure settle on an empty list rather than leaving it undefined,
    // so the UI explains itself instead of spinning forever.
    if (user) {
      void api.listClinics().then(
        (r) => setClinics(r.items),
        () => setClinics([]),
      );
    }
  }, [user]);

  if (tabletToken) return <TabletIntake token={tabletToken} />;

  if (user === undefined) return <p className="page">Loading…</p>;
  if (user === null) return <Login onLogin={setUser} />;

  const session: Session = {
    user,
    clinics: clinics ?? [],
    clinicsLoaded: clinics !== undefined,
    clinic: (clinics ?? []).find((c) => c.id === user.activeClinicId),
    selectClinic: async (id) => {
      await api.setActiveClinic(id);
      setUser({ ...user, activeClinicId: id });
    },
    logout: async () => {
      await api.logout();
      sessionStorage.clear(); // recent patients + drafts must not outlive the session on shared PCs
      setUser(null);
      go('/dashboard');
    },
  };

  return (
    <SessionContext.Provider value={session}>
      <Routes />
      <SessionTimeout onExpire={() => void session.logout()} />
    </SessionContext.Provider>
  );
}

function Routes() {
  const route = useRoute();
  const { user, clinic, clinics, clinicsLoaded, logout } = useSession();
  if (!clinicsLoaded) return <p className="page">Loading clinics…</p>;
  // A Secretary only sees clinics she is assigned to (UserClinic). A freshly
  // approved account has none until the Doctor assigns one, so say that
  // plainly rather than leaving her on a spinner.
  if (clinics.length === 0) {
    return (
      <div className="page">
        <h1>No clinic assigned yet</h1>
        <p className="muted">
          Your account is active, but it is not assigned to any clinic yet, so
          there is nothing to open. Ask Dr. Pacio to assign you to a clinic.
        </p>
        <button type="button" className="primary" onClick={() => void logout()}>
          Log Out
        </button>
      </div>
    );
  }
  // No active clinic yet (or the user asked to switch): S02 before anything else.
  if (!clinic || route === '/select-clinic') return <ClinicSelect />;

  const doctor = user.role === 'DOCTOR';
  let page: ReactNode;
  const patient = patientPage(route);
  if (patient) page = patient;
  else if (route === '/dashboard') page = <Dashboard />;
  else if (route === '/appointments') page = <Calendar />;
  else if (route === '/documents') page = <Documents />;
  else if (route === '/intake') page = <Intake />;
  else if (route === '/users')
    page = doctor ? <Users /> : <p>Only the Doctor can manage staff accounts.</p>;
  else if (route === '/audit')
    page = doctor ? <AuditLog /> : <p>Only the Doctor can view the audit log.</p>;
  else if (route.startsWith('/documents/new'))
    page = doctor ? <DocumentEditor /> : <p>Only the Doctor can prepare and sign documents.</p>;
  else {
    const item = MENU.find((m) => m.path === route);
    page = (
      <>
        <h1>{item?.label ?? 'Not found'}</h1>
        <p className="muted">This screen is not available yet.</p>
      </>
    );
  }
  return <Layout route={route}>{page}</Layout>;
}

/** App layout used by every screen: navy sidebar, top bar with the active clinic, role menu. */
function Layout({ route, children }: { route: string; children: ReactNode }) {
  const { user, clinic, clinics, selectClinic, logout } = useSession();
  const menu = MENU.filter((m) => !m.doctorOnly || user.role === 'DOCTOR');
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden /> EMR System
        </div>
        <nav aria-label="Main">
          {menu.map((m) => (
            <a
              key={m.path}
              href={`#${m.path}`}
              aria-current={route.split('?')[0].startsWith(m.path) ? 'page' : undefined}
            >
              {m.label}
            </a>
          ))}
        </nav>
      </aside>
      <div>
        <header className="topbar">
          <label className="sr-only" htmlFor="active-clinic">
            Active clinic
          </label>
          <select
            id="active-clinic"
            className="clinic-switch"
            value={clinic?.id}
            onChange={(e) => void selectClinic(e.target.value)}
          >
            {clinics.map((c) => (
              <option key={c.id} value={c.id}>
                Clinic: {c.name}
              </option>
            ))}
          </select>
          <span>{user.fullName}</span>
          <button className="primary" onClick={() => void logout()}>
            Log Out
          </button>
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}

