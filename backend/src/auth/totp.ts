import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// 160 bits, evenly divisible by five. Authenticator apps accept an unpadded Base32 key.
export function newAuthenticatorKey(): string {
  const bits = Array.from(randomBytes(20), n => n.toString(2).padStart(8, '0')).join('');
  return bits.match(/.{5}/g)!.map(group => alphabet[parseInt(group, 2)]).join('');
}

export const bindPassword = (hash: string) => createHash('sha256').update(hash).digest('hex');

export function authenticatorCode(secret: string, step: number): string {
  const bits = Array.from(secret, c => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g)!.map(group => parseInt(group, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

export function matchingStep(secret: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30_000);
  for (const step of [current, current - 1, current + 1]) {
    if (timingSafeEqual(Buffer.from(code), Buffer.from(authenticatorCode(secret, step)))) return step;
  }
  return null;
}
