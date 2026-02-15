-- Migration 028: Manual queue message fields + settings description drift fix.
-- Safe/idempotent for existing databases.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS description TEXT;

ALTER TABLE message_logs
  ADD COLUMN IF NOT EXISTS disable_link_preview BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS include_caption BOOLEAN DEFAULT true;

