import { useEffect, useState } from 'react';
import { api, patientName, type PatientRef } from './api';

const RECENT_KEY = 'recentPatients';

/** Up to 5 patients most recently picked on this device (shown on the dashboard). */
export function recentPatients(): PatientRef[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as PatientRef[];
  } catch {
    return [];
  }
}

function remember(p: PatientRef) {
  const list = [p, ...recentPatients().filter((r) => r.id !== p.id)].slice(0, 5);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}

/** Search-as-you-type patient results. */
export function usePatientSearch(q: string): PatientRef[] {
  const [results, setResults] = useState<PatientRef[]>([]);
  useEffect(() => {
    if (!q.trim()) return setResults([]);
    const t = setTimeout(() => void api.searchPatients(q).then((r) => setResults(r.items), () => setResults([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  return results;
}

/** Patient field: search, pick, change. Calls `onChange` with the chosen patient. */
export default function PatientPicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value?: PatientRef;
  onChange: (p: PatientRef | undefined) => void;
}) {
  const [q, setQ] = useState('');
  const results = usePatientSearch(q);

  if (value)
    return (
      <div className="row">
        <strong id={id}>{patientName(value)}</strong>
        <button type="button" onClick={() => onChange(undefined)}>
          Change
        </button>
      </div>
    );
  return (
    <>
      <input id={id} placeholder="Search patient by name" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {results.length > 0 && (
        <div className="picker-results" role="listbox">
          {results.map((p) => (
            <button
              type="button"
              role="option"
              aria-selected={false}
              key={p.id}
              onClick={() => {
                remember(p);
                onChange(p);
                setQ('');
              }}
            >
              {patientName(p)}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
