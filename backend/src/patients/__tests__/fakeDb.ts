/**
 * Minimal in-memory stand-in for prisma.patient, enough for the patient tests.
 * Supports equality, OR, AND, NOT and `null` in `where`. Relation filters
 * (e.g. appointments.some) are not supported.
 */
type Row = Record<string, unknown> & { id: string };

function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Record<string, unknown>[]).some((c) => matches(row, c));
    if (key === "AND") return (cond as Record<string, unknown>[]).every((c) => matches(row, c));
    if (key === "NOT") return !matches(row, cond as Record<string, unknown>);
    if (cond !== null && typeof cond === "object") throw new Error(`fakeDb: unsupported filter on ${key}`);
    return (row[key] ?? null) === cond;
  });
}

export function createFakeDb() {
  const rows: Row[] = [];
  let seq = 0;
  let n = 0;

  const patient = {
    async create({ data }: { data: Record<string, unknown> }) {
      const now = new Date();
      const row: Row = {
        id: `pat_${++n}`,
        patientSeq: ++seq,
        voidedAt: null,
        voidReason: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      rows.push(row);
      return { ...row };
    },
    async findFirst({ where }: { where?: Record<string, unknown> }) {
      const r = rows.find((row) => matches(row, where));
      return r ? { ...r } : null;
    },
    async findMany({ where, skip = 0, take }: { where?: Record<string, unknown>; skip?: number; take?: number }) {
      const found = rows
        .filter((row) => matches(row, where))
        .sort((a, b) => (b.patientSeq as number) - (a.patientSeq as number));
      return found.slice(skip, take === undefined ? undefined : skip + take).map((r) => ({ ...r }));
    },
    async count({ where }: { where?: Record<string, unknown> }) {
      return rows.filter((row) => matches(row, where)).length;
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    },
  };

  return { patient, rows } as unknown as { patient: import("@prisma/client").PrismaClient["patient"]; rows: Row[] };
}
