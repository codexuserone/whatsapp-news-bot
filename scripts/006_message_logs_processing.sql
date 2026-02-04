-- Migration: add processing status and timestamps

ALTER TABLE message_logs
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

ALTER TABLE message_logs
  DROP CONSTRAINT IF EXISTS message_logs_status_check;

ALTER TABLE message_logs
  ADD CONSTRAINT message_logs_status_check
  CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'delivered', 'read', 'skipped'));

CREATE INDEX IF NOT EXISTS idx_message_logs_processing_started_at
  ON message_logs(processing_started_at);
