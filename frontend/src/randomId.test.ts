import { afterEach, describe, expect, it } from 'vitest';
import { randomId } from './randomId';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomId', () => {
  afterEach(() => {
    // Drop the own-property override so the prototype's randomUUID shows again.
    delete (crypto as { randomUUID?: unknown }).randomUUID;
  });

  it('uses crypto.randomUUID when the page is a secure context', () => {
    expect(randomId()).toMatch(UUID_V4);
  });

  it('still returns a v4 UUID on plain HTTP, where randomUUID is missing', () => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    expect(typeof crypto.randomUUID).toBe('undefined');
    const a = randomId();
    const b = randomId();
    expect(a).toMatch(UUID_V4);
    expect(a).not.toBe(b);
  });
});
