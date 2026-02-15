-- Migration 025: Optional per-target delay overrides for rate limiting.
-- Safe/idempotent for existing databases.

ALTER TABLE targets
  ADD COLUMN IF NOT EXISTS message_delay_ms_override INTEGER,
  ADD COLUMN IF NOT EXISTS inter_target_delay_sec_override INTEGER,
  ADD COLUMN IF NOT EXISTS intra_target_delay_sec_override INTEGER;

