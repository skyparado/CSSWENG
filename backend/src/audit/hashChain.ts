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
 * `metadata` is stored in a Postgres JSONB column, which does not keep the key
 * order it was given: it returns object keys shortest first, then in byte
 * order, at every depth. Hashing the keys in insertion order at write time and
 * in JSONB order at verify time made any entry with several metadata keys look
 * tampered with. Hashing in JSONB's own order makes the two agree; an entry
 * whose keys were already in that order hashes exactly as before.
 */
export function jsonbOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value).sort(
      (a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)),
    );
    for (const key of keys) sorted[key] = jsonbOrder((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value;
}

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
    } else if (key === 'metadata') {
      normalized[key] = jsonbOrder(value);
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