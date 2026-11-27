import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLoad, useSession } from '../session';

const OUTCOME: Record<string, { label: string; tone: string }> = {
  BACKUP_REQUESTED: { label: 'Backup requested', tone: '' },
  BACKUP_COMPLETED: { label: 'Backup completed', tone: 'ok' },
  BACKUP_FAILED: { label: 'Backup failed', tone: 'bad' },
  RETENTION_PURGE_REQUESTED: { label: 'Retention purge requested', tone: '' },
  RETENTION_PURGE_COMPLETED: { label: 'Retention purge completed', tone: 'ok' },
  RETENTION_PURGE_FAILED: { label: 'Retention purge failed', tone: 'bad' },
};

/** "removed 0 audit entries, 2 exports, 1 backup" from a completed purge's counts. */
function purgeSummary(m: Record<string, unknown> | null): string | undefined {
  if (!m || typeof m.auditEntries !== 'number') return undefined;
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  const count = (v: unknown, one: string, many: string) => `${n(v)} ${n(v) === 1 ? one : many}`;
  return `removed ${count(m.auditEntries, 'audit entry', 'audit entries')}, ${count(m.exports, 'export', 'exports')}, ${count(m.backups, 'backup', 'backups')}`;
}

/**
 * Doctor only: run the encrypted backup, the retention purge or the reminder
 * scan now. All three normally run overnight, but the free hosting plan sleeps
 * when idle, so they may not.
 */
export default function SystemJobs() {
  const { clinic } = useSession();
  const history = useLoad(() => api.backupHistory(), []);
  const [msg, setMsg] = useState<{ text: string; error?: boolean }>();
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState(0);

  // A queued backup runs in the background; re-read its outcome a few times.
  useEffect(() => {
    if (watching <= 0) return;
    const t = setTimeout(() => {
      history.reload();
      setWatching(watching - 1);
    }, 3000);
    return () => clearTimeout(t);
  }, [watching, history.reload]);

  const run = (job: () => Promise<unknown>, done: string, watch = 0) => {
    setBusy(true);
    setMsg(undefined);
    job()
      .then(() => {
        setMsg({ text: done });
        setWatching(watch);
        history.reload();
      }, (e: Error) => setMsg({ text: e.message, error: true }))
      .finally(() => setBusy(false));
  };

  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: clinic!.timezone,
    }).format(new Date(iso));

  return (
    <section className="card" aria-label="System jobs" style={{ marginTop: 20 }}>
      <h2>System Jobs</h2>
      <p className="muted">
        Backups, the retention purge and reminder checks run every night. Use these to run them now, for example before a demo or a risky change.
      </p>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => run(api.runBackupNow, 'Backup started. Its result appears below.', 10)}>
          Back Up Now
        </button>
        <button
          disabled={busy}
          onClick={() => run(api.runReminderScanNow, 'Reminder check started. Sent reminders appear in each follow-up’s outreach log.')}
        >
          Send Due Reminders Now
        </button>
        <button
          disabled={busy}
          onClick={() =>
            run(api.runRetentionPurgeNow, 'Retention purge started. It removes only records already past retention; its result appears below.', 10)
          }
        >
          Run Retention Purge Now
        </button>
      </div>
      {msg && (
        <p className={msg.error ? 'error' : 'muted'} role={msg.error ? 'alert' : 'status'}>
          {msg.text}
        </p>
      )}
      <h3 style={{ fontSize: 15, marginTop: 16 }}>Recent backups and purges</h3>
      {history.error && <p className="error">{history.error}</p>}
      {history.data && history.data.items.length === 0 && <p className="muted">No backups or purges recorded yet.</p>}
      <ul className="history" aria-label="Recent backups">
        {(history.data?.items ?? []).map((b) => {
          const view = OUTCOME[b.action] ?? { label: b.action, tone: '' };
          const bytes = typeof b.metadata?.databaseBytes === 'number' ? b.metadata.databaseBytes : undefined;
          const purged = b.action === 'RETENTION_PURGE_COMPLETED' ? purgeSummary(b.metadata) : undefined;
          return (
            <li key={b.id}>
              <span className={`badge ${view.tone}`}>{view.label}</span> {fmt(b.createdAt)}
              {bytes !== undefined && <span className="muted"> · {(bytes / 1024).toFixed(0)} KB encrypted</span>}
              {purged && <span className="muted"> · {purged}</span>}
              {(b.action === 'BACKUP_FAILED' || b.action === 'RETENTION_PURGE_FAILED') && typeof b.metadata?.error === 'string' && (
                <div className="muted">{b.metadata.error}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
