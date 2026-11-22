-- A legacy PENDING claim may already have reached a provider.
UPDATE "ReminderDelivery" SET status = 'UNCERTAIN' WHERE status = 'PENDING';
-- Keep historical simulated attempts identifiable but allow a real future send.
UPDATE "ReminderDelivery" SET status = 'CANCELLED' WHERE "providerMessageId" LIKE 'stub-%';

CREATE FUNCTION protect_outreach_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'deliveryStatus') IS DISTINCT FROM (to_jsonb(OLD) - 'deliveryStatus') OR
     (OLD."deliveryStatus" IS NOT NULL AND NEW."deliveryStatus" IS DISTINCT FROM OLD."deliveryStatus") THEN
    RAISE EXCEPTION 'Only an outstanding delivery status can be updated';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER outreach_attempt_immutable BEFORE UPDATE ON "OutreachLog"
FOR EACH ROW EXECUTE FUNCTION protect_outreach_attempt();
