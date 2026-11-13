import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, type ReportExportView, type ReportKey } from '../api';
import { chartFor, visibleTabs } from '../reportCharts';
import { useLoad, useSession } from '../session';
import { addDays, zonedParts } from '../time';

/** S17 Reports: five read-only reports with a Recharts chart, a table, and PDF/CSV exports prepared by a background job. */
export default function Reports() {
  const { user, clinic, clinics } = useSession();
  const doctor = user.role === 'DOCTOR';
  const today = zonedParts(new Date(), clinic!.timezone).date;
  const tabs = visibleTabs(user.role);

  const [report, setReport] = useState<ReportKey>('patient-volume');
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const [clinicId, setClinicId] = useState(doctor ? '' : clinic!.id); // '' = all clinics (Doctor)
  // The query that was last applied; changing a field does nothing until Apply, as in the wireframe.
  const [applied, setApplied] = useState({ report, from, to, clinicId });
  const [exportJob, setExportJob] = useState<ReportExportView>();
  const [exportError, setExportError] = useState<string>();

  const result = useLoad(
    () => api.report(applied.report, { from: applied.from, to: applied.to, clinicId: applied.clinicId || undefined }),
    [applied],
  );

  const apply = (next: Partial<typeof applied> = {}) => setApplied({ report, from, to, clinicId, ...next });
  const rangeOk = from <= to;

  // Poll the export job until the file is ready (SDD 5.2: large exports are rendered in the background).
  useEffect(() => {
    if (!exportJob || exportJob.status === 'READY' || exportJob.status === 'FAILED' || exportJob.status === 'EXPIRED') return;
    const t = setTimeout(() => {
      api.exportStatus(exportJob.id).then(setExportJob, (e: Error) => setExportError(e.message));
    }, 1500);
    return () => clearTimeout(t);
  }, [exportJob]);

  const startExport = (format: 'PDF' | 'CSV') => {
    setExportError(undefined);
    setExportJob(undefined);
    api
      .requestExport({ report: applied.report, format, from: applied.from, to: applied.to, clinicId: applied.clinicId || undefined })
      .then(setExportJob, (e: Error) => setExportError(e.message));
  };

  const r = result.data;
  const chart = r ? chartFor(r) : null;

  return (
    <>
      <p className="muted">Reports</p>
      <h1>Reports</h1>

      <div className="tabs" role="tablist" aria-label="Reports">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={report === t.key}
            onClick={() => {
              setReport(t.key);
              apply({ report: t.key });
              setExportJob(undefined);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <section className="card report-controls" aria-label="Report filters">
        <div>
          <label htmlFor="r-from">From</label>
          <input id="r-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label htmlFor="r-to">To</label>
          <input id="r-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <label htmlFor="r-clinic">Clinic</label>
          <select id="r-clinic" value={clinicId} disabled={!doctor} onChange={(e) => setClinicId(e.target.value)}>
            {doctor && <option value="">All clinics</option>}
            {(doctor ? clinics : clinics.filter((c) => c.id === clinic!.id)).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <button className="primary" disabled={!rangeOk} onClick={() => apply()}>
          Apply
        </button>
        <span className="row" style={{ marginLeft: 'auto' }}>
          <button disabled={!r} onClick={() => startExport('PDF')}>
            Export PDF
          </button>
          <button disabled={!r} onClick={() => startExport('CSV')}>
            Export CSV
          </button>
        </span>
      </section>
      {!rangeOk && <p className="error" role="alert">The start date must not be after the end date.</p>}

      {(exportJob || exportError) && (
        <p className={exportError || exportJob?.status === 'FAILED' ? 'error' : 'notice'} role="status" style={{ marginTop: 12 }}>
          {exportError ??
            (exportJob?.status === 'READY' ? (
              <>
                Your {exportJob.format} is ready:{' '}
                <a href={`/api/reports/exports/${exportJob.id}/download`} download>
                  Download {exportJob.fileName}
                </a>
              </>
            ) : exportJob?.status === 'FAILED' ? (
              `The export failed: ${exportJob.error ?? 'unknown error'}`
            ) : (
              `Preparing your ${exportJob?.format} in the background…`
            ))}
        </p>
      )}

      {result.error && <p className="error" role="alert" style={{ marginTop: 16 }}>{result.error}</p>}
      {!r && !result.error && <p style={{ marginTop: 16 }}>Loading…</p>}

      {r && (
        <>
          <div className="stats" aria-label="Summary">
            {r.summary.map((s) => (
              <div key={s.key} className={`card stat${s.tone ? ` ${s.tone}` : ''}`}>
                <b>{s.value}</b>
                {s.label}
              </div>
            ))}
          </div>

          <div className="split-wide report-body">
            <section className="card" aria-label="Chart">
              <h2>{chart?.title ?? r.title}</h2>
              {chart ? (
                <div role="img" aria-label={`${chart.title}: ${chart.data.length} bars`} style={{ width: '100%', height: 320 }}>
                  <ResponsiveContainer>
                    <BarChart data={chart.data} layout={chart.horizontal ? 'vertical' : 'horizontal'} margin={{ top: 16, right: 16, left: 0, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#dde3ec" />
                      {chart.horizontal ? (
                        <>
                          <XAxis type="number" allowDecimals={false} />
                          <YAxis type="category" dataKey={chart.xKey} width={150} />
                        </>
                      ) : (
                        <>
                          <XAxis dataKey={chart.xKey} />
                          <YAxis allowDecimals={false} />
                        </>
                      )}
                      <Tooltip />
                      {chart.series.length > 1 && <Legend />}
                      {chart.series.map((s) => (
                        <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} stackId={chart.series.length > 1 ? 'a' : undefined} isAnimationActive={false} />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="muted">No data for this period.</p>
              )}
            </section>

            <section className="card" aria-label="Detail">
              <h2>{report === 'patient-volume' ? 'Daily Detail' : 'Detail'}</h2>
              {r.rows.length === 0 ? (
                <p className="muted">No data for this period.</p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table>
                    <thead>
                      <tr>
                        {r.columns.map((c) => (
                          <th key={c.key}>{c.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {r.rows.map((row, i) => (
                        <tr key={i} data-testid="report-row">
                          {r.columns.map((c) => (
                            <td key={c.key}>{row[c.key]}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {r.note && <p className="muted" style={{ marginTop: 12 }}>{r.note}</p>}
              <p className="muted" style={{ marginTop: 12 }}>
                {doctor ? 'Doctor view: all three clinics.' : 'The Secretary sees patient volume for the active clinic only.'}
              </p>
            </section>
          </div>
        </>
      )}

      <p className="muted" style={{ marginTop: 16 }}>
        Reports are read-only. Every report view and export is recorded in the audit log. Large exports are prepared in the background.
      </p>
    </>
  );
}
