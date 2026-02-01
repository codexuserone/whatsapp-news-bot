-- WhatsApp News Bot - Complete Database Schema
-- Migration from MongoDB to Supabase

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- FEEDS TABLE
-- Stores RSS/Atom feed configurations
-- ============================================
CREATE TABLE IF NOT EXISTS feeds (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'rss' CHECK (type IN ('rss', 'atom', 'json')),
  active BOOLEAN DEFAULT true,
  fetch_interval INTEGER DEFAULT 300, -- in seconds
  last_fetched_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- FEED_ITEMS TABLE
-- Stores individual items fetched from feeds
-- ============================================
CREATE TABLE IF NOT EXISTS feed_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  feed_id UUID NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  title TEXT,
  description TEXT,
  content TEXT,
  link TEXT,
  author TEXT,
  pub_date TIMESTAMPTZ,
  image_url TEXT,
  categories TEXT[],
  raw_data JSONB,
  sent BOOLEAN DEFAULT false,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(feed_id, guid)
);

-- ============================================
-- TEMPLATES TABLE
-- Stores message templates with dynamic variables
-- ============================================
CREATE TABLE IF NOT EXISTS templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  description TEXT,
  variables JSONB DEFAULT '[]'::jsonb, -- Array of variable names used in template
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- TARGETS TABLE
-- Stores WhatsApp target numbers/groups
-- ============================================
CREATE TABLE IF NOT EXISTS targets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'individual' CHECK (type IN ('individual', 'group', 'channel', 'status')),
  active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- SCHEDULES TABLE
-- Stores scheduled message delivery configurations
-- ============================================
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
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- MESSAGE_LOGS TABLE
-- Stores sent message history
-- ============================================
CREATE TABLE IF NOT EXISTS message_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  schedule_id UUID REFERENCES schedules(id) ON DELETE SET NULL,
  feed_item_id UUID REFERENCES feed_items(id) ON DELETE SET NULL,
  target_id UUID REFERENCES targets(id) ON DELETE SET NULL,
  template_id UUID REFERENCES templates(id) ON DELETE SET NULL,
  message_content TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'delivered', 'read')),
  error_message TEXT,
  whatsapp_message_id TEXT,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- SETTINGS TABLE
-- Stores application settings as key-value pairs
-- ============================================
CREATE TABLE IF NOT EXISTS settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key TEXT UNIQUE NOT NULL,
  value JSONB NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- AUTH_STATE TABLE
-- Stores WhatsApp authentication state
-- ============================================
CREATE TABLE IF NOT EXISTS auth_state (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id TEXT UNIQUE NOT NULL DEFAULT 'default',
  creds JSONB,
  keys JSONB,
  qr_code TEXT,
  status TEXT DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'connecting', 'connected', 'qr_ready')),
  last_connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- CHAT_MESSAGES TABLE
-- Stores incoming/outgoing WhatsApp messages
-- ============================================
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

-- ============================================
-- INDEXES for performance
-- ============================================
CREATE INDEX IF NOT EXISTS idx_feed_items_feed_id ON feed_items(feed_id);
CREATE INDEX IF NOT EXISTS idx_feed_items_pub_date ON feed_items(pub_date DESC);
CREATE INDEX IF NOT EXISTS idx_feed_items_sent ON feed_items(sent);
CREATE INDEX IF NOT EXISTS idx_feed_items_guid ON feed_items(guid);
CREATE INDEX IF NOT EXISTS idx_message_logs_schedule_id ON message_logs(schedule_id);
CREATE INDEX IF NOT EXISTS idx_message_logs_status ON message_logs(status);
CREATE INDEX IF NOT EXISTS idx_message_logs_sent_at ON message_logs(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_remote_jid ON chat_messages(remote_jid);
CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_schedules_active ON schedules(active);
CREATE INDEX IF NOT EXISTS idx_feeds_active ON feeds(active);

-- ============================================
-- FUNCTIONS for updated_at triggers
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- ============================================
-- TRIGGERS for auto-updating updated_at
-- ============================================
DROP TRIGGER IF EXISTS update_feeds_updated_at ON feeds;
CREATE TRIGGER update_feeds_updated_at
  BEFORE UPDATE ON feeds
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_feed_items_updated_at ON feed_items;
CREATE TRIGGER update_feed_items_updated_at
  BEFORE UPDATE ON feed_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_templates_updated_at ON templates;
CREATE TRIGGER update_templates_updated_at
  BEFORE UPDATE ON templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_targets_updated_at ON targets;
CREATE TRIGGER update_targets_updated_at
  BEFORE UPDATE ON targets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_schedules_updated_at ON schedules;
CREATE TRIGGER update_schedules_updated_at
  BEFORE UPDATE ON schedules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_settings_updated_at ON settings;
CREATE TRIGGER update_settings_updated_at
  BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_auth_state_updated_at ON auth_state;
CREATE TRIGGER update_auth_state_updated_at
  BEFORE UPDATE ON auth_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- INSERT DEFAULT SETTINGS
-- ============================================
INSERT INTO settings (key, value, description) VALUES
  ('app_name', '"WhatsApp News Bot"', 'Application name'),
  ('default_timezone', '"UTC"', 'Default timezone for schedules'),
  ('message_delay_ms', '2000', 'Delay between messages in milliseconds'),
  ('max_retries', '3', 'Maximum retry attempts for failed messages'),
  ('feed_fetch_timeout_ms', '30000', 'Feed fetch timeout in milliseconds')
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- INSERT DEFAULT AUTH STATE
-- ============================================
INSERT INTO auth_state (session_id, status) VALUES ('default', 'disconnected')
ON CONFLICT (session_id) DO NOTHING;
