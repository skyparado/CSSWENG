-- Sign in with a username rather than an email address (SRS, SDD, S01).
--
-- Staff email addresses were never credentials in any real sense: nothing is
-- ever sent to them, and the clinic has no mail domain, so the seed used a
-- non-routable one. Email stays on the record for the audit trail; only the
-- login credential changes.
--
-- Added nullable and backfilled from the email local part so existing accounts
-- keep working, then tightened to NOT NULL UNIQUE.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "username" TEXT;

-- "angeline.pacio@clinic.local" -> "angeline.pacio"
UPDATE "User"
SET "username" = lower(regexp_replace(split_part("email", '@', 1), '[^a-zA-Z0-9._-]', '', 'g'))
WHERE "username" IS NULL;

-- Anything that normalised away to nothing falls back to the account id.
UPDATE "User"
SET "username" = 'user' || substr("id", 1, 8)
WHERE "username" IS NULL OR length("username") < 3;

-- Two addresses can share a local part across domains, so give every
-- duplicate a suffix, and keep going until the suffixed name is free too.
DO $$
DECLARE
  dup RECORD;
  candidate TEXT;
  n INT;
BEGIN
  FOR dup IN
    SELECT id, "username" AS base
    FROM (
      SELECT id, "username",
             row_number() OVER (PARTITION BY "username" ORDER BY "createdAt", id) AS rn
      FROM "User"
    ) ranked
    WHERE rn > 1
  LOOP
    n := 2;
    LOOP
      candidate := dup.base || n::text;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "User" WHERE "username" = candidate);
      n := n + 1;
    END LOOP;
    UPDATE "User" SET "username" = candidate WHERE id = dup.id;
  END LOOP;
END $$;

ALTER TABLE "User" ALTER COLUMN "username" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");
