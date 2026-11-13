-- Visit and intake-session links for follow-ups and consents.
--
-- These columns were originally appended to 20261109000000_phase1_feedback
-- after that migration had already been applied, so Prisma skipped them on any
-- database that already had the earlier version recorded. They live in their
-- own migration here instead. Everything is guarded so the migration is safe on
-- a database that already picked the columns up from the edited file.

ALTER TABLE "FollowUp" ADD COLUMN IF NOT EXISTS "encounterId" TEXT;
ALTER TABLE "PatientConsent" ADD COLUMN IF NOT EXISTS "intakeSessionId" TEXT;

CREATE INDEX IF NOT EXISTS "FollowUp_encounterId_idx" ON "FollowUp"("encounterId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FollowUp_encounterId_fkey') THEN
    ALTER TABLE "FollowUp"
      ADD CONSTRAINT "FollowUp_encounterId_fkey"
      FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PatientConsent_intakeSessionId_fkey') THEN
    ALTER TABLE "PatientConsent"
      ADD CONSTRAINT "PatientConsent_intakeSessionId_fkey"
      FOREIGN KEY ("intakeSessionId") REFERENCES "TabletIntakeSession"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
