-- Migration: Add retry_count column to message_logs
-- This column tracks how many times a message has been retried

-- Add retry_count column if it doesn't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'message_logs' AND column_name = 'retry_count'
  ) THEN
    ALTER TABLE message_logs ADD COLUMN retry_count INTEGER DEFAULT 0;
  END IF;
END $$;
