-- Migration: Add missing indexes for performance optimization
-- These indexes are critical for queries used in the dispatch system

-- Index for message_logs queries by target_id and status
CREATE INDEX IF NOT EXISTS idx_message_logs_target_id ON message_logs(target_id);
CREATE INDEX IF NOT EXISTS idx_message_logs_feed_item_id ON message_logs(feed_item_id);
CREATE INDEX IF NOT EXISTS idx_message_logs_template_id ON message_logs(template_id);

-- Composite index for message_logs lookup in queueService
CREATE INDEX IF NOT EXISTS idx_message_logs_schedule_target_status ON message_logs(schedule_id, target_id, status);

-- Index for feed_items lookup by feed_id and created_at
CREATE INDEX IF NOT EXISTS idx_feed_items_feed_id_created_at ON feed_items(feed_id, created_at DESC);

-- Index for schedules lookup by feed_id and active status
CREATE INDEX IF NOT EXISTS idx_schedules_feed_id_active ON schedules(feed_id, active);

-- Index for targets lookup by active status
CREATE INDEX IF NOT EXISTS idx_targets_active ON targets(active);

-- Index for templates lookup by active status
CREATE INDEX IF NOT EXISTS idx_templates_active ON templates(active);

-- Index for auth_state lookup by session_id
CREATE INDEX IF NOT EXISTS idx_auth_state_session_id ON auth_state(session_id);

-- Index for settings lookup by key
CREATE INDEX IF NOT EXISTS idx_settings_key ON settings(key);
