-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('DATA_PROCESSING', 'REMINDER');

-- CreateEnum
CREATE TYPE "ReminderChannel" AS ENUM ('SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "ConsentCaptureMethod" AS ENUM ('TABLET', 'IN_PERSON', 'STAFF_ENTRY');

-- CreateEnum
CREATE TYPE "FollowUpTaskType" AS ENUM ('FOLLOW_UP', 'CHECK_UP', 'LAB_TEST', 'INJECTION', 'PROCEDURE');

-- CreateEnum
CREATE TYPE "FollowUpPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH');

-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('OPEN', 'SCHEDULED', 'COMPLETED', 'DECLINED', 'UNREACHABLE');

-- CreateEnum
CREATE TYPE "OutreachChannel" AS ENUM ('CALL', 'SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "OutreachOutcome" AS ENUM ('REACHED', 'NO_ANSWER', 'LEFT_MESSAGE', 'WRONG_NUMBER', 'DECLINED', 'BOOKED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "MedicationStatus" AS ENUM ('ACTIVE', 'ON_HOLD', 'DISCONTINUED');

-- CreateEnum
CREATE TYPE "MedicationSource" AS ENUM ('PRESCRIBED_HERE', 'PATIENT_REPORTED', 'OTHER_DOCTOR', 'OTC');

-- CreateEnum
CREATE TYPE "AllergySeverity" AS ENUM ('MILD', 'MODERATE', 'SEVERE');

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "email" TEXT,
ADD COLUMN     "mobileNumber" TEXT;

-- CreateTable
CREATE TABLE "PatientConsent" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "consentType" "ConsentType" NOT NULL,
    "channel" "ReminderChannel",
    "isGranted" BOOLEAN NOT NULL,
    "captureMethod" "ConsentCaptureMethod" NOT NULL,
    "consentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT NOT NULL,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnById" TEXT,
    "consentVersion" TEXT,

    CONSTRAINT "PatientConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUp" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "taskType" "FollowUpTaskType" NOT NULL,
    "reason" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "priority" "FollowUpPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "FollowUpStatus" NOT NULL DEFAULT 'OPEN',
    "recallRule" TEXT,
    "closureNote" TEXT,
    "createdById" TEXT,
    "completedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachLog" (
    "id" TEXT NOT NULL,
    "followUpId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "consentId" TEXT,
    "channel" "OutreachChannel" NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" "OutreachOutcome" NOT NULL,
    "patientResponse" TEXT,
    "providerMessageId" TEXT,
    "deliveryStatus" "DeliveryStatus",
    "contactedById" TEXT,

    CONSTRAINT "OutreachLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Medication" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "documentId" TEXT,
    "medicationName" TEXT NOT NULL,
    "strength" TEXT,
    "dose" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "instructions" TEXT,
    "indication" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "status" "MedicationStatus" NOT NULL DEFAULT 'ACTIVE',
    "discontinuationReason" TEXT,
    "prescribingDoctor" TEXT NOT NULL,
    "source" "MedicationSource" NOT NULL DEFAULT 'PRESCRIBED_HERE',
    "lookupVersion" INTEGER,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "supersedesMedicationId" TEXT,
    "recordedById" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Medication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Allergy" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "allergenName" TEXT NOT NULL,
    "reaction" TEXT,
    "severity" "AllergySeverity",
    "lookupVersion" INTEGER,
    "recordedById" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,

    CONSTRAINT "Allergy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PatientConsent_patientId_consentType_channel_idx" ON "PatientConsent"("patientId", "consentType", "channel");

-- CreateIndex
CREATE INDEX "FollowUp_clinicId_status_dueDate_idx" ON "FollowUp"("clinicId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "FollowUp_patientId_idx" ON "FollowUp"("patientId");

-- CreateIndex
CREATE INDEX "FollowUp_appointmentId_idx" ON "FollowUp"("appointmentId");

-- CreateIndex
CREATE INDEX "OutreachLog_followUpId_attemptNumber_idx" ON "OutreachLog"("followUpId", "attemptNumber");

-- CreateIndex
CREATE INDEX "OutreachLog_patientId_idx" ON "OutreachLog"("patientId");

-- CreateIndex
CREATE INDEX "OutreachLog_providerMessageId_idx" ON "OutreachLog"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Medication_supersedesMedicationId_key" ON "Medication"("supersedesMedicationId");

-- CreateIndex
CREATE INDEX "Medication_patientId_isCurrent_status_idx" ON "Medication"("patientId", "isCurrent", "status");

-- CreateIndex
CREATE INDEX "Medication_clinicId_idx" ON "Medication"("clinicId");

-- CreateIndex
CREATE INDEX "Allergy_patientId_voidedAt_idx" ON "Allergy"("patientId", "voidedAt");

-- AddForeignKey
ALTER TABLE "PatientConsent" ADD CONSTRAINT "PatientConsent_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientConsent" ADD CONSTRAINT "PatientConsent_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientConsent" ADD CONSTRAINT "PatientConsent_withdrawnById_fkey" FOREIGN KEY ("withdrawnById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachLog" ADD CONSTRAINT "OutreachLog_followUpId_fkey" FOREIGN KEY ("followUpId") REFERENCES "FollowUp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachLog" ADD CONSTRAINT "OutreachLog_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachLog" ADD CONSTRAINT "OutreachLog_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachLog" ADD CONSTRAINT "OutreachLog_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "PatientConsent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachLog" ADD CONSTRAINT "OutreachLog_contactedById_fkey" FOREIGN KEY ("contactedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Medication" ADD CONSTRAINT "Medication_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Medication" ADD CONSTRAINT "Medication_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Medication" ADD CONSTRAINT "Medication_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Medication" ADD CONSTRAINT "Medication_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Medication" ADD CONSTRAINT "Medication_supersedesMedicationId_fkey" FOREIGN KEY ("supersedesMedicationId") REFERENCES "Medication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allergy" ADD CONSTRAINT "Allergy_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allergy" ADD CONSTRAINT "Allergy_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allergy" ADD CONSTRAINT "Allergy_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

