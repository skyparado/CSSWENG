import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const db = vi.hoisted(() => ({
  clinic: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
}));
vi.mock('../prisma.js', () => ({ prisma: db }));

import { clinicsRouter } from './clinics.routes.js';
import { authRouter } from '../auth/auth.routes.js';
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

  it('refuses an unassigned clinic as the active clinic', async () => {
    db.clinic.findFirst.mockResolvedValue(null);
    const res = await request(appWith('/api/auth', authRouter, { ...secretary }))
      .put('/api/auth/active-clinic')
      .send({ clinicId: 'c2' });
    expect(res.status).toBe(404);
    expect(db.clinic.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'c2',
      isActive: true,
      staff: { some: { userId: 'u-sec' } },
    });
  });

  it('sets the active clinic on the session', async () => {
    db.clinic.findFirst.mockResolvedValue({ id: 'c2', isActive: true });
    const user = { ...secretary };
    const res = await request(appWith('/api/auth', authRouter, user)).put('/api/auth/active-clinic').send({ clinicId: 'c2' });
    expect(res.status).toBe(200);
    expect(user.activeClinicId).toBe('c2');
  });
});
