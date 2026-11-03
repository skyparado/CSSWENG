-- CreateEnum
CREATE TYPE "EncounterType" AS ENUM ('NEW_PATIENT', 'FOLLOW_UP', 'PROCEDURE', 'WALK_IN');

-- CreateEnum
CREATE TYPE "EncounterStatus" AS ENUM ('OPEN', 'SIGNED');

-- CreateEnum
CREATE TYPE "NoteType" AS ENUM ('PRIMARY', 'ADDENDUM');

-- CreateEnum
CREATE TYPE "NoteStatus" AS ENUM ('DRAFT', 'SIGNED');

-- CreateEnum
CREATE TYPE "Eye" AS ENUM ('OD', 'OS', 'OU');

-- CreateTable
CREATE TABLE "Encounter" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "attendingDoctorId" TEXT NOT NULL,
    "type" "EncounterType" NOT NULL,
    "visitDate" DATE NOT NULL,
    "visitStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "visitEndedAt" TIMESTAMP(3),
    "status" "EncounterStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Encounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicalNote" (
    "id" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "noteType" "NoteType" NOT NULL DEFAULT 'PRIMARY',
    "parentNoteId" TEXT,
    "status" "NoteStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "chiefComplaint" TEXT,
    "subjective" TEXT,
    "objective" TEXT,
    "assessment" TEXT,
    "plan" TEXT,
    "diagnosisItems" TEXT,
    "addendumReason" VARCHAR(500),
    "authorId" TEXT NOT NULL,
    "signedById" TEXT,
    "signedAt" TIMESTAMP(3),
    "contentHash" CHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicalNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamFinding" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "eye" "Eye" NOT NULL,
    "fieldName" VARCHAR(100) NOT NULL,
    "valueText" TEXT NOT NULL,
    "unit" VARCHAR(30),
    "method" VARCHAR(100),
    "measuredAt" TIMESTAMP(3) NOT NULL,
    "logmarValue" DECIMAL(6,3),
    "lookupVersion" INTEGER NOT NULL,
    "amendsFindingId" TEXT,
    "amendmentReason" VARCHAR(500),
    "recordedById" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabResult" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT,
    "clinicId" TEXT NOT NULL,
    "testName" VARCHAR(100) NOT NULL,
    "resultValue" TEXT NOT NULL,
    "resultUnit" VARCHAR(20) NOT NULL,
    "referenceRange" VARCHAR(50),
    "outOfRange" BOOLEAN NOT NULL DEFAULT false,
    "collectionDate" DATE NOT NULL,
    "laboratoryName" VARCHAR(150) NOT NULL,
    "reportFileRef" VARCHAR(255),
    "lookupVersion" INTEGER NOT NULL,
    "amendsLabResultId" TEXT,
    "amendmentReason" VARCHAR(500),
    "recordedById" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Encounter_appointmentId_key" ON "Encounter"("appointmentId");

-- CreateIndex
CREATE INDEX "Encounter_patientId_visitDate_idx" ON "Encounter"("patientId", "visitDate");

-- CreateIndex
CREATE INDEX "Encounter_clinicId_visitDate_idx" ON "Encounter"("clinicId", "visitDate");

-- CreateIndex
CREATE INDEX "ClinicalNote_encounterId_idx" ON "ClinicalNote"("encounterId");

-- CreateIndex
CREATE INDEX "ClinicalNote_parentNoteId_signedAt_idx" ON "ClinicalNote"("parentNoteId", "signedAt");

-- CreateIndex
CREATE INDEX "ClinicalNote_status_idx" ON "ClinicalNote"("status");

-- CreateIndex
CREATE INDEX "ExamFinding_patientId_fieldName_idx" ON "ExamFinding"("patientId", "fieldName");

-- CreateIndex
CREATE INDEX "ExamFinding_encounterId_idx" ON "ExamFinding"("encounterId");

-- CreateIndex
CREATE INDEX "ExamFinding_amendsFindingId_idx" ON "ExamFinding"("amendsFindingId");

-- CreateIndex
CREATE INDEX "LabResult_patientId_testName_collectionDate_idx" ON "LabResult"("patientId", "testName", "collectionDate");

-- CreateIndex
CREATE INDEX "LabResult_encounterId_idx" ON "LabResult"("encounterId");

-- CreateIndex
CREATE INDEX "LabResult_amendsLabResultId_idx" ON "LabResult"("amendsLabResultId");

-- AddForeignKey
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_attendingDoctorId_fkey" FOREIGN KEY ("attendingDoctorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalNote" ADD CONSTRAINT "ClinicalNote_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalNote" ADD CONSTRAINT "ClinicalNote_parentNoteId_fkey" FOREIGN KEY ("parentNoteId") REFERENCES "ClinicalNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalNote" ADD CONSTRAINT "ClinicalNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalNote" ADD CONSTRAINT "ClinicalNote_signedById_fkey" FOREIGN KEY ("signedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamFinding" ADD CONSTRAINT "ExamFinding_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamFinding" ADD CONSTRAINT "ExamFinding_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamFinding" ADD CONSTRAINT "ExamFinding_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamFinding" ADD CONSTRAINT "ExamFinding_amendsFindingId_fkey" FOREIGN KEY ("amendsFindingId") REFERENCES "ExamFinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamFinding" ADD CONSTRAINT "ExamFinding_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_amendsLabResultId_fkey" FOREIGN KEY ("amendsLabResultId") REFERENCES "LabResult"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Rules from the design document (1.5 Data Integrity and Security Rules),
-- enforced in the database as well as in the API, so a bug or a manual query
-- cannot silently change a signed record.
--
-- Prisma cannot express partial indexes, CHECK constraints or triggers, so
-- they live only here. Keep them when generating later migrations.
-- ---------------------------------------------------------------------------

-- One PRIMARY note per encounter; any number of addenda.
CREATE UNIQUE INDEX "ClinicalNote_primary_per_encounter"
  ON "ClinicalNote"("encounterId") WHERE "noteType" = 'PRIMARY';

-- A PRIMARY note has no parent and no reason. An ADDENDUM points at its
-- original, gives a reason, and is signed when written.
ALTER TABLE "ClinicalNote" ADD CONSTRAINT "ClinicalNote_type_shape" CHECK (
  ("noteType" = 'PRIMARY' AND "parentNoteId" IS NULL AND "addendumReason" IS NULL)
  OR
  ("noteType" = 'ADDENDUM' AND "parentNoteId" IS NOT NULL AND "addendumReason" IS NOT NULL AND "status" = 'SIGNED')
);

-- A signed note always records who signed it, when, and the content hash.
ALTER TABLE "ClinicalNote" ADD CONSTRAINT "ClinicalNote_signature_complete" CHECK (
  "status" = 'DRAFT'
  OR ("signedById" IS NOT NULL AND "signedAt" IS NOT NULL AND "contentHash" IS NOT NULL)
);

-- A correction always says why.
ALTER TABLE "ExamFinding" ADD CONSTRAINT "ExamFinding_amendment_reason" CHECK (
  ("amendsFindingId" IS NULL) = ("amendmentReason" IS NULL)
);
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_amendment_reason" CHECK (
  ("amendsLabResultId" IS NULL) = ("amendmentReason" IS NULL)
);

