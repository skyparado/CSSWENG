import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A small in-memory database that behaves like Postgres where it matters here:
 *  - `SELECT ... FOR UPDATE` on a follow-up blocks a second transaction on the
 *    same row until the first one finishes;
 *  - reads and writes take a tick, so two un-serialised callers really do
 *    interleave (both read the same MAX before either inserts);
 *  - (followUpId, attemptNumber) is unique, like the index in the migration.
 */
const sim = vi.hoisted(() => {
  const state = {
    logs: [] as Array<{ followUpId: string; attemptNumber: number; outcome: string }>,
    followUps: new Map<string, { id: string; status: string }>(),
    locks: new Map<string, Promise<void>>(),
    audit: [] as Array<Record<string, unknown>>,
    useLock: true,
  };
  const tick = () => new Promise<void>((r) => setTimeout(r, 1));

  function makeTx(release: Array<() => void>) {
    return {
      async $queryRaw(_strings: TemplateStringsArray, followUpId: string) {
        if (!state.useLock) return [];
        while (state.locks.has(followUpId)) await state.locks.get(followUpId);
        let done!: () => void;
        state.locks.set(followUpId, new Promise<void>((r) => (done = r)));
        release.push(() => {
          state.locks.delete(followUpId);
          done();
        });
        return [{ id: followUpId }];
      },
      outreachLog: {
        async aggregate({ where }: { where: { followUpId: string } }) {
          await tick();
          const mine = state.logs.filter((l) => l.followUpId === where.followUpId);
          return {
            _max: { attemptNumber: mine.length ? Math.max(...mine.map((l) => l.attemptNumber)) : null },
          };
        },
        async create({ data }: { data: { followUpId: string; attemptNumber: number; outcome: string } }) {
          await tick();
          if (
            state.logs.some(
              (l) => l.followUpId === data.followUpId && l.attemptNumber === data.attemptNumber,
            )
          ) {
            throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
          }
          state.logs.push({ ...data });
          return { id: `o${state.logs.length}`, ...data };
        },
        async count({ where }: { where: { followUpId: string } }) {
          return state.logs.filter((l) => l.followUpId === where.followUpId && l.outcome !== 'REACHED')
            .length;
        },
      },
      followUp: {
        async findUnique({ where }: { where: { id: string } }) {
          const row = state.followUps.get(where.id);
          return row ? { ...row } : null; // a snapshot, like a real read
        },
        async update({ where, data }: { where: { id: string }; data: { status: string } }) {
          Object.assign(state.followUps.get(where.id) as object, data);
          return state.followUps.get(where.id);
        },
        async updateMany({ where, data }: { where: { id: string; status: string }; data: { status: string } }) {
          const row = state.followUps.get(where.id);
          if (!row || row.status !== where.status) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
        async findUniqueOrThrow({ where }: { where: { id: string } }) {
          return { id: where.id, patientId: 'p1', clinicId: 'c1' };
        },
      },
    };
  }

  const prisma = {
    async $transaction(fn: (tx: unknown) => Promise<unknown>) {
      const release: Array<() => void> = [];
      try {
        return await fn(makeTx(release));
      } finally {
        release.forEach((r) => r());
      }
    },
  };
  return { state, prisma };
});

vi.mock('../prisma.js', () => ({ prisma: sim.prisma }));
vi.mock('../audit/audit.service.js', () => ({
  writeAudit: vi.fn(async (entry: Record<string, unknown>) => {
    sim.state.audit.push(entry);
    return entry;
  }),
}));

import { logOutreachAttempt } from './outreach.service.js';

const followUp = { id: 'f1', patientId: 'p1', clinicId: 'c1' };
const call = (outcome: 'REACHED' | 'NO_ANSWER' | 'DECLINED' | 'LEFT_MESSAGE' = 'LEFT_MESSAGE') =>
  logOutreachAttempt({ followUp, channel: 'CALL', outcome, contactedById: 'u1' });

beforeEach(() => {
  sim.state.logs.length = 0;
  sim.state.audit.length = 0;
  sim.state.locks.clear();
  sim.state.useLock = true;
  sim.state.followUps.clear();
  sim.state.followUps.set('f1', { id: 'f1', status: 'OPEN' });
});

describe('logOutreachAttempt: simultaneous attempts', () => {
  it('gives ten attempts logged at the same moment ten different numbers', async () => {
    const logs = await Promise.all(Array.from({ length: 10 }, () => call()));

    const numbers = logs.map((l) => l.attemptNumber).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(sim.state.logs.map((l) => l.attemptNumber)).size).toBe(10);
  });

  it('would collide without the row lock (proves the simulation really interleaves)', async () => {
    sim.state.useLock = false;
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => call()));
    // Every caller read the same MAX, so the unique index rejects all but one.
    expect(results.filter((r) => r.status === 'rejected').length).toBeGreaterThan(0);
  });

  it('keeps attempts for different follow-ups independent', async () => {
    sim.state.followUps.set('f2', { id: 'f2', status: 'OPEN' });
    const other = { id: 'f2', patientId: 'p2', clinicId: 'c1' };
    const [a, b] = await Promise.all([
      call(),
      logOutreachAttempt({ followUp: other, channel: 'CALL', outcome: 'LEFT_MESSAGE' }),
    ]);
    expect([a.attemptNumber, b.attemptNumber]).toEqual([1, 1]);
  });

  it('closes the task as declined exactly once when two declines race, and audits once', async () => {
    await Promise.all([call('DECLINED'), call('DECLINED')]);

    expect(sim.state.followUps.get('f1')?.status).toBe('DECLINED');
    expect(sim.state.logs.map((l) => l.attemptNumber).sort()).toEqual([1, 2]);
    const statusAudits = sim.state.audit.filter((e) => e.action === 'FOLLOW_UP_STATUS_CHANGED');
    expect(statusAudits).toHaveLength(1);
  });
});

describe('logOutreachAttempt: attempt and status change are atomic', () => {
  it('runs the insert, the status change and the audit entry in one transaction', async () => {
    const spy = vi.spyOn(sim.prisma, '$transaction');
    await call('DECLINED');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(sim.state.followUps.get('f1')?.status).toBe('DECLINED');
    expect(sim.state.audit[0]).toMatchObject({
      action: 'FOLLOW_UP_STATUS_CHANGED',
      metadata: { from: 'OPEN', to: 'DECLINED', via: 'OUTREACH_DECLINED' },
    });
    spy.mockRestore();
  });

  it('does not touch a task that was already closed', async () => {
    sim.state.followUps.set('f1', { id: 'f1', status: 'COMPLETED' });
    await call('DECLINED');
    expect(sim.state.followUps.get('f1')?.status).toBe('COMPLETED');
    expect(sim.state.audit).toHaveLength(0);
  });
});
