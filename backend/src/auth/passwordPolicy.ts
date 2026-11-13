import argon2 from 'argon2';
import { badRequest } from '../http.js';
import { isBreachedPassword } from './breachedPasswords.js';

/** How many previous passwords an account may not reuse (SDD 7.2). */
export const PASSWORD_HISTORY_SIZE = 5;

/** Letters only, lowercased, so "Pacio2026!" and "pacio" compare equal. */
function letters(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Pieces of the account a password must not be built from: the username, the
 * email local part, each dotted or hyphenated piece of either, the domain
 * label, and each part of the person's name. Short pieces are dropped, otherwise a surname like "Li"
 * would reject almost everything.
 */
function identityTerms(account: {
  username?: string;
  email: string;
  fullName: string;
}): string[] {
  const [local = '', domain = ''] = account.email.toLowerCase().split('@');
  const username = (account.username ?? '').toLowerCase();
  const pieces = [
    username,
    ...username.split(/[._-]/),
    local,
    ...local.split(/[._+-]/),
    domain.split('.')[0] ?? '',
    ...account.fullName.toLowerCase().split(/\s+/),
  ];
  return [...new Set(pieces.map(letters).filter((p) => p.length >= 4))];
}

/**
 * The password checks that need to know whose password it is (QA 1, SDD 7.2).
 * The shape rules (length, letter, digit, symbol) are in passwordSchema and
 * have already run by the time a route calls this.
 *
 * Throws 400 with a message the person can act on. Messages name the rule that
 * failed but never echo the password back.
 */
export async function assertPasswordAcceptable(
  password: string,
  account: {
    /** What they sign in with. Absent only where an account has none yet. */
    username?: string;
    email: string;
    fullName: string;
    /** The current hash, so the same password cannot be "changed" to itself. */
    passwordHash?: string | null;
    /** Earlier hashes, newest first. */
    passwordHistory?: string[];
  },
): Promise<void> {
  const candidate = letters(password);
  for (const term of identityTerms(account)) {
    if (candidate.includes(term)) {
      throw badRequest('Password must not contain your name or email address');
    }
  }

  if (isBreachedPassword(password)) {
    throw badRequest(
      'That password appears in known password breaches; pick another',
    );
  }

  // Newest first, and the current password counts as one of the five.
  const previous = [
    ...(account.passwordHash ? [account.passwordHash] : []),
    ...(account.passwordHistory ?? []),
  ].slice(0, PASSWORD_HISTORY_SIZE);

  for (const hash of previous) {
    // A hash from an older argon2 config, or a corrupt one, must not pass the
    // check by throwing; treat an unverifiable hash as "not a match".
    const same = await argon2.verify(hash, password).catch(() => false);
    if (same) {
      throw badRequest(
        `Password must not be one of your last ${PASSWORD_HISTORY_SIZE} passwords`,
      );
    }
  }
}

/**
 * The history to store when a password changes: the hash being replaced goes
 * to the front, and anything past the limit falls off. Called with the row's
 * values from before the change.
 */
export function nextPasswordHistory(
  replacedHash: string | null | undefined,
  existingHistory: string[] | null | undefined,
): string[] {
  const history = [...(existingHistory ?? [])];
  if (replacedHash) history.unshift(replacedHash);
  // Keep one fewer than the limit: the new current hash is the fifth entry.
  return history.slice(0, PASSWORD_HISTORY_SIZE - 1);
}
