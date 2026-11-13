-- Password reuse history and the forced-reset flag (QA 1, SDD 7.2).

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordHistory" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mustResetPassword" BOOLEAN NOT NULL DEFAULT false;
