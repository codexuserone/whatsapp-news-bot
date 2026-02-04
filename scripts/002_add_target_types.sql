-- Migration: Add channel and status types to targets
-- Also ensure cleaning column exists for feeds

-- Update targets type constraint to allow more types
ALTER TABLE targets DROP CONSTRAINT IF EXISTS targets_type_check;
ALTER TABLE targets ADD CONSTRAINT targets_type_check 
  CHECK (type IN ('individual', 'group', 'channel', 'status'));

-- Add cleaning column to feeds if it doesn't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'feeds' AND column_name = 'cleaning'
  ) THEN
    ALTER TABLE feeds ADD COLUMN cleaning JSONB DEFAULT '{"stripUtm": true, "decodeEntities": true}'::jsonb;
  END IF;
END $$;
