-- Feed health + conditional request caching

ALTER TABLE feeds
  ADD COLUMN IF NOT EXISTS etag TEXT,
  ADD COLUMN IF NOT EXISTS last_modified TEXT,
  ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_feeds_last_fetched_at ON feeds(last_fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_feeds_last_success_at ON feeds(last_success_at DESC);
