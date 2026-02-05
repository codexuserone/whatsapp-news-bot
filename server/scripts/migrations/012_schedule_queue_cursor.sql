-- Migration 012: Add queue cursor columns to schedules
-- Tracks last queued position to prevent re-scanning same items

ALTER TABLE schedules 
ADD COLUMN IF NOT EXISTS last_queued_at TIMESTAMPTZ;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_schedules_last_queued_at ON schedules(last_queued_at);
