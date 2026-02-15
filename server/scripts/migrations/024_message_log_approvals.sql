-- Migration 024: Add approval workflow support for queue items.
-- Safe/idempotent for existing databases.

ALTER TABLE schedules
  ADD COLUMN IF NOT EXISTS approval_required BOOLEAN DEFAULT false;

ALTER TABLE message_logs
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by TEXT;

-- Update message_logs.status CHECK to include awaiting_approval and newer delivery states.
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT conname
  INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'message_logs'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%'
  ORDER BY conname
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE message_logs DROP CONSTRAINT IF EXISTS %I', constraint_name);
  END IF;
END $$;

ALTER TABLE message_logs
  ADD CONSTRAINT message_logs_status_check
  CHECK (status IN (
    'awaiting_approval',
    'pending',
    'processing',
    'sent',
    'failed',
    'delivered',
    'read',
    'skipped'
  ));

