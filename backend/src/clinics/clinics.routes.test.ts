import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const db = vi.hoisted(() => ({
  clinic: { findMany: vi.fn(), count: vi.fn() },
}));
vi.mock('../prisma.js', () => ({ prisma: db }));

import { clinicsRouter } from './clinics.routes.js';
import { appWith, doctor, secretary } from '../testing/appWith.js';

beforeEach(() => {
  vi.resetAllMocks();
  db.clinic.findMany.mockResolvedValue([]);
  db.clinic.count.mockResolvedValue(0);
});

describe('S02: clinics a user may work in', () => {
  it('lists only the Secretary’s assigned clinics', async () => {
    await request(appWith('/api/clinics', clinicsRouter, secretary)).get('/api/clinics').expect(200);
    expect(db.clinic.findMany.mock.calls[0][0].where).toEqual({
      staff: { some: { userId: 'u-sec' } },
      isActive: true,
    });
  });

  it('lists every clinic for the Doctor', async () => {
    await request(appWith('/api/clinics', clinicsRouter, doctor)).get('/api/clinics').expect(200);
    expect(db.clinic.findMany.mock.calls[0][0].where).toEqual({ isActive: true });
  });
});
