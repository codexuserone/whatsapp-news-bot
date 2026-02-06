-- Migration 001: Base Schema
-- Creates all core tables for WhatsApp News Bot
-- Run this first on a fresh database

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Feeds table
CREATE TABLE IF NOT EXISTS feeds (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    type TEXT DEFAULT 'rss',
    fetch_interval INTEGER DEFAULT 300,
    active BOOLEAN DEFAULT true,
    last_fetch_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Feed items table
CREATE TABLE IF NOT EXISTS feed_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    feed_id UUID REFERENCES feeds(id) ON DELETE CASCADE,
    title TEXT,
    link TEXT,
    description TEXT,
    content TEXT,
    author TEXT,
    image_url TEXT,
    image_source TEXT,
    image_scraped_at TIMESTAMPTZ,
    image_scrape_error TEXT,
    pub_date TIMESTAMPTZ,
    categories TEXT[],
    guid TEXT,
    normalized_url TEXT,
    content_hash TEXT,
    raw_data JSONB,
    sent BOOLEAN DEFAULT false,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Templates table
CREATE TABLE IF NOT EXISTS templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    description TEXT,
    send_images BOOLEAN DEFAULT true,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Targets table (WhatsApp recipients)
CREATE TABLE IF NOT EXISTS targets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('individual', 'group', 'channel', 'status')),
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Schedules table
CREATE TABLE IF NOT EXISTS schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    feed_id UUID REFERENCES feeds(id) ON DELETE SET NULL,
    template_id UUID REFERENCES templates(id) ON DELETE SET NULL,
    target_ids UUID[] DEFAULT '{}',
    cron_expression TEXT,
    timezone TEXT DEFAULT 'UTC',
    active BOOLEAN DEFAULT true,
    last_run_at TIMESTAMPTZ,
    last_queued_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Message logs table (queue)
CREATE TABLE IF NOT EXISTS message_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    schedule_id UUID REFERENCES schedules(id) ON DELETE CASCADE,
    feed_item_id UUID REFERENCES feed_items(id) ON DELETE CASCADE,
    target_id UUID REFERENCES targets(id) ON DELETE CASCADE,
    template_id UUID REFERENCES templates(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'skipped')),
    message_content TEXT,
    whatsapp_message_id TEXT,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    processing_started_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    media_url TEXT,
    media_type TEXT,
    media_sent BOOLEAN DEFAULT false,
    media_error TEXT,
    UNIQUE(schedule_id, feed_item_id, target_id)
);

-- Settings table
CREATE TABLE IF NOT EXISTS settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key TEXT NOT NULL UNIQUE,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auth state table (WhatsApp session storage)
CREATE TABLE IF NOT EXISTS auth_state (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id TEXT NOT NULL UNIQUE,
    creds JSONB,
    keys JSONB,
    status TEXT DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'connecting', 'qr', 'qr_ready', 'connected', 'error', 'conflict')),
    qr_code TEXT,
    last_connected_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    -- Lease system columns (migration 011)
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ
);

-- Feed images table
CREATE TABLE IF NOT EXISTS feed_images (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    feed_item_id UUID REFERENCES feed_items(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    cached_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chat messages table (incoming/outgoing)
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    whatsapp_id TEXT,
    remote_jid TEXT NOT NULL,
    from_me BOOLEAN DEFAULT false,
    message_type TEXT DEFAULT 'text',
    content TEXT,
    media_url TEXT,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    status TEXT DEFAULT 'received',
    raw_message JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Schedule locks table (migration 013)
CREATE TABLE IF NOT EXISTS schedule_locks (
    schedule_id UUID PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
    locked_by TEXT NOT NULL,
    locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_until TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_feed_items_feed_id ON feed_items(feed_id);
CREATE INDEX IF NOT EXISTS idx_feed_items_sent ON feed_items(sent);
CREATE INDEX IF NOT EXISTS idx_feed_items_created_at ON feed_items(created_at);
CREATE INDEX IF NOT EXISTS idx_message_logs_schedule_id ON message_logs(schedule_id);
CREATE INDEX IF NOT EXISTS idx_message_logs_status ON message_logs(status);
CREATE INDEX IF NOT EXISTS idx_message_logs_feed_item_id ON message_logs(feed_item_id);
CREATE INDEX IF NOT EXISTS idx_schedules_active ON schedules(active);
CREATE INDEX IF NOT EXISTS idx_schedules_feed_id ON schedules(feed_id);
CREATE INDEX IF NOT EXISTS idx_schedule_locks_locked_until ON schedule_locks(locked_until);
CREATE INDEX IF NOT EXISTS idx_chat_messages_remote_jid ON chat_messages(remote_jid);
CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp DESC);

-- Insert default settings
INSERT INTO settings (key, value) VALUES
    ('app_name', '"WhatsApp News Bot"'::jsonb),
    ('retention_days', '14'::jsonb),
    ('default_timezone', '"UTC"'::jsonb),
    ('message_delay_ms', '2000'::jsonb),
    ('max_retries', '3'::jsonb),
    ('defaultInterTargetDelaySec', '8'::jsonb),
    ('defaultIntraTargetDelaySec', '3'::jsonb),
    ('dedupeThreshold', '0.88'::jsonb),
    ('processingTimeoutMinutes', '30'::jsonb),
    ('feed_fetch_timeout_ms', '30000'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
CREATE TRIGGER update_feeds_updated_at BEFORE UPDATE ON feeds
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_templates_updated_at BEFORE UPDATE ON templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_targets_updated_at BEFORE UPDATE ON targets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_schedules_updated_at BEFORE UPDATE ON schedules
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_message_logs_updated_at BEFORE UPDATE ON message_logs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_settings_updated_at BEFORE UPDATE ON settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_auth_state_updated_at BEFORE UPDATE ON auth_state
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
