-- Link a clinical image or drawing to the visit (S07) it was made in, and record
-- which blank eye diagram a drawing was cloned from.

-- CreateEnum
CREATE TYPE "DiagramTemplate" AS ENUM ('ANTERIOR_OD', 'ANTERIOR_OS', 'POSTERIOR_OD', 'POSTERIOR_OS');

-- AlterTable
ALTER TABLE "ClinicalImage" ADD COLUMN     "diagramTemplate" "DiagramTemplate",
ADD COLUMN     "encounterId" TEXT;

-- CreateIndex
CREATE INDEX "ClinicalImage_encounterId_idx" ON "ClinicalImage"("encounterId");

-- AddForeignKey
ALTER TABLE "ClinicalImage" ADD CONSTRAINT "ClinicalImage_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
