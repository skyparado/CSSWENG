import { z } from "zod";
import { EyeSchema } from "./encounters.js";
import { isoDate } from "./patients.js";

// ---------------------------------------------------------------------------
// Lookup lists. The design keeps a lookup_version on every finding and result
// so past entries keep their original units and ranges. Bump the version when
// a list entry changes; never edit an entry in place.
// ---------------------------------------------------------------------------

export const EXAM_LOOKUP_VERSION = 1;

interface ExamFieldDef {
  label: string;
  /** Accepted units. Empty: the field is free text and takes no unit. */
  units: readonly string[];
  /** Values are numbers that can be charted. */
  numeric: boolean;
  /** OU (both eyes) is a valid measurement for this field. */
  allowsOU: boolean;
}

/** Examination rows of S07, in display order. */
export const EXAM_FIELDS = {
  VA: { label: "Visual acuity", units: ["Snellen", "decimal", "logMAR"], numeric: true, allowsOU: true },
  IOP: { label: "Intraocular pressure", units: ["mmHg"], numeric: true, allowsOU: false },
  LIDS_LASHES: { label: "Lids and lashes", units: [], numeric: false, allowsOU: false },
  CORNEA: { label: "Cornea", units: [], numeric: false, allowsOU: false },
  LENS: { label: "Lens", units: [], numeric: false, allowsOU: false },
  OPTIC_DISC: { label: "Optic disc", units: [], numeric: false, allowsOU: false },
  MACULA: { label: "Macula", units: [], numeric: false, allowsOU: false },
} as const satisfies Record<string, ExamFieldDef>;
export type ExamFieldKey = keyof typeof EXAM_FIELDS;

export const examFieldDef = (fieldName: string): ExamFieldDef | undefined =>
  (EXAM_FIELDS as Record<string, ExamFieldDef>)[fieldName];

export const LAB_LOOKUP_VERSION = 1;

interface LabTestDef {
  name: string;
  units: readonly string[];
}

/** The doctor's laboratory test list (S08 "Add Lab Result"). */
export const LAB_TESTS: readonly LabTestDef[] = [
  { name: "HbA1c", units: ["%", "mmol/mol"] },
  { name: "Fasting blood sugar", units: ["mg/dL", "mmol/L"] },
  { name: "Creatinine", units: ["mg/dL", "umol/L"] },
  { name: "Total cholesterol", units: ["mg/dL", "mmol/L"] },
  { name: "LDL cholesterol", units: ["mg/dL", "mmol/L"] },
  { name: "Blood pressure (systolic)", units: ["mmHg"] },
];

export const labTestDef = (testName: string): LabTestDef | undefined =>
  LAB_TESTS.find((t) => t.name.toLowerCase() === testName.trim().toLowerCase());

// ---------------------------------------------------------------------------
// Value helpers, shared so the form and the server agree.
// ---------------------------------------------------------------------------

