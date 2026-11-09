import type { ExamFinding, LabResult } from "@prisma/client";
import {
  EXAM_FIELDS,
  evaluateRange,
  examFieldDef,
  labTestDef,
  parseNumeric,
  type ComparisonCell,
  type ComparisonQuery,
  type ComparisonResponse,
  type ComparisonRow,
  type Eye,
} from "@clinic/schemas";
import { decrypt } from "../lib/fieldCrypto.js";
import { loadPatient, requireDoctor } from "../encounters/encounter.service.js";
import type { Actor } from "../patients/patient.service.js";

type Db = Pick<typeof import("../prisma.js").prisma, "patient" | "encounter" | "examFinding" | "labResult">;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const round3 = (n: number) => Math.round(n * 1000) / 1000;
/** Recharts reads dataKey with lodash-style paths, so keep keys to [a-z0-9_]. */
const slug = (...parts: (string | null)[]) =>
  parts
    .filter(Boolean)
    .join("_")
    .toLowerCase()
    .replace(/%/g, "pct")
    .replace(/[^a-z0-9]+/g, "_");

const EYE_ORDER: Record<Eye, number> = { OD: 0, OS: 1, OU: 2 };
const FIELD_ORDER = Object.keys(EXAM_FIELDS);

/** One value placed in the grid, before cells are built. */
interface Point {
  date: string;
  encounterId: string | null;
  /** Latest wins when a row has two values on one date. */
  at: Date;
  cell: Omit<ComparisonCell, "change">;
}

interface RowAcc extends Omit<ComparisonRow, "cells" | "unitDiffers"> {
  /** Groups rows that differ only by unit, for "Unit differs". */
  group: string;
  sort: [number, string, number, string];
  points: Point[];
}

/** Rows that a later amendment replaces are dropped; the amendment shows the original value. */
function latestVersions<T extends { id: string }>(rows: T[], amendsKey: (r: T) => string | null) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const superseded = new Set(rows.map(amendsKey).filter((id): id is string => id !== null));
  const rootOf = (r: T): T => {
    let cur = r;
    for (let parent = amendsKey(cur); parent && byId.has(parent); parent = amendsKey(cur)) cur = byId.get(parent)!;
    return cur;
  };
  return rows.filter((r) => !superseded.has(r.id)).map((r) => ({ row: r, root: rootOf(r) }));
}

function examRows(
  findings: ExamFinding[],
  visitDateOf: Map<string, string>,
  fields: string[] | undefined,
): RowAcc[] {
  const rows = new Map<string, RowAcc>();
  for (const { row: f, root } of latestVersions(findings, (r) => r.amendsFindingId)) {
    const date = visitDateOf.get(f.encounterId);
    if (!date) continue;
    if (fields && !fields.includes(f.fieldName)) continue;

    const def = examFieldDef(f.fieldName);
    const isVA = f.fieldName === "VA";
    // Visual acuity is converted to logMAR, so every notation shares one row.
    const unit = isVA ? "logMAR" : f.unit;
    const key = slug("exam", f.fieldName, f.eye, isVA ? null : f.unit);
    const value = decrypt(f.valueText);
    const numericValue = isVA
      ? f.logmarValue === null
        ? null
        : Number(f.logmarValue)
      : def?.numeric !== false
        ? parseNumeric(value)
        : null;

    let acc = rows.get(key);
    if (!acc) {
      const order = FIELD_ORDER.indexOf(f.fieldName);
      acc = {
        key,
        kind: "EXAM",
        name: f.fieldName,
        label: def?.label ?? f.fieldName,
        eye: f.eye,
        unit,
        numeric: false,
        group: slug("exam", f.fieldName, f.eye),
        sort: [0, order === -1 ? `~${f.fieldName}` : String(order).padStart(3, "0"), EYE_ORDER[f.eye], unit ?? ""],
        points: [],
      };
      rows.set(key, acc);
    }
    acc.points.push({
      date,
      encounterId: f.encounterId,
      at: f.measuredAt,
      cell: {
        recordId: f.id,
        value,
        numericValue,
        method: f.method,
        amended: f.amendsFindingId !== null,
        originalValue: f.amendsFindingId !== null ? decrypt(root.valueText) : null,
        outOfRange: false,
        flag: null,
        referenceRange: null,
      },
    });
  }
  return [...rows.values()];
}

