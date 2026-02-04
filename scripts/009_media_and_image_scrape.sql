-- Track image scraping and media send outcomes

ALTER TABLE feed_items
  ADD COLUMN IF NOT EXISTS image_source TEXT,
  ADD COLUMN IF NOT EXISTS image_scraped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS image_scrape_error TEXT;

ALTER TABLE message_logs
  ADD COLUMN IF NOT EXISTS media_url TEXT,
  ADD COLUMN IF NOT EXISTS media_type TEXT,
  ADD COLUMN IF NOT EXISTS media_sent BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS media_error TEXT;

CREATE INDEX IF NOT EXISTS idx_feed_items_image_scraped_at ON feed_items(image_scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_media_sent ON message_logs(media_sent);