-- Signed notes cannot be updated or deleted. The UPDATE that signs a note is
-- allowed because the row is still DRAFT at that point.
CREATE FUNCTION clinical_note_lock() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'SIGNED' THEN
    RAISE EXCEPTION 'ClinicalNote % is signed and locked; add an addendum instead', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicalNote_lock"
  BEFORE UPDATE OR DELETE ON "ClinicalNote"
  FOR EACH ROW EXECUTE FUNCTION clinical_note_lock();

-- Only a Doctor can sign (Table 7-1).
CREATE FUNCTION clinical_note_signer_is_doctor() RETURNS trigger AS $$
BEGIN
  IF NEW."signedById" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "User" WHERE "id" = NEW."signedById" AND "role" = 'DOCTOR'
  ) THEN
    RAISE EXCEPTION 'Only a Doctor can sign a clinical note'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicalNote_signer_is_doctor"
  BEFORE INSERT OR UPDATE ON "ClinicalNote"
  FOR EACH ROW EXECUTE FUNCTION clinical_note_signer_is_doctor();

-- Addenda only go on the signed PRIMARY note of the same encounter.
CREATE FUNCTION clinical_note_addendum_parent() RETURNS trigger AS $$
BEGIN
  IF NEW."noteType" = 'ADDENDUM' AND NOT EXISTS (
    SELECT 1 FROM "ClinicalNote"
    WHERE "id" = NEW."parentNoteId"
      AND "encounterId" = NEW."encounterId"
      AND "noteType" = 'PRIMARY'
      AND "status" = 'SIGNED'
  ) THEN
    RAISE EXCEPTION 'Addenda can only be added to the signed primary note of the same visit'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicalNote_addendum_parent"
  BEFORE INSERT ON "ClinicalNote"
  FOR EACH ROW EXECUTE FUNCTION clinical_note_addendum_parent();

