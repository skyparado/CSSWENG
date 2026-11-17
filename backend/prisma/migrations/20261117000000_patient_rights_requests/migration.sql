-- Patient rights requests (SDD 7.4, RA 10173 Section 16): access, copy or correction.

-- CreateEnum
CREATE TYPE "RightsRequestType" AS ENUM ('ACCESS', 'COPY', 'CORRECTION');

-- CreateEnum
CREATE TYPE "RightsRequestChannel" AS ENUM ('IN_PERSON', 'PHONE', 'EMAIL', 'WRITTEN');

-- CreateEnum
CREATE TYPE "RightsRequestStatus" AS ENUM ('PENDING', 'COMPLETED', 'DENIED');

-- CreateTable
CREATE TABLE "PatientRightsRequest" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "requestType" "RightsRequestType" NOT NULL,
    "receivedVia" "RightsRequestChannel" NOT NULL,
    "details" TEXT,
    "status" "RightsRequestStatus" NOT NULL DEFAULT 'PENDING',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "PatientRightsRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PatientRightsRequest_clinicId_status_receivedAt_idx" ON "PatientRightsRequest"("clinicId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "PatientRightsRequest_patientId_receivedAt_idx" ON "PatientRightsRequest"("patientId", "receivedAt");

-- AddForeignKey
ALTER TABLE "PatientRightsRequest" ADD CONSTRAINT "PatientRightsRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientRightsRequest" ADD CONSTRAINT "PatientRightsRequest_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientRightsRequest" ADD CONSTRAINT "PatientRightsRequest_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientRightsRequest" ADD CONSTRAINT "PatientRightsRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
