-- Problem list for S06 "Active Problems". Rows are created when a note is
-- signed, from its diagnoses. The Doctor marks them resolved; a resolved row
-- stays as history.

-- CreateTable
CREATE TABLE "Problem" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "diagnosis" TEXT NOT NULL,
    "diagnosisCode" TEXT,
    "eye" "Eye",
    "dateFirstRecorded" DATE NOT NULL,
    "resolvedDate" DATE,
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Problem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Problem_patientId_resolvedDate_idx" ON "Problem"("patientId", "resolvedDate");

-- CreateIndex
CREATE INDEX "Problem_encounterId_idx" ON "Problem"("encounterId");

-- AddForeignKey
ALTER TABLE "Problem" ADD CONSTRAINT "Problem_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Problem" ADD CONSTRAINT "Problem_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Problem" ADD CONSTRAINT "Problem_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Problem" ADD CONSTRAINT "Problem_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Who resolved it and when are recorded together, or not at all.
ALTER TABLE "Problem" ADD CONSTRAINT "Problem_resolved_together"
  CHECK (("resolvedDate" IS NULL) = ("resolvedById" IS NULL));
