/**
 * Normalisation rules for blind indexes. Search input and stored values MUST
 * pass through the same function, or exact matches will be missed.
 * Changing a rule here means re-indexing every existing patient.
 */

/** "  Ma. Señora  dela Cruz " -> "ma senora dela cruz" */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents (ñ -> n, é -> e)
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ") // drop dots, commas, digits
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Philippine mobile numbers to the local 11-digit form.
 * "+63 917 555 1234", "639175551234", "0917-555-1234" -> "09175551234"
 * Other numbers are reduced to digits only.
 */
export function normalizePhone(phone: string): string {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("63") && digits.length === 12) digits = "0" + digits.slice(2);
  if (digits.length === 10 && digits.startsWith("9")) digits = "0" + digits;
  return digits;
}

/** Accepts "YYYY-MM-DD" or "MM/DD/YYYY". Returns "YYYY-MM-DD", or null if invalid. */
export function normalizeDate(input: string): string | null {
  const s = input.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) {
    [m, d, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    return null;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "P-00231", "p231", "00231" -> 231 */
export function parsePatientNumber(input: string): number | null {
  const match = /^(?:p-?)?(\d{1,9})$/i.exec(input.trim());
  return match ? Number(match[1]) : null;
}

export const formatPatientNumber = (seq: number): string => `P-${String(seq).padStart(5, "0")}`;

/** "09175551234" -> "0917 *** 1234" (wireframe S04 element 5) */
export function maskPhone(phone: string): string {
  const n = normalizePhone(phone);
  if (n.length < 8) return "***";
  return `${n.slice(0, 4)} *** ${n.slice(-4)}`;
}

/** Whole years between birth date and today (Asia/Manila calendar). */
export function ageFrom(dobIso: string, today = new Date()): number {
  const manila = new Date(today.toLocaleString("en-US", { timeZone: "Asia/Manila" }));
  const [y, m, d] = dobIso.split("-").map(Number) as [number, number, number];
  let age = manila.getFullYear() - y;
  if (manila.getMonth() + 1 < m || (manila.getMonth() + 1 === m && manila.getDate() < d)) age--;
  return age;
}
