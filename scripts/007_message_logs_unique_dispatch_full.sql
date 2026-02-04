-- Ensure full unique index for upsert conflict target

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_logs_unique_dispatch_full
  ON message_logs(schedule_id, feed_item_id, target_id);
