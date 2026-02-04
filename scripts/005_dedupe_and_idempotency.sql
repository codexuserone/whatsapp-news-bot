-- Migration: Dedupe + idempotent dispatch

ALTER TABLE feed_items
  ADD COLUMN IF NOT EXISTS normalized_url TEXT,
  ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- Ensure one feed item per normalized URL or content hash
CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_items_feed_normalized_url
  ON feed_items(feed_id, normalized_url)
  WHERE normalized_url IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_items_feed_content_hash
  ON feed_items(feed_id, content_hash)
  WHERE content_hash IS NOT NULL;

-- Idempotent dispatch: one message per schedule/feed_item/target
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_logs_unique_dispatch
  ON message_logs(schedule_id, feed_item_id, target_id)
  WHERE feed_item_id IS NOT NULL AND target_id IS NOT NULL;
