-- Phase 1 feedback (Dev 3): reminder send tracking, unique outreach attempt
-- numbers, and stored medication safety acknowledgements.
--
-- Encrypting FollowUp.reason, OutreachLog.patientResponse, Medication.instructions,
-- Medication.indication and Allergy.reaction needs no DDL: the columns are TEXT
-- and hold the ciphertext. Existing plaintext rows are encrypted by
-- `npm run db:encrypt-existing --workspace backend` (see prisma/encryptExisting.ts).

-- CreateEnum
CREATE TYPE "ReminderDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'CANCELLED');

-- AlterTable: the actual alerts the Doctor acknowledged
ALTER TABLE "Medication" ADD COLUMN "safetyAcknowledgements" JSONB;

-- CreateTable
CREATE TABLE "ReminderDelivery" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "followUpId" TEXT NOT NULL,
    "channel" "ReminderChannel" NOT NULL,
    "consentId" TEXT,
    "status" "ReminderDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "providerMessageId" TEXT,
    "deliveryStatus" "DeliveryStatus",
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReminderDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReminderDelivery_idempotencyKey_key" ON "ReminderDelivery"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ReminderDelivery_followUpId_channel_idx" ON "ReminderDelivery"("followUpId", "channel");

-- AddForeignKey
ALTER TABLE "ReminderDelivery" ADD CONSTRAINT "ReminderDelivery_followUpId_fkey" FOREIGN KEY ("followUpId") REFERENCES "FollowUp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Visit and intake-session links (Encounter and TabletIntakeSession now exist)
ALTER TABLE "FollowUp" ADD COLUMN "encounterId" TEXT;
ALTER TABLE "PatientConsent" ADD COLUMN "intakeSessionId" TEXT;
CREATE INDEX "FollowUp_encounterId_idx" ON "FollowUp"("encounterId");
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PatientConsent" ADD CONSTRAINT "PatientConsent_intakeSessionId_fkey" FOREIGN KEY ("intakeSessionId") REFERENCES "TabletIntakeSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderDelivery" ADD CONSTRAINT "ReminderDelivery_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "PatientConsent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Attempt numbers were assigned with count()+1, which could repeat under
-- concurrency. Renumber any duplicates (oldest first) before enforcing uniqueness.
UPDATE "OutreachLog" o
SET "attemptNumber" = r.rn
FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "followUpId" ORDER BY "attemptedAt", "id") AS rn
    FROM "OutreachLog"
) r
WHERE o."id" = r."id" AND o."attemptNumber" <> r.rn;

-- The plain index is replaced by a unique one over the same columns.
DROP INDEX "OutreachLog_followUpId_attemptNumber_idx";
CREATE UNIQUE INDEX "OutreachLog_followUpId_attemptNumber_key" ON "OutreachLog"("followUpId", "attemptNumber");
