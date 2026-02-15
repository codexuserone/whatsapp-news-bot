-- Migration 026: Preserve message_logs history when schedules are deleted.
-- The code expects sent history to remain for audit after deleting an automation.
--
-- Default Postgres naming varies (inline FK vs explicit). Drop any existing FK on
-- message_logs.schedule_id and recreate it as ON DELETE SET NULL.

ALTER TABLE message_logs
  DROP CONSTRAINT IF EXISTS message_logs_schedule_id_fkey;

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT conname
    INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'message_logs'::regclass
    AND contype = 'f'
    AND pg_get_constraintdef(oid) ILIKE '%FOREIGN KEY (schedule_id)%REFERENCES schedules%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE message_logs DROP CONSTRAINT IF EXISTS %I', constraint_name);
  END IF;
END $$;

ALTER TABLE message_logs
  ADD CONSTRAINT message_logs_schedule_id_fkey
  FOREIGN KEY (schedule_id)
  REFERENCES schedules(id)
  ON DELETE SET NULL;