/** A plain decimal number, e.g. "18" or "-0.10". Anything else is not charted. */
export function parseNumeric(value: string): number | null {
  const s = value.trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

/** Low-vision notations with no agreed logMAR value; they are kept as text. */
export const LOW_VISION_CODES = ["CF", "HM", "LP", "NLP"] as const;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Visual acuity to logMAR, so visits recorded in different notations can be
 * compared. Returns null when the value cannot be converted (e.g. "CF").
 *
 *   Snellen "20/40" or "6/12"  -> log10(40/20) = 0.301; "20/40-2" adds 0.02 per missed letter
 *   decimal "0.5"              -> -log10(0.5)  = 0.301
 *   logMAR  "0.30"             -> 0.3
 */
export function toLogMAR(value: string, unit: string | null | undefined): number | null {
  const s = value.trim();
  if (unit === "Snellen") {
    const m = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(?:([+-])\s*(\d))?$/.exec(s);
    if (!m) return null;
    const [, num, den, sign, letters] = m;
    if (Number(num) <= 0 || Number(den) <= 0) return null;
    const letterAdj = sign ? (sign === "-" ? 1 : -1) * Number(letters) * 0.02 : 0;
    return round3(Math.log10(Number(den) / Number(num)) + letterAdj);
  }
  const n = parseNumeric(s);
  if (n === null) return null;
  if (unit === "decimal") return n > 0 ? round3(-Math.log10(n)) : null;
  if (unit === "logMAR") return round3(n);
  return null;
}

export type RangeFlag = "HIGH" | "LOW";

/**
 * Compare a value with a printed reference range: "4.0-5.6", "<5.7", "<=200",
 * ">40", ">=60". Returns the flag, null when within range, or undefined when
 * the value or range is not numeric (nothing can be said).
 */
export function evaluateRange(value: string, range: string | null | undefined): RangeFlag | null | undefined {
  const v = parseNumeric(value);
  if (v === null || !range) return undefined;
  const r = range.trim().replace(/[–—]/g, "-").replace("≤", "<=").replace("≥", ">=");
  const num = "(-?\\d+(?:\\.\\d+)?)";
  let m = new RegExp(`^${num}\\s*-\\s*${num}$`).exec(r);
  if (m) {
    if (v < Number(m[1])) return "LOW";
    if (v > Number(m[2])) return "HIGH";
    return null;
  }
  m = new RegExp(`^(<=?|>=?)\\s*${num}$`).exec(r);
  if (!m) return undefined;
  const [, op, boundStr] = m;
  const bound = Number(boundStr);
  if (op === "<") return v < bound ? null : "HIGH";
  if (op === "<=") return v <= bound ? null : "HIGH";
  if (op === ">") return v > bound ? null : "LOW";
  return v >= bound ? null : "LOW";
}

// ---------------------------------------------------------------------------
// Examination findings
// ---------------------------------------------------------------------------

const optionalShort = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

const reason = z.string().trim().min(1).max(500);

const findingValueShape = {
  valueText: z.string().trim().min(1).max(100),
  unit: optionalShort(30),
  method: optionalShort(100),
  /** When it was measured. Defaults to now. */
  measuredAt: z.string().datetime({ offset: true }).optional(),
};

const examFindingBase = z.object({
  eye: EyeSchema,
  /** Key from EXAM_FIELDS (e.g. "IOP"), or a doctor-defined field name. */
  fieldName: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .transform((s) => s.toUpperCase().replace(/[\s-]+/g, "_")),
  ...findingValueShape,
});

/** Unit, eye and value rules for one finding. Used for create, replace and amend. */
function checkFinding(f: z.infer<typeof examFindingBase>, ctx: z.RefinementCtx) {
  const def = examFieldDef(f.fieldName);
  if (!def) {
    if (f.eye === "OU") ctx.addIssue({ code: "custom", path: ["eye"], message: "Record each eye separately" });
    return;
  }
  if (f.eye === "OU" && !def.allowsOU) {
    ctx.addIssue({ code: "custom", path: ["eye"], message: `${def.label} is recorded for each eye separately` });
  }
  if (def.units.length === 0) {
    if (f.unit) ctx.addIssue({ code: "custom", path: ["unit"], message: `${def.label} takes no unit` });
    return;
  }
  if (!f.unit || !def.units.includes(f.unit)) {
    ctx.addIssue({ code: "custom", path: ["unit"], message: `Use one of: ${def.units.join(", ")}` });
    return;
  }
  if (f.fieldName === "VA") {
    const lowVision = (LOW_VISION_CODES as readonly string[]).includes(f.valueText.toUpperCase());
    if (!lowVision && toLogMAR(f.valueText, f.unit) === null) {
      ctx.addIssue({ code: "custom", path: ["valueText"], message: `Not a valid ${f.unit} visual acuity` });
    }
  } else if (def.numeric && parseNumeric(f.valueText) === null) {
    ctx.addIssue({ code: "custom", path: ["valueText"], message: "Enter a number" });
  }
}

/** Add a finding to an open visit, or replace one (PUT) while the visit is open. */
export const ExamFindingSchema = examFindingBase.superRefine(checkFinding);
export type ExamFindingInput = z.infer<typeof ExamFindingSchema>;

/**
 * Correct a finding after the visit is signed. Eye and field come from the
 * original, which is kept; the comparison shows this value as "Amended".
 */
export const AmendExamFindingSchema = z.object({
  ...findingValueShape,
  amendmentReason: reason,
});
export type AmendExamFindingInput = z.infer<typeof AmendExamFindingSchema>;

/** Re-check an amendment against its original's field and eye. */
export const amendedFindingSchema = (original: { eye: z.infer<typeof EyeSchema>; fieldName: string }) =>
  AmendExamFindingSchema.superRefine((a, ctx) =>
    checkFinding({ ...a, eye: original.eye, fieldName: original.fieldName }, ctx),
  );

// ---------------------------------------------------------------------------
// Laboratory results
// ---------------------------------------------------------------------------

const labValueShape = {
  resultValue: z.string().trim().min(1).max(50),
  resultUnit: z.string().trim().min(1).max(20),
  referenceRange: optionalShort(50),
  /** Specimen date, "YYYY-MM-DD". Cannot be in the future (checked in clinic time). */
  collectionDate: isoDate,
  laboratoryName: z.string().trim().min(1).max(150),
  /** Object key of an uploaded scan of the report. */
  reportFileRef: optionalShort(255),
};

function checkLabUnit(r: { testName: string; resultUnit: string }, ctx: z.RefinementCtx) {
  const def = labTestDef(r.testName);
  if (def && !def.units.includes(r.resultUnit)) {
    ctx.addIssue({ code: "custom", path: ["resultUnit"], message: `${def.name} is reported in ${def.units.join(" or ")}` });
  }
}

export const CreateLabResultSchema = z
  .object({
    patientId: z.string().min(1),
    /** Optional: outside results are often not tied to a visit. */
    encounterId: z.string().min(1).optional(),
    testName: z.string().trim().min(1).max(100),
    ...labValueShape,
  })
  .superRefine(checkLabUnit);
export type CreateLabResultInput = z.infer<typeof CreateLabResultSchema>;

/** Correction of a recorded result. Test and patient come from the original, which is kept. */
export const AmendLabResultSchema = z.object({
  ...labValueShape,
  amendmentReason: reason,
});
export type AmendLabResultInput = z.infer<typeof AmendLabResultSchema>;

export const amendedLabResultSchema = (original: { testName: string }) =>
  AmendLabResultSchema.superRefine((a, ctx) => checkLabUnit({ ...a, testName: original.testName }, ctx));

export const LabResultListQuerySchema = z.object({
  patientId: z.string().min(1),
  testName: z.string().trim().min(1).optional(),
});
export type LabResultListQuery = z.infer<typeof LabResultListQuerySchema>;

// ---------------------------------------------------------------------------
// Comparison across visits (S08)
// ---------------------------------------------------------------------------

/** "a,b" or repeated ?x=a&x=b. */
const csv = z
  .union([z.string(), z.array(z.string())])
  .transform((v) =>
    (Array.isArray(v) ? v : [v])
      .flatMap((s) => s.split(","))
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .optional();

export const ComparisonQuerySchema = z
  .object({
    /** "exam", "lab" or "both" (S08 "Show"). */
    show: z.enum(["exam", "lab", "both"]).default("both"),
    /** Exam fields to include, e.g. "VA,IOP". All when omitted. */
    fields: csv.transform((v) => v?.map((s) => s.toUpperCase().replace(/[\s-]+/g, "_"))),
    /** Lab tests to include, e.g. "HbA1c". All when omitted. */
    tests: csv,
    /** Only these visits (their exam findings and any labs tied to them). */
    encounterIds: csv,
    from: isoDate.optional(),
    to: isoDate.optional(),
    /** Visit to highlight as "current". */
    currentEncounterId: z.string().min(1).optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from must be on or before to", path: ["to"] });
export type ComparisonQuery = z.infer<typeof ComparisonQuerySchema>;

export const ComparisonColumnSchema = z.object({
  /** "YYYY-MM-DD": visit date for findings, collection date for lab results. */
  date: isoDate,
  encounterIds: z.array(z.string()),
  isCurrent: z.boolean(),
});

export const ComparisonCellSchema = z.object({
  recordId: z.string(),
  /** As entered, e.g. "20/40" or "18". */
  value: z.string(),
  /** Charted number: logMAR for visual acuity, else the parsed value. */
  numericValue: z.number().nullable(),
  /** Difference from the previous numeric value in this row. Not interpreted. */
  change: z.number().nullable(),
  method: z.string().nullable(),
  amended: z.boolean(),
  /** Value before the latest correction, when amended. */
  originalValue: z.string().nullable(),
  outOfRange: z.boolean(),
  /** "High" / "Low" label for lab results outside the reference range. */
  flag: z.enum(["HIGH", "LOW"]).nullable(),
  referenceRange: z.string().nullable(),
});
export type ComparisonCell = z.infer<typeof ComparisonCellSchema>;

export const ComparisonRowSchema = z.object({
  /** Stable id; also the Recharts dataKey for numeric rows. */
  key: z.string(),
  kind: z.enum(["EXAM", "LAB"]),
  /** Exam field key or lab test name. */
  name: z.string(),
  label: z.string(),
  eye: EyeSchema.nullable(),
  /** Unit shown for the row ("logMAR" for visual acuity). */
  unit: z.string().nullable(),
  numeric: z.boolean(),
  /** Another row has the same field/test and eye in a different unit ("Unit differs"). */
  unitDiffers: z.boolean(),
  /** Same length and order as `columns`; null where nothing was recorded. */
  cells: z.array(ComparisonCellSchema.nullable()),
});
export type ComparisonRow = z.infer<typeof ComparisonRowSchema>;

export const ChartSeriesSchema = z.object({
  dataKey: z.string(),
  name: z.string(),
  kind: z.enum(["EXAM", "LAB"]),
  eye: EyeSchema.nullable(),
  unit: z.string().nullable(),
  /** OD circle, OS square, OU and lab results diamond, so colour is not the only signal. */
  marker: z.enum(["circle", "square", "diamond"]),
});

/**
 * Ready for Recharts:
 *
 *   <LineChart data={chart.data}>
 *     <XAxis dataKey="date" />
 *     {chart.series.map((s) => <Line key={s.dataKey} dataKey={s.dataKey} name={s.name} connectNulls />)}
 *   </LineChart>
 */
export const ComparisonChartSchema = z.object({
  data: z.array(z.record(z.union([z.string(), z.number(), z.null()]))),
  series: z.array(ChartSeriesSchema),
});

export const ComparisonResponseSchema = z.object({
  patientId: z.string(),
  columns: z.array(ComparisonColumnSchema),
  rows: z.array(ComparisonRowSchema),
  chart: ComparisonChartSchema,
});
export type ComparisonResponse = z.infer<typeof ComparisonResponseSchema>;
