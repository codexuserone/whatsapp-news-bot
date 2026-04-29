-- Migration 031: status audience settings and template sequences.

ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS sequence_steps JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE message_logs
  ADD COLUMN IF NOT EXISTS sequence_step_index INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sequence_step_label TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;

UPDATE message_logs
SET sequence_step_index = 0
WHERE sequence_step_index IS NULL;

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT c.conname
  INTO constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = current_schema()
    AND t.relname = 'message_logs'
    AND c.contype = 'u'
    AND (
      SELECT array_agg(a.attname::text ORDER BY u.ord)
      FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
    ) = ARRAY['schedule_id', 'feed_item_id', 'target_id']
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE message_logs DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_logs_unique_dispatch_step
  ON message_logs(schedule_id, feed_item_id, target_id, sequence_step_index);

CREATE INDEX IF NOT EXISTS idx_message_logs_pending_scheduled_for
  ON message_logs(status, scheduled_for, created_at, id)
  WHERE status IN ('awaiting_approval', 'pending', 'processing');

INSERT INTO settings (key, value, description)
VALUES
  ('status_audience_mode', '"auto"', 'Status audience mode: auto or explicit'),
  ('status_audience_jids', '""', 'Production Status audience JIDs when status_audience_mode is explicit'),
  ('status_test_audience_jids', '""', 'Manual Status test audience JIDs')
ON CONFLICT (key) DO NOTHING;
