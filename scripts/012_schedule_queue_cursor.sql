-- Schedules: queue cursor tracking
-- Prevents dropping backlog when >N feed items arrive between schedule runs.

ALTER TABLE schedules
  ADD COLUMN IF NOT EXISTS last_queued_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_schedules_last_queued_at
  ON schedules(last_queued_at DESC);
