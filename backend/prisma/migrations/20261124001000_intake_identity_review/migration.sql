ALTER TABLE "TabletIntakeSession" ADD COLUMN "matchPatientId" TEXT, ADD COLUMN "matchDecision" TEXT,
  ADD CONSTRAINT "intake_match_decision" CHECK (
    ("matchDecision" IS NULL AND "matchPatientId" IS NULL) OR
    ("matchDecision" IS NOT NULL AND "matchDecision" IN ('PENDING','EXISTING','SEPARATE') AND "matchPatientId" IS NOT NULL)
  );
