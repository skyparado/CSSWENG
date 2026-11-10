import type { Prisma, UserStatus } from '@prisma/client';
import { prisma } from '../prisma.js';
import { badRequest, notFound } from '../http.js';
import { hashPassword } from '../auth/auth.service.js';
import type {
  AdminUser,
  UserCreate,
  UserListQuery,
  UserUpdate,
} from '@clinic/schemas';

/**
 * Service layer for user administration. All functions assume the caller has
 * already been authorized as a Doctor by the route-level middleware.
 */

/** Columns the API ever returns. Excludes passwordHash and lockout internals. */
const PUBLIC_SELECT = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  status: true,
  requestedRole: true,
  approvedById: true,
  approvedAt: true,
  lockedUntil: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  // Which clinics this account may work in (US-04, US-06, SDD gap H2).
  clinics: { select: { clinicId: true } },
} as const;

/**
 * Exactly what PUBLIC_SELECT returns. Spelled out rather than derived from
 * the model, because the select now pulls in a relation as well as columns.
 */
type PublicUser = Prisma.UserGetPayload<{ select: typeof PUBLIC_SELECT }>;

/** Narrow a Prisma row down to the shape the API returns. */
function toPublic(user: PublicUser): AdminUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    status: user.status,
    requestedRole: user.requestedRole,
    approvedById: user.approvedById,
    approvedAt: user.approvedAt,
    clinicIds: user.clinics.map((c) => c.clinicId),
    lockedUntil: user.lockedUntil,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function listUsers(query: UserListQuery): Promise<{
  items: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const { page, pageSize, status, role } = query;
  const where = {
    ...(status ? { status } : {}),
    ...(role ? { role } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: PUBLIC_SELECT,
      orderBy: [{ createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.user.count({ where }),
  ]);
  return { items: rows.map(toPublic), total, page, pageSize };
}

export async function getUser(id: string): Promise<AdminUser> {
  const user = await prisma.user.findUnique({ where: { id }, select: PUBLIC_SELECT });
  if (!user) throw notFound('User not found');
  return toPublic(user);
}

export async function createUser(
  input: UserCreate,
  actingDoctorId?: string,
): Promise<AdminUser> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw badRequest('A user with that email already exists');

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: {
      email: input.email,
      fullName: input.fullName,
      role: input.role,
      passwordHash,
      // Doctor-created accounts skip the approval queue, so the requested and
      // granted role are the same and the doctor who made it is the approver.
      requestedRole: input.role,
      status: 'ACTIVE',
      approvedById: actingDoctorId ?? null,
      approvedAt: new Date(),
    },
    select: PUBLIC_SELECT,
  });
  return toPublic(user);
}

export async function updateUser(id: string, input: UserUpdate): Promise<AdminUser> {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) throw notFound('User not found');

  const user = await prisma.user.update({
    where: { id },
    data: {
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
    },
    select: PUBLIC_SELECT,
  });
  return toPublic(user);
}

/* ----------------------- Status-transition operations --------------------- */

async function transitionStatus(
  id: string,
  allowedFrom: UserStatus[],
  nextStatus: UserStatus,
  extra: Record<string, unknown> = {},
): Promise<AdminUser> {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) throw notFound('User not found');

  if (!allowedFrom.includes(existing.status)) {
    throw badRequest(
      `Cannot move a ${existing.status} account to ${nextStatus}. ` +
        `Allowed from: ${allowedFrom.join(', ')}.`,
    );
  }

  const user = await prisma.user.update({
    where: { id },
    data: { status: nextStatus, ...extra },
    select: PUBLIC_SELECT,
  });
  return toPublic(user);
}

/**
 * PENDING -> ACTIVE. `grantedRole` lets the doctor hand out a different role
 * than the one the account asked for; leaving it off keeps the existing role.
 * Either way the enforced role is `role`, never `requestedRole`.
 */
export async function approveUser(
  id: string,
  actingDoctorId?: string,
  grantedRole?: AdminUser['role'],
  clinicIds?: string[],
): Promise<AdminUser> {
  const approved = await transitionStatus(id, ['PENDING'], 'ACTIVE', {
    approvedById: actingDoctorId ?? null,
    approvedAt: new Date(),
    ...(grantedRole ? { role: grantedRole } : {}),
  });

  // The user-to-clinic authorization step US-04 and US-06 ask for. Left off,
  // the account is approved with no clinics and the Secretary is told to ask
  // the Doctor for one, rather than silently seeing every clinic.
  if (clinicIds) {
    return assignClinics(id, clinicIds);
  }
  return approved;
}

/**
 * Replace the set of clinics an account may work in.
 *
 * A replace rather than an add so the call is idempotent and the Doctor can
 * see exactly what the account will end up with. Unknown or inactive clinic
 * ids are rejected instead of ignored, otherwise a typo would quietly grant
 * nothing.
 */
export async function assignClinics(
  id: string,
  clinicIds: string[],
): Promise<AdminUser> {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) throw notFound('User not found');

  const unique = [...new Set(clinicIds)];
  if (unique.length > 0) {
    const found = await prisma.clinic.findMany({
      where: { id: { in: unique }, isActive: true },
      select: { id: true },
    });
    if (found.length !== unique.length) {
      const known = new Set(found.map((c) => c.id));
      const missing = unique.filter((cid) => !known.has(cid));
      throw badRequest(
        `Unknown or inactive clinic: ${missing.join(', ')}`,
      );
    }
  }

  // One transaction so a failure cannot leave the account with a partial set,
  // which would silently widen or narrow access.
  await prisma.$transaction([
    prisma.userClinic.deleteMany({ where: { userId: id } }),
    ...(unique.length > 0
      ? [
          prisma.userClinic.createMany({
            data: unique.map((clinicId) => ({ userId: id, clinicId })),
          }),
        ]
      : []),
  ]);

  const user = await prisma.user.findUniqueOrThrow({
    where: { id },
    select: PUBLIC_SELECT,
  });
  return toPublic(user);
}

export function rejectUser(id: string, actingDoctorId?: string): Promise<AdminUser> {
  return transitionStatus(id, ['PENDING'], 'REJECTED', {
    approvedById: actingDoctorId ?? null,
    approvedAt: new Date(),
  });
}

export function revokeUser(id: string): Promise<AdminUser> {
  return transitionStatus(id, ['ACTIVE', 'LOCKED'], 'REVOKED');
}

export function reinstateUser(id: string): Promise<AdminUser> {
  // Reinstating a REVOKED or REJECTED account clears any stale lockout state.
  return transitionStatus(id, ['REVOKED', 'REJECTED'], 'ACTIVE', {
    failedLoginAttempts: 0,
    firstFailedLoginAt: null,
    lockedUntil: null,
  });
}

export function unlockUser(id: string): Promise<AdminUser> {
  // Doctor manually unlocks an account that hit the failed-login threshold.
  return transitionStatus(id, ['LOCKED'], 'ACTIVE', {
    failedLoginAttempts: 0,
    firstFailedLoginAt: null,
    lockedUntil: null,
  });
}

export async function resetPassword(id: string, newPassword: string): Promise<AdminUser> {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) throw notFound('User not found');

  const passwordHash = await hashPassword(newPassword);
  const user = await prisma.user.update({
    where: { id },
    data: {
      passwordHash,
      // A password reset also clears lockout counters.
      failedLoginAttempts: 0,
      firstFailedLoginAt: null,
      lockedUntil: null,
    },
    select: PUBLIC_SELECT,
  });
  return toPublic(user);
}