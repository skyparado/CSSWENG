/**
 * A random v4 UUID for idempotency keys.
 *
 * crypto.randomUUID() exists only in secure contexts (HTTPS or localhost). A
 * tablet testing against the dev server over the clinic Wi-Fi
 * (http://192.168.x.x:5173) is not one, and calling it there throws, which used
 * to break S09 upload and drawing. crypto.getRandomValues() works everywhere.
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
