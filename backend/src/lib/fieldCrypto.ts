/**
 * Field-level encryption and blind indexes.
 *
 * - encrypt/decrypt: AES-256-GCM. Output format "v1:<iv>:<tag>:<ciphertext>" (base64).
 * - blindIndex: HMAC-SHA256 with a SEPARATE key, used for exact-match search
 *   and duplicate detection on encrypted columns.
 *
 * Keys come from env:
 *   FIELD_ENCRYPTION_KEY  32 random bytes, base64
 *   BLIND_INDEX_KEY       32 random bytes, base64 (must differ from the above)
 * Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * NOTE (for Lance / Developer 4): field-level encryption is your task. If the
 * team switches to prisma-field-encryption or another approach, only this file
 * and src/patients/patient.mapper.ts need to change.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const VERSION = "v1";

function loadKey(name: string): Buffer {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not set`);
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes (base64-encoded)`);
  return key;
}

let encKey: Buffer | undefined;
let idxKey: Buffer | undefined;
const getEncKey = () => (encKey ??= loadKey("FIELD_ENCRYPTION_KEY"));
const getIdxKey = () => (idxKey ??= loadKey("BLIND_INDEX_KEY"));

/** Test hook: forget cached keys so tests can set env vars. */
export function resetKeyCache(): void {
  encKey = undefined;
  idxKey = undefined;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decrypt(payload: string): string {
  const [version, iv, tag, ct] = payload.split(":");
  if (version !== VERSION || !iv || !tag || ct === undefined) {
    throw new Error("Unrecognised ciphertext format");
  }
  const decipher = createDecipheriv("aes-256-gcm", getEncKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

export const encryptOpt = (v: string | null | undefined): string | null =>
  v === null || v === undefined || v === "" ? null : encrypt(v);

export const decryptOpt = (v: string | null | undefined): string | null =>
  v === null || v === undefined ? null : decrypt(v);

/** Keyed hash of an ALREADY NORMALISED value. */
export function blindIndex(normalised: string): string {
  return createHmac("sha256", getIdxKey()).update(normalised, "utf8").digest("hex");
}
