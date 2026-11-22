-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReminderDeliveryStatus" ADD VALUE 'DISPATCHING';
ALTER TYPE "ReminderDeliveryStatus" ADD VALUE 'UNCERTAIN';

-- AlterEnum
ALTER TYPE "ExportStatus" ADD VALUE 'RETRYING';

-- AlterTable
ALTER TABLE "FollowUp" ADD COLUMN     "recallIntervalDays" INTEGER,
ADD COLUMN     "recallOfId" TEXT,
ADD COLUMN     "reminderCycle" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ReminderDelivery" ADD COLUMN     "cycle" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ReportedMedicineDecision" (
    "submissionId" TEXT NOT NULL,
    "itemIndex" INTEGER NOT NULL,
    "decidedById" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "medicationId" TEXT,

    CONSTRAINT "ReportedMedicineDecision_pkey" PRIMARY KEY ("submissionId","itemIndex")
);

-- CreateTable
CREATE TABLE "MedicationReference" (
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT NOT NULL,

    CONSTRAINT "MedicationReference_pkey" PRIMARY KEY ("version")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReportedMedicineDecision_medicationId_key" ON "ReportedMedicineDecision"("medicationId");

-- CreateIndex
CREATE UNIQUE INDEX "FollowUp_recallOfId_key" ON "FollowUp"("recallOfId");

-- AddForeignKey
ALTER TABLE "ReportedMedicineDecision" ADD CONSTRAINT "ReportedMedicineDecision_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "TabletIntakeSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportedMedicineDecision" ADD CONSTRAINT "ReportedMedicineDecision_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportedMedicineDecision" ADD CONSTRAINT "ReportedMedicineDecision_medicationId_fkey" FOREIGN KEY ("medicationId") REFERENCES "Medication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationReference" ADD CONSTRAINT "MedicationReference_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