-- Signing the primary note finalizes the visit in the same statement.
CREATE FUNCTION clinical_note_signed_closes_encounter() RETURNS trigger AS $$
BEGIN
  IF NEW."noteType" = 'PRIMARY' AND OLD."status" = 'DRAFT' AND NEW."status" = 'SIGNED' THEN
    UPDATE "Encounter"
      SET "status" = 'SIGNED',
          "visitEndedAt" = COALESCE("visitEndedAt", NEW."signedAt"),
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = NEW."encounterId";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicalNote_signed_closes_encounter"
  AFTER UPDATE ON "ClinicalNote"
  FOR EACH ROW EXECUTE FUNCTION clinical_note_signed_closes_encounter();

-- A signed visit cannot be changed or deleted.
CREATE FUNCTION encounter_lock() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'SIGNED' THEN
    RAISE EXCEPTION 'Encounter % is signed and locked', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Encounter_lock"
  BEFORE UPDATE OR DELETE ON "Encounter"
  FOR EACH ROW EXECUTE FUNCTION encounter_lock();

-- Findings are locked with the visit. After signing, only amendments
-- (new rows pointing at the original) may be inserted.
CREATE FUNCTION exam_finding_lock() RETURNS trigger AS $$
DECLARE
  enc_id TEXT := CASE WHEN TG_OP = 'INSERT' THEN NEW."encounterId" ELSE OLD."encounterId" END;
  signed BOOLEAN;
BEGIN
  SELECT "status" = 'SIGNED' INTO signed FROM "Encounter" WHERE "id" = enc_id;
  IF signed AND (TG_OP <> 'INSERT' OR NEW."amendsFindingId" IS NULL) THEN
    RAISE EXCEPTION 'Findings for visit % are locked; record an amendment instead', enc_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ExamFinding_lock"
  BEFORE INSERT OR UPDATE OR DELETE ON "ExamFinding"
  FOR EACH ROW EXECUTE FUNCTION exam_finding_lock();

-- Lab results are insert-only, and the specimen date is never in the future
-- (clinic time; all clinics are in Manila for now).
CREATE FUNCTION lab_result_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LabResult % cannot be changed or deleted; record an amendment instead', OLD."id"
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LabResult_immutable"
  BEFORE UPDATE OR DELETE ON "LabResult"
  FOR EACH ROW EXECUTE FUNCTION lab_result_immutable();

CREATE FUNCTION lab_result_collection_date() RETURNS trigger AS $$
BEGIN
  IF NEW."collectionDate" > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date THEN
    RAISE EXCEPTION 'Collection date cannot be in the future'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LabResult_collection_date"
  BEFORE INSERT ON "LabResult"
  FOR EACH ROW EXECUTE FUNCTION lab_result_collection_date();