function labRows(results: LabResult[], keep: (r: LabResult) => boolean, tests: string[] | undefined): RowAcc[] {
  const wanted = tests?.map((t) => (labTestDef(t)?.name ?? t).toLowerCase());
  const rows = new Map<string, RowAcc>();
  for (const { row: r, root } of latestVersions(results, (x) => x.amendsLabResultId)) {
    if (!keep(r)) continue;
    if (wanted && !wanted.includes(r.testName.toLowerCase())) continue;

    const key = slug("lab", r.testName, r.resultUnit);
    const value = decrypt(r.resultValue);
    let acc = rows.get(key);
    if (!acc) {
      acc = {
        key,
        kind: "LAB",
        name: r.testName,
        label: r.testName,
        eye: null,
        unit: r.resultUnit,
        numeric: false,
        group: slug("lab", r.testName),
        sort: [1, r.testName.toLowerCase(), 0, r.resultUnit],
        points: [],
      };
      rows.set(key, acc);
    }
    acc.points.push({
      date: isoDay(r.collectionDate),
      encounterId: r.encounterId,
      at: r.recordedAt,
      cell: {
        recordId: r.id,
        value,
        numericValue: parseNumeric(value),
        method: null,
        amended: r.amendsLabResultId !== null,
        originalValue: r.amendsLabResultId !== null ? decrypt(root.resultValue) : null,
        outOfRange: r.outOfRange,
        flag: evaluateRange(value, r.referenceRange) ?? null,
        referenceRange: r.referenceRange,
      },
    });
  }
  return [...rows.values()];
}

const compareSort = (a: RowAcc, b: RowAcc) => {
  for (let i = 0; i < a.sort.length; i++) {
    if (a.sort[i]! < b.sort[i]!) return -1;
    if (a.sort[i]! > b.sort[i]!) return 1;
  }
  return 0;
};

/**
 * Dated findings and lab results across visits (S08): one column per date,
 * one row per field and eye (or test), and a chart block shaped for Recharts.
 * Doctor only.
 */
export async function buildComparison(
  db: Db,
  patientId: string,
  query: ComparisonQuery,
  actor: Actor,
): Promise<ComparisonResponse> {
  requireDoctor(actor, "compare results");
  await loadPatient(db, patientId);

  const inRange = (date: string) => (!query.from || date >= query.from) && (!query.to || date <= query.to);

  const encounters = await db.encounter.findMany({ where: { patientId } });
  const chosen = query.encounterIds ? new Set(query.encounterIds) : null;
  const visitDateOf = new Map(
    encounters
      .filter((e) => !chosen || chosen.has(e.id))
      .map((e) => [e.id, isoDay(e.visitDate)] as const)
      .filter(([, date]) => inRange(date)),
  );
  const chosenDates = new Set(visitDateOf.values());

  const rows: RowAcc[] = [];
  if (query.show !== "lab") {
    const findings = await db.examFinding.findMany({ where: { patientId } });
    rows.push(...examRows(findings, visitDateOf, query.fields));
  }
  if (query.show !== "exam") {
    const results = await db.labResult.findMany({ where: { patientId } });
    // With chosen visits: results tied to them, or collected on one of their dates.
    const keep = (r: LabResult) => {
      const date = isoDay(r.collectionDate);
      if (!inRange(date)) return false;
      return !chosen || (r.encounterId !== null && chosen.has(r.encounterId)) || chosenDates.has(date);
    };
    rows.push(...labRows(results, keep, query.tests));
  }
  rows.sort(compareSort);

  // Columns: every date with at least one value, oldest first.
  const encountersByDate = new Map<string, Set<string>>();
  for (const p of rows.flatMap((r) => r.points)) {
    const set = encountersByDate.get(p.date) ?? new Set<string>();
    if (p.encounterId) set.add(p.encounterId);
    encountersByDate.set(p.date, set);
  }
  const currentDate = query.currentEncounterId
    ? encounters.find((e) => e.id === query.currentEncounterId)?.visitDate
    : undefined;
  const columns = [...encountersByDate.keys()].sort().map((date) => ({
    date,
    encounterIds: [...encountersByDate.get(date)!].sort(),
    isCurrent: currentDate !== undefined && isoDay(currentDate) === date,
  }));

  const groupSizes = new Map<string, number>();
  for (const r of rows) groupSizes.set(r.group, (groupSizes.get(r.group) ?? 0) + 1);

  const outRows: ComparisonRow[] = rows.map(({ group, sort: _sort, points, ...row }) => {
    let prev: number | null = null;
    const cells = columns.map(({ date }) => {
      const latest = points.filter((p) => p.date === date).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
      if (!latest) return null;
      const n = latest.cell.numericValue;
      const change = n !== null && prev !== null ? round3(n - prev) : null;
      if (n !== null) prev = n;
      return { ...latest.cell, change };
    });
    return {
      ...row,
      numeric: cells.some((c) => c?.numericValue != null),
      unitDiffers: groupSizes.get(group)! > 1,
      cells,
    };
  });

  const charted = outRows.filter((r) => r.numeric);
  const chart = {
    data: columns.map((col, i) => {
      const point: Record<string, string | number | null> = { date: col.date };
      for (const r of charted) point[r.key] = r.cells[i]?.numericValue ?? null;
      return point;
    }),
    series: charted.map((r) => ({
      dataKey: r.key,
      name: [r.label, r.eye].filter(Boolean).join(" "),
      kind: r.kind,
      eye: r.eye,
      unit: r.unit,
      marker: r.eye === "OD" ? ("circle" as const) : r.eye === "OS" ? ("square" as const) : ("diamond" as const),
    })),
  };

  // AUDIT (Lance): "chart.compared"
  return { patientId, columns, rows: outRows, chart };
}
