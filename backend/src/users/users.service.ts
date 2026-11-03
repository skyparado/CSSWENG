import type { UserStatus } from '@prisma/client';
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
  lockedUntil: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

type DbUser = Awaited<ReturnType<typeof prisma.user.findUniqueOrThrow>>;
type PublicUser = Pick<DbUser, keyof typeof PUBLIC_SELECT>;

/** Narrow a Prisma row down to the shape the API returns. */
function toPublic(user: PublicUser): AdminUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    status: user.status,
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

export async function createUser(input: UserCreate): Promise<AdminUser> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw badRequest('A user with that email already exists');

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: {
      email: input.email,
      fullName: input.fullName,
      role: input.role,
      passwordHash,
      // Doctor-created accounts skip the approval queue.
      status: 'ACTIVE',
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

export function approveUser(id: string): Promise<AdminUser> {
  return transitionStatus(id, ['PENDING'], 'ACTIVE');
}

export function rejectUser(id: string): Promise<AdminUser> {
  return transitionStatus(id, ['PENDING'], 'REJECTED');
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