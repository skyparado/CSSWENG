ALTER TABLE "User" ADD COLUMN "mfaSecretEnc" TEXT, ADD COLUMN "mfaLastStep" INTEGER;
ALTER TABLE "Encounter" ADD COLUMN "walkInKey" TEXT;
CREATE UNIQUE INDEX "Encounter_walkInKey_key" ON "Encounter" ("walkInKey");
CREATE UNIQUE INDEX "Encounter_id_patientId_key" ON "Encounter" ("id", "patientId");

ALTER TABLE "ClinicalImage"
  ADD COLUMN "visitId" TEXT, ADD COLUMN "walkInKey" TEXT, ADD COLUMN "clinicId" TEXT,
  ADD COLUMN "templateType" TEXT, ADD COLUMN "commitKey" TEXT,
  ADD CONSTRAINT "ClinicalImage_visitId_patientId_fkey" FOREIGN KEY ("visitId", "patientId")
    REFERENCES "Encounter" ("id", "patientId") ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "ClinicalImage_commitKey_key" ON "ClinicalImage" ("commitKey");
CREATE INDEX "ClinicalImage_visitId_idx" ON "ClinicalImage" ("visitId");
CREATE INDEX "ClinicalImage_walkInKey_patientId_idx" ON "ClinicalImage" ("walkInKey", "patientId");

-- Only an exact appointment and patient can identify a visit in existing records.
UPDATE "ClinicalImage" i SET "clinicId" = a."clinicId", "visitId" = e.id
FROM "Appointment" a LEFT JOIN "Encounter" e ON e."appointmentId" = a.id
  AND e."patientId" = a."patientId" AND e."clinicId" = a."clinicId"
WHERE i."appointmentId" = a.id AND i."patientId" = a."patientId";

-- Image creation takes this same patient lock before resolving its context.
-- This serializes visit opening against an upload in either arrival order.
CREATE FUNCTION lock_visit_image_patient() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."appointmentId" IS NOT NULL OR NEW."walkInKey" IS NOT NULL THEN
    PERFORM id FROM "Patient" WHERE id = NEW."patientId" FOR UPDATE;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lock_visit_image_patient BEFORE INSERT ON "Encounter"
FOR EACH ROW EXECUTE FUNCTION lock_visit_image_patient();

CREATE FUNCTION link_pending_visit_images() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "ClinicalImage" SET "visitId" = NEW.id, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "visitId" IS NULL AND "patientId" = NEW."patientId" AND "clinicId" = NEW."clinicId"
    AND (("appointmentId" IS NOT NULL AND "appointmentId" = NEW."appointmentId")
      OR ("walkInKey" IS NOT NULL AND "walkInKey" = NEW."walkInKey"));
  RETURN NEW;
END $$;
CREATE TRIGGER link_pending_visit_images AFTER INSERT ON "Encounter"
FOR EACH ROW EXECUTE FUNCTION link_pending_visit_images();

-- Row protection already covers UPDATE and DELETE. TRUNCATE is statement-level.
CREATE FUNCTION reject_audit_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit log is append-only';
END $$;
CREATE TRIGGER reject_audit_truncate BEFORE TRUNCATE ON "AuditLog"
FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_truncate();
