-- Migration 029: delivery reliability foundations.
-- Adds richer feed media columns, persisted status recipients, and expanded queue statuses.

ALTER TABLE feed_items
  ADD COLUMN IF NOT EXISTS media_url TEXT,
  ADD COLUMN IF NOT EXISTS media_kind TEXT,
  ADD COLUMN IF NOT EXISTS media_mime TEXT,
  ADD COLUMN IF NOT EXISTS media_filename TEXT;

UPDATE feed_items
SET
  media_url = COALESCE(
    NULLIF(media_url, ''),
    NULLIF(raw_data->>'media_url', ''),
    NULLIF(image_url, '')
  ),
  media_kind = COALESCE(
    NULLIF(media_kind, ''),
    NULLIF(raw_data->>'media_kind', ''),
    CASE
      WHEN COALESCE(NULLIF(raw_data->>'media_url', ''), NULLIF(image_url, '')) ~* '\.(mp4|mov|avi|mkv|m4v|webm)(\?|#|$)' THEN 'video'
      WHEN COALESCE(NULLIF(raw_data->>'media_url', ''), NULLIF(image_url, '')) ~* '\.(mp3|wav|ogg|m4a|flac|aac|opus|wma)(\?|#|$)' THEN 'audio'
      WHEN COALESCE(NULLIF(raw_data->>'media_url', ''), NULLIF(image_url, '')) ~* '\.(pdf|doc|docx|ppt|pptx|xls|xlsx|csv|txt|rtf|zip)(\?|#|$)' THEN 'document'
      WHEN COALESCE(NULLIF(raw_data->>'media_url', ''), NULLIF(image_url, '')) <> '' THEN 'image'
      ELSE NULL
    END
  ),
  media_mime = COALESCE(NULLIF(media_mime, ''), NULLIF(raw_data->>'media_mime', '')),
  media_filename = COALESCE(NULLIF(media_filename, ''), NULLIF(raw_data->>'media_filename', ''))
WHERE
  media_url IS NULL
  OR media_kind IS NULL
  OR media_mime IS NULL
  OR media_filename IS NULL;

CREATE INDEX IF NOT EXISTS idx_feed_items_feed_pub_created_id
  ON feed_items(feed_id, pub_date DESC NULLS LAST, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_feed_items_feed_media_kind
  ON feed_items(feed_id, media_kind)
  WHERE media_kind IS NOT NULL;

CREATE TABLE IF NOT EXISTS status_recipients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id TEXT NOT NULL DEFAULT 'primary',
  recipient_jid TEXT NOT NULL,
  display_name TEXT,
  source_tags TEXT[] NOT NULL DEFAULT '{}',
  sources JSONB NOT NULL DEFAULT '{}'::jsonb,
  warnings TEXT[] NOT NULL DEFAULT '{}',
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, recipient_jid)
);

CREATE INDEX IF NOT EXISTS idx_status_recipients_session_refreshed
  ON status_recipients(session_id, refreshed_at DESC);

CREATE INDEX IF NOT EXISTS idx_status_recipients_session_recipient
  ON status_recipients(session_id, recipient_jid);

DROP TRIGGER IF EXISTS update_status_recipients_updated_at ON status_recipients;
CREATE TRIGGER update_status_recipients_updated_at BEFORE UPDATE ON status_recipients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT conname
  INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'message_logs'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%'
  ORDER BY conname
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE message_logs DROP CONSTRAINT IF EXISTS %I', constraint_name);
  END IF;
END $$;

ALTER TABLE message_logs
  ADD CONSTRAINT message_logs_status_check
  CHECK (status IN (
    'awaiting_approval',
    'pending',
    'processing',
    'sent',
    'delivered',
    'read',
    'played',
    'uncertain',
    'superseded',
    'failed',
    'skipped'
  ));

CREATE INDEX IF NOT EXISTS idx_message_logs_status_created_id
  ON message_logs(status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_message_logs_schedule_status_created
  ON message_logs(schedule_id, status, created_at DESC, id DESC)
  WHERE schedule_id IS NOT NULL;
