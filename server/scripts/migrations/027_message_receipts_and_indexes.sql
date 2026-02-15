-- Migration 027: Delivery receipt timestamps + status expansion + indexes.
-- Enables persisted delivered/read/played analytics and faster history queries.

ALTER TABLE message_logs
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS played_at TIMESTAMPTZ;

-- Update message_logs.status CHECK to include "played" (video playback receipt).
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
    'delivered',
    'read',
    'played',
    'failed',
    'skipped'
  ));

-- Indexes: support queue/history queries and receipt lookups.
CREATE INDEX IF NOT EXISTS idx_message_logs_whatsapp_message_id
  ON message_logs(whatsapp_message_id);

CREATE INDEX IF NOT EXISTS idx_message_logs_created_at_desc
  ON message_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_message_logs_status_created_at_desc
  ON message_logs(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_message_logs_sent_at_desc
  ON message_logs(sent_at DESC)
  WHERE sent_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_logs_status_sent_at_desc
  ON message_logs(status, sent_at DESC)
  WHERE sent_at IS NOT NULL;

