-- AlterTable: account approval trail (QA 4).
-- requestedRole keeps what the account asked for at sign-up, separate from
-- `role`, which is the one the doctor granted and the one that gets enforced.
ALTER TABLE "User" ADD COLUMN     "requestedRole" "UserRole",
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "approvedAt" TIMESTAMP(3);

-- Existing accounts predate the approval queue. Treat the role they already
-- hold as the role they asked for so the admin screen has something to show.
UPDATE "User" SET "requestedRole" = "role" WHERE "requestedRole" IS NULL;

-- CreateIndex
CREATE INDEX "User_approvedById_idx" ON "User"("approvedById");

-- AddForeignKey: SetNull so deleting a doctor never deletes the accounts they
-- approved, it just forgets who approved them.
ALTER TABLE "User" ADD CONSTRAINT "User_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
