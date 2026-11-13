import { describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import { passwordSchema } from '@clinic/schemas';
import { assertPasswordAcceptable, nextPasswordHistory, PASSWORD_HISTORY_SIZE } from './passwordPolicy.js';
import { isBreachedPassword } from './breachedPasswords.js';

const account = { email: 'ana.reyes@pacio.clinic.local', fullName: 'Ana Reyes' };

/** Shape rules only: length, letter, digit, symbol. */
describe('passwordSchema (SDD 7.2 shape rules)', () => {
  it.each([
    ['too short', 'Short1!'],
    ['no letter', '1234567890!!'],
    ['no digit', 'NoDigitsHere!'],
    ['no symbol', 'NoSymbolHere123'],
    ['padded', ' Leading123!abc'],
  ])('rejects a password that is %s', (_label, value) => {
    expect(passwordSchema.safeParse(value).success).toBe(false);
  });

  it('accepts one that meets every rule at the minimum length', () => {
    expect(passwordSchema.safeParse('Abcdefghij1!').success).toBe(true);
  });
});

describe('breached-password list', () => {
  it('catches a known breached password', () => {
    expect(isBreachedPassword('password')).toBe(true);
    expect(isBreachedPassword('qwerty')).toBe(true);
  });

  it('catches one dressed up to pass the shape rules', () => {
    // "Password123!" is the shape the policy asks for and still the single
    // most-sprayed password there is.
    expect(isBreachedPassword('Password123!')).toBe(true);
  });

  it('leaves an ordinary strong password alone', () => {
    expect(isBreachedPassword('Tambourine-Kelp-42')).toBe(false);
  });
});

describe('assertPasswordAcceptable', () => {
  it('refuses a password built from the email local part', async () => {
    await expect(
      assertPasswordAcceptable('AnaReyes2026!', account),
    ).rejects.toThrow(/name or email/i);
  });

  it('refuses one built from the clinic domain', async () => {
    await expect(
      assertPasswordAcceptable('Pacio-Clinic-9!', account),
    ).rejects.toThrow(/name or email/i);
  });

  it('refuses a breached password', async () => {
    await expect(
      assertPasswordAcceptable('Password123!', account),
    ).rejects.toThrow(/breach/i);
  });

  it('refuses the password it already has', async () => {
    const passwordHash = await argon2.hash('Tambourine-Kelp-42', { type: argon2.argon2id });
    await expect(
      assertPasswordAcceptable('Tambourine-Kelp-42', { ...account, passwordHash }),
    ).rejects.toThrow(/last 5 passwords/i);
  });

  it('refuses one still inside the history window', async () => {
    const old = await argon2.hash('Marmalade-Quartz-7', { type: argon2.argon2id });
    await expect(
      assertPasswordAcceptable('Marmalade-Quartz-7', {
        ...account,
        passwordHash: await argon2.hash('Something-Else-11', { type: argon2.argon2id }),
        passwordHistory: [old],
      }),
    ).rejects.toThrow(/last 5 passwords/i);
  });

  it('accepts a good password with history present', async () => {
    const history = await Promise.all(
      ['Alpha-One-11', 'Bravo-Two-22'].map((p) => argon2.hash(p, { type: argon2.argon2id })),
    );
    await expect(
      assertPasswordAcceptable('Tambourine-Kelp-42', {
        ...account,
        passwordHash: await argon2.hash('Charlie-Three-33', { type: argon2.argon2id }),
        passwordHistory: history,
      }),
    ).resolves.toBeUndefined();
  });

  it('treats an unverifiable stored hash as a non-match rather than throwing', async () => {
    // A row written by an older argon2 config must not be able to block or
    // crash a password change.
    await expect(
      assertPasswordAcceptable('Tambourine-Kelp-42', {
        ...account,
        passwordHash: 'not-a-real-hash',
      }),
    ).resolves.toBeUndefined();
  });

  it('allows a short surname to appear in a password', async () => {
    // "Li" is two characters; rejecting every password containing it would
    // leave the person almost nothing to choose from.
    await expect(
      assertPasswordAcceptable('Tambourine-Kelp-42', {
        email: 'li@pacio.clinic.local',
        fullName: 'Li Wu',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('nextPasswordHistory', () => {
  it('puts the replaced hash at the front', () => {
    expect(nextPasswordHistory('new-old', ['older'])).toEqual(['new-old', 'older']);
  });

  it('drops anything past the window, counting the new current password', () => {
    const existing = ['a', 'b', 'c', 'd', 'e'];
    const next = nextPasswordHistory('replaced', existing);
    expect(next).toHaveLength(PASSWORD_HISTORY_SIZE - 1);
    expect(next[0]).toBe('replaced');
    expect(next).not.toContain('e');
  });

  it('handles an account with no history yet', () => {
    expect(nextPasswordHistory('only', [])).toEqual(['only']);
    expect(nextPasswordHistory(null, null)).toEqual([]);
  });
});
