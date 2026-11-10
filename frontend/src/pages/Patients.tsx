import { useState, type FormEvent } from 'react';
import { clinicalApi, formatDate, fullName, SEX_LABEL, type PatientScope, type SearchBy } from '../clinicalApi';
import { go, useLoad } from '../session';

const PAGE_SIZE = 20;

const SEARCH_BY: Array<{ value: SearchBy; label: string }> = [
  { value: 'all', label: 'All fields' },
  { value: 'name', label: 'Name' },
  { value: 'birthDate', label: 'Birth date' },
  { value: 'phone', label: 'Phone' },
  { value: 'patientId', label: 'Patient ID' },
];

const SCOPES: Array<{ value: PatientScope; label: string }> = [
  { value: 'all', label: 'All patients' },
  { value: 'clinic', label: 'Seen at this clinic' },
  { value: 'followup', label: 'Due for follow-up' },
];

/** S04 Patient Search and List. Names are matched exactly (they are stored encrypted). */
export default function Patients() {
  const [input, setInput] = useState('');
  const [by, setBy] = useState<SearchBy>('all');
  const [query, setQuery] = useState({ q: '', by: 'all' as SearchBy });
  const [scope, setScope] = useState<PatientScope>('all');
  const [page, setPage] = useState(1);

  const { data, error } = useLoad(
    () => clinicalApi.searchPatients({ ...query, scope, page, pageSize: PAGE_SIZE }),
    [query.q, query.by, scope, page],
  );

  const search = (e: FormEvent) => {
    e.preventDefault();
    setPage(1);
    setQuery({ q: input.trim(), by });
  };
  const clear = () => {
    setInput('');
    setPage(1);
    setQuery({ q: '', by });
  };

  const first = data ? (data.page - 1) * data.pageSize + 1 : 0;
  const last = data ? Math.min(data.page * data.pageSize, data.total) : 0;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <div className="row between">
        <div>
          <h1>Patients</h1>
          <p className="muted">Search for a patient or register a new one.</p>
        </div>
        <a className="btn primary" href="#/patients/new">
          + New Patient
        </a>
      </div>

      <form className="card row search-bar" onSubmit={search} role="search">
        <label className="sr-only" htmlFor="patient-q">
          Search patients
        </label>
        <input
          id="patient-q"
          className="grow"
          placeholder="Name, birth date (MM/DD/YYYY), phone or patient ID"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <label className="sr-only" htmlFor="search-by">
          Search by
        </label>
        <select id="search-by" className="auto" value={by} onChange={(e) => setBy(e.target.value as SearchBy)}>
          {SEARCH_BY.map((s) => (
            <option key={s.value} value={s.value}>
              Search by: {s.label}
            </option>
          ))}
        </select>
        {query.q && (
          <button type="button" onClick={clear}>
            Clear
          </button>
        )}
        <button className="primary">Search</button>
      </form>

      <div className="row between">
        <div className="pills" role="group" aria-label="Filter">
          {SCOPES.map((s) => (
            <button
              key={s.value}
              type="button"
              aria-pressed={scope === s.value}
              onClick={() => {
                setScope(s.value);
                setPage(1);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
        {data && (
          <span className="muted" aria-live="polite">
            {data.total} {data.total === 1 ? 'patient' : 'patients'} found
          </span>
        )}
      </div>

      <section className="card">
        {error && <p className="error">{error}</p>}
        {!data && !error && <p>Loading…</p>}
        {data && data.items.length === 0 && (
          <p className="muted">
            No patients match. Names must be typed in full (for example “Santos” or “Maria Santos”).
          </p>
        )}
        {data && data.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Patient ID</th>
                <th>Name</th>
                <th>Birth date (Age)</th>
                <th>Sex</th>
                <th>Phone</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id}>
                  <td className="muted">{p.patientNumber}</td>
                  <td>
                    <strong>{fullName(p)}</strong>
                  </td>
                  <td>
                    {formatDate(p.dateOfBirth)} ({p.age})
                  </td>
                  <td>{SEX_LABEL[p.sex][0]}</td>
                  <td>{p.maskedPhone}</td>
                  <td>
                    <button type="button" onClick={() => go(`/patients/${p.id}`)} aria-label={`Open ${fullName(p)}`}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && data.total > 0 && (
          <div className="pager">
            <span className="muted">
              Showing {first}–{last} of {data.total}
            </span>
            <div className="row">
              <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                ‹ Prev
              </button>
              <span>
                Page {page} of {pages}
              </span>
              <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Next ›
              </button>
            </div>
          </div>
        )}
      </section>
      <p className="muted">
        Not found? Register the patient with “+ New Patient.” The system will warn you if a similar record already exists.
      </p>
    </>
  );
}
