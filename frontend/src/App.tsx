import { useEffect, useState } from 'react';
import { api, type Clinic } from './api';

/**
 * Frontend shell for the Oct 19 demo: a clinic selector backed by the live
 * API. Login/roles, patient registration and the follow-up list are owned by
 * other developers and plug in alongside this screen.
 */
export default function App() {
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listClinics()
      .then((res) => {
        setClinics(res.items);
        if (res.items[0]) setSelectedId(res.items[0].id);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Failed to load clinics'),
      )
      .finally(() => setLoading(false));
  }, []);

  const selected = clinics.find((c) => c.id === selectedId);

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <h1 style={styles.h1}>Clinic Management</h1>
        <span style={styles.badge}>Dev 1 shell</span>
      </header>

      <section style={styles.card}>
        <label htmlFor="clinic" style={styles.label}>
          Select clinic
        </label>
        {loading && <p>Loading clinics…</p>}
        {error && <p style={styles.error}>Error: {error}</p>}
        {!loading && !error && clinics.length === 0 && (
          <p>No clinics yet. Create one via <code>POST /api/clinics</code> or run the seed.</p>
        )}
        {clinics.length > 0 && (
          <select
            id="clinic"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            style={styles.select}
          >
            {clinics.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}

        {selected && (
          <dl style={styles.details}>
            <div style={styles.row}>
              <dt style={styles.dt}>Address</dt>
              <dd style={styles.dd}>{selected.address ?? '—'}</dd>
            </div>
            <div style={styles.row}>
              <dt style={styles.dt}>Phone</dt>
              <dd style={styles.dd}>{selected.phone ?? '—'}</dd>
            </div>
            <div style={styles.row}>
              <dt style={styles.dt}>Timezone</dt>
              <dd style={styles.dd}>{selected.timezone}</dd>
            </div>
          </dl>
        )}
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: 640,
    margin: '0 auto',
    padding: 24,
    color: '#111827',
  },
  header: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 },
  h1: { fontSize: 24, margin: 0 },
  badge: {
    fontSize: 12,
    background: '#e0e7ff',
    color: '#3730a3',
    padding: '2px 8px',
    borderRadius: 999,
  },
  card: { border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 },
  label: { display: 'block', fontWeight: 600, marginBottom: 8 },
  select: { width: '100%', padding: 8, fontSize: 15, borderRadius: 8, border: '1px solid #d1d5db' },
  details: { marginTop: 20 },
  row: { display: 'flex', borderTop: '1px solid #f3f4f6', padding: '8px 0' },
  dt: { width: 120, color: '#6b7280' },
  dd: { margin: 0 },
  error: { color: '#b91c1c' },
};
