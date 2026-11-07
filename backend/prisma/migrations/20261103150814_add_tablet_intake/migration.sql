-- CreateEnum
CREATE TYPE "TabletIntakeStatus" AS ENUM ('ACTIVE', 'SUBMITTED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "TabletIntakeSession" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "startedBySecretaryId" TEXT,
    "token" TEXT NOT NULL,
    "status" "TabletIntakeStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "TabletIntakeSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TabletIntakeSubmission" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TabletIntakeSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TabletIntakeSession_token_key" ON "TabletIntakeSession"("token");

-- CreateIndex
CREATE INDEX "TabletIntakeSession_status_idx" ON "TabletIntakeSession"("status");

-- CreateIndex
CREATE INDEX "TabletIntakeSession_clinicId_createdAt_idx" ON "TabletIntakeSession"("clinicId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TabletIntakeSubmission_sessionId_key" ON "TabletIntakeSubmission"("sessionId");

-- CreateIndex
CREATE INDEX "TabletIntakeSubmission_patientId_idx" ON "TabletIntakeSubmission"("patientId");

-- AddForeignKey
ALTER TABLE "TabletIntakeSession" ADD CONSTRAINT "TabletIntakeSession_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TabletIntakeSession" ADD CONSTRAINT "TabletIntakeSession_startedBySecretaryId_fkey" FOREIGN KEY ("startedBySecretaryId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TabletIntakeSubmission" ADD CONSTRAINT "TabletIntakeSubmission_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TabletIntakeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TabletIntakeSubmission" ADD CONSTRAINT "TabletIntakeSubmission_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
