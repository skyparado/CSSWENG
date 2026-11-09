import { createHash } from 'node:crypto';

/**
 * Fields that participate in the hash. Order and set are both part of the
 * contract: changing them changes every row's hash, so bump this with care.
 */
const HASH_FIELDS = [
  'userId',
  'userEmail',
  'userRole',
  'action',
  'resourceType',
  'resourceId',
  'method',
  'path',
  'statusCode',
  'ipAddress',
  'userAgent',
  'metadata',
  'createdAt',
] as const;

export type HashableEntry = {
  userId: string | null;
  userEmail: string | null;
  userRole: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
  createdAt: Date;
};

/**
 * Canonical JSON of an entry's content: fields in a fixed order, no extra
 * whitespace, dates as ISO strings. Deterministic across runs and machines.
 */
function canonicalize(entry: HashableEntry): string {
  const normalized: Record<string, unknown> = {};
  for (const key of HASH_FIELDS) {
    const value = entry[key];
    if (value instanceof Date) {
      normalized[key] = value.toISOString();
    } else if (value === undefined) {
      normalized[key] = null;
    } else {
      normalized[key] = value;
    }
  }
  return JSON.stringify(normalized);
}

/**
 * SHA-256 of (previousHash || canonical content). The empty string is the
 * "zero" previousHash for the very first entry in the chain.
 */
export function computeEntryHash(
  entry: HashableEntry,
  previousHash: string,
): string {
  const content = canonicalize(entry);
  return createHash('sha256').update(previousHash).update(content).digest('hex');
}