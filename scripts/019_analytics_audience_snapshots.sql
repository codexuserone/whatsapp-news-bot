-- Audience snapshots for analytics trend calculations

CREATE TABLE IF NOT EXISTS audience_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  target_id UUID NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'unknown' CHECK (source IN ('group', 'channel', 'status', 'unknown')),
  audience_size INTEGER NOT NULL CHECK (audience_size >= 0),
  metadata JSONB,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audience_snapshots_target_time
  ON audience_snapshots(target_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_audience_snapshots_captured_at
  ON audience_snapshots(captured_at DESC);
