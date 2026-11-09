-- A finding or lab result can be corrected only once; a second correction
-- amends the latest row. The unique index stops two simultaneous amendments
-- of the same row (the services turn the violation into 409 ALREADY_AMENDED).

-- DropIndex
DROP INDEX "ExamFinding_amendsFindingId_idx";

-- DropIndex
DROP INDEX "LabResult_amendsLabResultId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "ExamFinding_amendsFindingId_key" ON "ExamFinding"("amendsFindingId");

-- CreateIndex
CREATE UNIQUE INDEX "LabResult_amendsLabResultId_key" ON "LabResult"("amendsLabResultId");

