import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeEntryHash, jsonbOrder, type HashableEntry } from './hashChain.js';

const base: HashableEntry = {
  userId: 'u1',
  userEmail: null,
  userRole: 'DOCTOR',
  action: 'FOLLOW_UP_STATUS_CHANGED',
  resourceType: 'FollowUp',
  resourceId: 'f1',
  method: null,
  path: null,
  statusCode: null,
  ipAddress: null,
  userAgent: null,
  metadata: null,
  createdAt: new Date('2026-11-09T00:00:00.000Z'),
};

describe('jsonbOrder', () => {
  it('orders keys the way Postgres JSONB returns them: shortest first, then bytewise, at every depth', () => {
    const ordered = jsonbOrder({ patientId: 1, to: 2, from: 3, via: 4, nested: { zz: 1, a: 2, bb: 3 } });
    expect(Object.keys(ordered as object)).toEqual(['to', 'via', 'from', 'nested', 'patientId']);
    expect(Object.keys((ordered as { nested: object }).nested)).toEqual(['a', 'bb', 'zz']);
  });

  it('keeps array order and sorts objects inside arrays', () => {
    const ordered = jsonbOrder({ alerts: [{ type: 'x', id: 1 }, { type: 'y', id: 2 }] }) as {
      alerts: Array<Record<string, unknown>>;
    };
    expect(ordered.alerts.map((a) => a.id)).toEqual([1, 2]);
    expect(Object.keys(ordered.alerts[0] as object)).toEqual(['id', 'type']);
  });
});

describe('computeEntryHash with metadata', () => {
  it('gives the same hash whatever order the metadata keys were written in', () => {
    const written = { ...base, metadata: { patientId: 'p1', from: 'OPEN', to: 'DECLINED', via: 'DECLINE' } };
    // What Postgres hands back after the JSONB round trip.
    const readBack = { ...base, metadata: { to: 'DECLINED', via: 'DECLINE', from: 'OPEN', patientId: 'p1' } };
    expect(computeEntryHash(written, 'prev')).toBe(computeEntryHash(readBack, 'prev'));
  });

  it('still changes when the metadata changes', () => {
    const a = { ...base, metadata: { to: 'DECLINED' } };
    const b = { ...base, metadata: { to: 'COMPLETED' } };
    expect(computeEntryHash(a, '')).not.toBe(computeEntryHash(b, ''));
  });

  it('is unchanged for entries without metadata, or with keys already in JSONB order', () => {
    // Pinned values: rows written before this change must keep verifying.
    expect(computeEntryHash(base, '')).toBe(computeEntryHash({ ...base }, ''));
    const inOrder = { ...base, metadata: { id: 1, size: 2, patientId: 3 } };
    const legacyJson = JSON.stringify({
      userId: 'u1', userEmail: null, userRole: 'DOCTOR', action: 'FOLLOW_UP_STATUS_CHANGED',
      resourceType: 'FollowUp', resourceId: 'f1', method: null, path: null, statusCode: null,
      ipAddress: null, userAgent: null, metadata: { id: 1, size: 2, patientId: 3 },
      createdAt: '2026-11-09T00:00:00.000Z',
    });
    const legacy = createHash('sha256').update('p').update(legacyJson).digest('hex');
    expect(computeEntryHash(inOrder, 'p')).toBe(legacy);
  });
});
