-- Migration: Add schedule_locks table for distributed locking fallback
-- This table is used when PostgreSQL advisory locks are not available

CREATE TABLE IF NOT EXISTS schedule_locks (
  schedule_id UUID PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
  locked_by TEXT NOT NULL,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_schedule_locks_locked_until 
  ON schedule_locks(locked_until);

-- Add comment explaining purpose
COMMENT ON TABLE schedule_locks IS 'Distributed locks for schedule execution - prevents multiple instances from running the same schedule simultaneously';
