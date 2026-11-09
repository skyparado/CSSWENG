import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { env } from '../env.js';
import { DEFAULT_DRUG_REFERENCE } from './drugReferenceData.js';

/**
 * The medication / allergen reference the safety check runs against
 * (FR-5.6.6). It is lookup DATA, not code (SRS 4.2 Maintainability):
 *
 *  - `drugs`: one entry per medicine with its brand names and synonyms
 *    (`aliases`) and the drug classes it belongs to.
 *  - `classes`: a drug class with its own aliases ("NSAIDs", "sulfa drugs") and
 *    `relatedClasses`, the classes with possible cross-reactivity.
 *  - `approval`: who signed the list off. The check works either way, but
 *    `approved: false` is reported so nobody mistakes the starter list for a
 *    reviewed one.
 *
 * The bundled list is a STARTER. To use the clinic's approved list, put it in a
 * JSON file with the same shape and set DRUG_REFERENCE_PATH to it. Bump
 * `version` on every change; it is saved on each medication and allergy as
 * `lookupVersion`, so a record shows which list it was checked against.
 */
export const drugReferenceSchema = z.object({
  version: z.number().int().positive(),
  approval: z.object({
    approvedBy: z.string().min(1).nullable(),
    approvedAt: z.string().min(1).nullable(),
    note: z.string().optional(),
  }),
  classes: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      aliases: z.array(z.string().min(1)).default([]),
      /** Classes a patient allergic to this one may also react to. */
      relatedClasses: z
        .array(z.object({ classId: z.string().min(1), note: z.string().optional() }))
        .default([]),
    }),
  ),
  drugs: z.array(
    z.object({
      name: z.string().min(1),
      aliases: z.array(z.string().min(1)).default([]),
      classes: z.array(z.string().min(1)).default([]),
    }),
  ),
});

export type DrugReferenceInput = z.input<typeof drugReferenceSchema>;
export type DrugReferenceData = z.output<typeof drugReferenceSchema>;
export type DrugReference = DrugReferenceData & {
  /** True once a Doctor is recorded as having approved this list. */
  approved: boolean;
};

/** Lower-case, strip punctuation and collapse whitespace so names compare reliably. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when `needle` appears in `haystack` as whole words (both already normalized). */
export function containsPhrase(haystack: string, needle: string): boolean {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

/**
 * Validate a reference and check it hangs together: every class a drug or a
 * relationship names must exist. Throws with a readable message otherwise.
 */
export function parseDrugReference(raw: unknown): DrugReference {
  const data = drugReferenceSchema.parse(raw);
  const classIds = new Set(data.classes.map((c) => c.id));
  for (const d of data.drugs) {
    for (const c of d.classes) {
      if (!classIds.has(c)) throw new Error(`Drug reference: "${d.name}" uses unknown class "${c}"`);
    }
  }
  for (const c of data.classes) {
    for (const r of c.relatedClasses) {
      if (!classIds.has(r.classId)) {
        throw new Error(`Drug reference: class "${c.id}" relates to unknown class "${r.classId}"`);
      }
    }
  }
  return {
    ...data,
    approved: Boolean(data.approval.approvedBy && data.approval.approvedAt),
  };
}

let cached: DrugReference | undefined;

/** The active reference: DRUG_REFERENCE_PATH if set, otherwise the bundled starter list. */
export function getDrugReference(): DrugReference {
  if (cached) return cached;
  const raw = env.DRUG_REFERENCE_PATH
    ? JSON.parse(readFileSync(env.DRUG_REFERENCE_PATH, 'utf8'))
    : DEFAULT_DRUG_REFERENCE;
  cached = parseDrugReference(raw);
  if (!cached.approved && env.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console
    console.warn(
      `[medications] drug reference v${cached.version} has no Doctor approval recorded; ` +
        'set DRUG_REFERENCE_PATH to the approved list (see medications/drugReference.ts).',
    );
  }
  return cached;
}

/** Forget the cached reference (tests, or after changing DRUG_REFERENCE_PATH). */
export function resetDrugReferenceCache() {
  cached = undefined;
}

/* ------------------------------- Name lookup -------------------------------- */

interface Resolved {
  /** Canonical names of the drugs the text refers to. */
  drugs: Set<string>;
  /** Class ids the text belongs to, directly or through a drug. */
  classes: Set<string>;
}

interface Index {
  drugTerms: Array<{ term: string; drug: DrugReferenceData['drugs'][number] }>;
  classTerms: Array<{ term: string; classId: string }>;
  classById: Map<string, DrugReferenceData['classes'][number]>;
}

const indexes = new WeakMap<DrugReferenceData, Index>();

function indexOf(ref: DrugReferenceData): Index {
  let index = indexes.get(ref);
  if (!index) {
    index = {
      drugTerms: ref.drugs.flatMap((drug) =>
        [drug.name, ...drug.aliases].map((t) => ({ term: normalizeName(t), drug })),
      ),
      classTerms: ref.classes.flatMap((c) =>
        [c.id, c.label, ...c.aliases].map((t) => ({ term: normalizeName(t), classId: c.id })),
      ),
      classById: new Map(ref.classes.map((c) => [c.id, c])),
    };
    indexes.set(ref, index);
  }
  return index;
}

/** Which reference drugs and classes a free-text medication or allergen name refers to. */
export function resolveName(name: string, ref: DrugReferenceData): Resolved {
  const n = normalizeName(name);
  const index = indexOf(ref);
  const drugs = new Set<string>();
  const classes = new Set<string>();

  for (const { term, drug } of index.drugTerms) {
    if (containsPhrase(n, term)) {
      drugs.add(normalizeName(drug.name));
      drug.classes.forEach((c) => classes.add(c));
    }
  }
  for (const { term, classId } of index.classTerms) {
    if (containsPhrase(n, term)) classes.add(classId);
  }
  return { drugs, classes };
}

export function classLabel(classId: string, ref: DrugReferenceData): string {
  return indexOf(ref).classById.get(classId)?.label ?? classId;
}

/** Classes related to `classId` (an allergy to it may cross-react with these). */
export function relatedClassesOf(classId: string, ref: DrugReferenceData) {
  return indexOf(ref).classById.get(classId)?.relatedClasses ?? [];
}
