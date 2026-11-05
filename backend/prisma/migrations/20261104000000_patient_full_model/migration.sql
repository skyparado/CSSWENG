-- Replace the placeholder Patient with the full, field-encrypted model (Dev 2).
--
-- Existing placeholder rows hold plaintext names and no clinic/creator, and
-- encryption happens in the app, so they cannot be converted in SQL. This
-- migration therefore only applies to a Patient table with no rows. On a dev
-- database with the old seed patient, run `npx prisma migrate reset` (drops
-- and reseeds). There is no production data yet.

-- CreateEnum
CREATE TYPE "Sex" AS ENUM ('MALE', 'FEMALE');

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "address" TEXT,
ADD COLUMN     "alternatePhone" TEXT,
ADD COLUMN     "civilStatus" TEXT,
ADD COLUMN     "createdById" TEXT NOT NULL,
ADD COLUMN     "dateOfBirth" TEXT NOT NULL,
ADD COLUMN     "dobIdx" TEXT NOT NULL,
ADD COLUMN     "emergencyContactName" TEXT,
ADD COLUMN     "emergencyContactPhone" TEXT,
ADD COLUMN     "firstNameIdx" TEXT NOT NULL,
ADD COLUMN     "hmoMemberNumber" TEXT,
ADD COLUMN     "hmoProvider" TEXT,
ADD COLUMN     "hmoValidUntil" DATE,
ADD COLUMN     "lastNameIdx" TEXT NOT NULL,
ADD COLUMN     "medicalHistory" TEXT,
ADD COLUMN     "middleName" TEXT,
ADD COLUMN     "mobileIdx" TEXT NOT NULL,
ADD COLUMN     "occupation" TEXT,
ADD COLUMN     "ophthalmicHistory" TEXT,
ADD COLUMN     "patientSeq" SERIAL NOT NULL,
ADD COLUMN     "philhealthNumber" TEXT,
ADD COLUMN     "referralSource" TEXT,
ADD COLUMN     "registeredClinicId" TEXT NOT NULL,
ADD COLUMN     "sex" "Sex" NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ALTER COLUMN "mobileNumber" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Patient_patientSeq_key" ON "Patient"("patientSeq");

-- CreateIndex
CREATE INDEX "Patient_lastNameIdx_idx" ON "Patient"("lastNameIdx");

-- CreateIndex
CREATE INDEX "Patient_firstNameIdx_idx" ON "Patient"("firstNameIdx");

-- CreateIndex
CREATE INDEX "Patient_dobIdx_lastNameIdx_idx" ON "Patient"("dobIdx", "lastNameIdx");

-- CreateIndex
CREATE INDEX "Patient_mobileIdx_idx" ON "Patient"("mobileIdx");

-- CreateIndex
CREATE INDEX "Patient_registeredClinicId_idx" ON "Patient"("registeredClinicId");

-- AddForeignKey
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_registeredClinicId_fkey" FOREIGN KEY ("registeredClinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

