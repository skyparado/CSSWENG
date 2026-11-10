-- CreateEnum: where a submitted intake form sits in the staff review queue.
CREATE TYPE "IntakeReviewStatus" AS ENUM ('PENDING_REVIEW', 'ACCEPTED', 'CORRECTED');

-- AlterTable: staff review of a patient-typed intake form. rawPayload is never
-- rewritten by a review, so what the patient actually entered stays on record.
ALTER TABLE "TabletIntakeSubmission" ADD COLUMN     "reviewStatus" "IntakeReviewStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
ADD COLUMN     "reviewedById" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewNotes" TEXT;

-- CreateIndex
CREATE INDEX "TabletIntakeSubmission_reviewStatus_createdAt_idx" ON "TabletIntakeSubmission"("reviewStatus", "createdAt");

-- AddForeignKey
ALTER TABLE "TabletIntakeSubmission" ADD CONSTRAINT "TabletIntakeSubmission_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
