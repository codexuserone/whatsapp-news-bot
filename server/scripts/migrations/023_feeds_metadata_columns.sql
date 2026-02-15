-- Migration 023: Bring feeds table in line with current runtime expectations.
-- Safe/idempotent for existing databases.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'feeds'
      AND column_name = 'last_fetch_at'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'feeds'
      AND column_name = 'last_fetched_at'
  ) THEN
    ALTER TABLE feeds RENAME COLUMN last_fetch_at TO last_fetched_at;
  END IF;
END $$;

ALTER TABLE feeds
  ADD COLUMN IF NOT EXISTS etag TEXT,
  ADD COLUMN IF NOT EXISTS last_modified TEXT,
  ADD COLUMN IF NOT EXISTS last_fetched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cleaning JSONB;

