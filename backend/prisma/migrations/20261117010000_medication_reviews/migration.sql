-- Medication review per visit: the Doctor confirms the medication list is current.

-- CreateTable
CREATE TABLE "MedicationReview" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "activeCount" INTEGER NOT NULL,
    "note" TEXT,
    "reviewedById" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MedicationReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MedicationReview_patientId_reviewedAt_idx" ON "MedicationReview"("patientId", "reviewedAt");

-- AddForeignKey
ALTER TABLE "MedicationReview" ADD CONSTRAINT "MedicationReview_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationReview" ADD CONSTRAINT "MedicationReview_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationReview" ADD CONSTRAINT "MedicationReview_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
