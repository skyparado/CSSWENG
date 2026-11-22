-- Clinical retention is undecided. Preserve the original contact history.
CREATE FUNCTION prevent_outreach_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Contact history cannot be deleted';
END;
$$;
CREATE TRIGGER outreach_delete_immutable BEFORE DELETE ON "OutreachLog"
FOR EACH ROW EXECUTE FUNCTION prevent_outreach_delete();
