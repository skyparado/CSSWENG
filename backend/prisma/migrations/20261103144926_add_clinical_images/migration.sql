-- CreateEnum
CREATE TYPE "ImageStatus" AS ENUM ('ACTIVE', 'DELETED');

-- CreateTable
CREATE TABLE "ClinicalImage" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "uploadedById" TEXT,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "caption" TEXT,
    "status" "ImageStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicalImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageAnnotation" (
    "id" TEXT NOT NULL,
    "clinicalImageId" TEXT NOT NULL,
    "createdById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "konvaData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageAnnotation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClinicalImage_storageKey_key" ON "ClinicalImage"("storageKey");

-- CreateIndex
CREATE INDEX "ClinicalImage_patientId_createdAt_idx" ON "ClinicalImage"("patientId", "createdAt");

-- CreateIndex
CREATE INDEX "ClinicalImage_appointmentId_idx" ON "ClinicalImage"("appointmentId");

-- CreateIndex
CREATE INDEX "ClinicalImage_status_idx" ON "ClinicalImage"("status");

-- CreateIndex
CREATE INDEX "ImageAnnotation_clinicalImageId_createdAt_idx" ON "ImageAnnotation"("clinicalImageId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ImageAnnotation_clinicalImageId_version_key" ON "ImageAnnotation"("clinicalImageId", "version");

-- AddForeignKey
ALTER TABLE "ClinicalImage" ADD CONSTRAINT "ClinicalImage_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalImage" ADD CONSTRAINT "ClinicalImage_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalImage" ADD CONSTRAINT "ClinicalImage_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageAnnotation" ADD CONSTRAINT "ImageAnnotation_clinicalImageId_fkey" FOREIGN KEY ("clinicalImageId") REFERENCES "ClinicalImage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageAnnotation" ADD CONSTRAINT "ImageAnnotation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
