-- Migration 030: message log correction metadata.
-- Tracks when queued/sent rows were corrected after a feed item changed.

ALTER TABLE message_logs
  ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS correction_kind TEXT,
  ADD COLUMN IF NOT EXISTS correction_error TEXT;

CREATE INDEX IF NOT EXISTS idx_message_logs_corrected_at_desc
  ON message_logs(corrected_at DESC)
  WHERE corrected_at IS NOT NULL;
