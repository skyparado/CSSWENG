-- CreateTable
CREATE TABLE "UserClinic" (
    "userId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserClinic_pkey" PRIMARY KEY ("userId","clinicId")
);

-- CreateIndex
CREATE INDEX "UserClinic_userId_idx" ON "UserClinic"("userId");

-- CreateIndex
CREATE INDEX "UserClinic_clinicId_idx" ON "UserClinic"("clinicId");

-- AddForeignKey
ALTER TABLE "UserClinic" ADD CONSTRAINT "UserClinic_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserClinic" ADD CONSTRAINT "UserClinic_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
