import { Suspense, lazy, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, type Clinic, type User } from './api';
import { SessionContext, go, useRoute, useSession, type Session } from './session';
import ClinicSelect from './pages/ClinicSelect';
import Dashboard from './pages/Dashboard';
import Calendar from './pages/Calendar';
import DocumentEditor from './pages/DocumentEditor';
import Documents from './pages/Documents';
import FollowUps from './pages/FollowUps';
import Outreach, { followUpIdFromOutreachRoute } from './pages/Outreach';
import Medications, { MedicationsLanding, patientIdFromMedicationsRoute } from './pages/Medications';
// Recharts is large; load it only when the Reports page is opened.
const Reports = lazy(() => import('./pages/Reports'));

/** Sidebar entries; `doctorOnly` items are hidden from the Secretary (SDD role matrix). */
const MENU: Array<{ label: string; path: string; doctorOnly?: boolean }> = [
  { label: 'Dashboard', path: '/dashboard' },
  { label: 'Patients', path: '/patients' },
  { label: 'Follow-Ups', path: '/follow-ups' },
  { label: 'Medications', path: '/medications', doctorOnly: true },
  { label: 'Appointments', path: '/appointments' },
  { label: 'Documents', path: '/documents' },
  { label: 'Reports', path: '/reports' },
  { label: 'User Accounts', path: '/users', doctorOnly: true },
  { label: 'Audit Log', path: '/audit', doctorOnly: true },
];

export default function App() {
  const [user, setUser] = useState<User | null>();
  const [clinics, setClinics] = useState<Clinic[]>([]);

  useEffect(() => {
    api.me().then((r) => setUser(r.user), () => setUser(null));
  }, []);
  useEffect(() => {
    if (user) void api.listClinics().then((r) => setClinics(r.items));
  }, [user]);

  if (user === undefined) return <p className="page">Loading…</p>;
  if (user === null) return <Login onLogin={setUser} />;

  const session: Session = {
    user,
    clinics,
    clinic: clinics.find((c) => c.id === user.activeClinicId),
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
    </SessionContext.Provider>
  );
}

function Routes() {
  const route = useRoute();
  const { user, clinic, clinics } = useSession();
  if (clinics.length === 0) return <p className="page">Loading clinics…</p>;
  // No active clinic yet (or the user asked to switch): S02 before anything else.
  if (!clinic || route === '/select-clinic') return <ClinicSelect />;

  const doctor = user.role === 'DOCTOR';
  let page: ReactNode;
  if (route === '/dashboard') page = <Dashboard />;
  // Match on the path only: links such as #/appointments?patientId=... carry a query string.
  else if (route.split('?')[0] === '/appointments') page = <Calendar />;
  else if (route.split('?')[0] === '/documents') page = <Documents />;
  else if (followUpIdFromOutreachRoute(route)) page = <Outreach key={route} followUpId={followUpIdFromOutreachRoute(route)!} />;
  else if (route === '/follow-ups' || route.startsWith('/follow-ups?')) page = <FollowUps />;
  else if (route.startsWith('/reports'))
    page = (
      <Suspense fallback={<p>Loading…</p>}>
        <Reports />
      </Suspense>
    );
  else if (patientIdFromMedicationsRoute(route))
    page = doctor ? (
      <Medications key={route} patientId={patientIdFromMedicationsRoute(route)!} />
    ) : (
      <p>Only the Doctor can view medications and allergies.</p>
    );
  else if (route.startsWith('/medications'))
    page = doctor ? <MedicationsLanding /> : <p>Only the Doctor can view medications and allergies.</p>;
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

function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    api.login(email, password).then(
      (r) => onLogin(r.user),
      (err: Error) => setError(err.message),
    );
  };
  return (
    <>
      <header className="topbar solo">
        <div className="brand">
          <span className="brand-mark" aria-hidden /> EMR System
        </div>
      </header>
      <form className="card" style={{ maxWidth: 420, margin: '60px auto' }} onSubmit={submit}>
        <h1>Sign in</h1>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label htmlFor="password">Password</label>
        <div style={{ position: 'relative' }}>
          <input id="password" type={showPw ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ paddingRight: 52 }} />
          <button
            type="button"
            aria-label={showPw ? 'Hide password' : 'Show password'}
            onClick={() => setShowPw(!showPw)}
            style={{ position: 'absolute', right: 0, top: 0, bottom: 0, minWidth: 44, minHeight: 44, background: 'none', border: 0 }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
              <circle cx="12" cy="12" r="3" />
              {showPw && <line x1="3" y1="3" x2="21" y2="21" />}
            </svg>
          </button>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" style={{ marginTop: 16, width: '100%' }}>
          Sign in
        </button>
      </form>
    </>
  );
}
