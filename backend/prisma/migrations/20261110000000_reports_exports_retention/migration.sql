-- Report exports (background jobs) and audit-log retention.

-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('PDF', 'CSV');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "ReportExport" (
    "id" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "report" TEXT NOT NULL,
    "format" "ExportFormat" NOT NULL,
    "params" JSONB NOT NULL,
    "status" "ExportStatus" NOT NULL DEFAULT 'QUEUED',
    "objectKey" TEXT,
    "fileName" TEXT,
    "sizeBytes" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ReportExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReportExport_requestedById_createdAt_idx" ON "ReportExport"("requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "ReportExport_status_createdAt_idx" ON "ReportExport"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "ReportExport" ADD CONSTRAINT "ReportExport_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Audit retention (SDD 7.3): entries are kept for at least five years, then a
-- batch purge may remove them. The table stays append-only for everything else.
-- A DELETE is allowed only when ALL of these hold:
--   * the purge job set app.audit_retention_purge = 'on' for its own transaction;
--   * the row is more than five years old.
-- Nobody can delete a recent entry, and UPDATE is still always refused.
CREATE OR REPLACE FUNCTION audit_log_no_update_delete()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.audit_retention_purge', true) = 'on'
     AND OLD."createdAt" < now() - interval '5 years' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'AuditLog is append-only; % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;
