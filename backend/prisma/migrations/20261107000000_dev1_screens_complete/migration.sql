-- UserClinic is created by 20261107112813_add_user_clinic (main), which also
-- adds assignedAt. Creating it here too would fail on a fresh database.

-- CreateEnum
CREATE TYPE "AppointmentAction" AS ENUM ('BOOKED', 'RESCHEDULED', 'CANCELLED', 'STATUS_CHANGED', 'WALK_IN_APPROVED');

-- CreateEnum
CREATE TYPE "DocumentRequestChannel" AS ENUM ('PHONE', 'IN_PERSON', 'EMAIL');

-- AlterEnum
ALTER TYPE "DocumentRequestStatus" ADD VALUE 'REQUESTED';

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "visitType" TEXT,
ADD COLUMN     "walkIn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "walkInApprovedAt" TIMESTAMP(3),
ADD COLUMN     "walkInApprovedById" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "previousVersionId" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "DocumentRequest" ADD COLUMN     "notes" TEXT,
ADD COLUMN     "requestedVia" "DocumentRequestChannel",
ADD COLUMN     "safetyAcknowledgements" JSONB,
ALTER COLUMN "payload" DROP NOT NULL;

-- CreateTable
CREATE TABLE "AppointmentEvent" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "action" "AppointmentAction" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "AppointmentStatus" NOT NULL,
    "reason" TEXT,
    "actorId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentDelivery" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "via" "DocumentSendChannel" NOT NULL,
    "toEmail" TEXT,
    "messageId" TEXT,
    "sentById" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppointmentEvent_appointmentId_at_idx" ON "AppointmentEvent"("appointmentId", "at");

-- CreateIndex
CREATE INDEX "DocumentDelivery_documentId_sentAt_idx" ON "DocumentDelivery"("documentId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "Document_previousVersionId_key" ON "Document"("previousVersionId");

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_walkInApprovedById_fkey" FOREIGN KEY ("walkInApprovedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentEvent" ADD CONSTRAINT "AppointmentEvent_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentEvent" ADD CONSTRAINT "AppointmentEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_previousVersionId_fkey" FOREIGN KEY ("previousVersionId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentDelivery" ADD CONSTRAINT "DocumentDelivery_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentDelivery" ADD CONSTRAINT "DocumentDelivery_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

