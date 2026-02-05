-- Schedules: delivery modes (immediate vs batched windows)

ALTER TABLE schedules
  ADD COLUMN IF NOT EXISTS delivery_mode TEXT NOT NULL DEFAULT 'immediate' CHECK (delivery_mode IN ('immediate', 'batched')),
  ADD COLUMN IF NOT EXISTS batch_times TEXT[] NOT NULL DEFAULT ARRAY['07:00','15:00','22:00'],
  ADD COLUMN IF NOT EXISTS last_dispatched_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_schedules_delivery_mode
  ON schedules(delivery_mode);

CREATE INDEX IF NOT EXISTS idx_schedules_last_dispatched_at
  ON schedules(last_dispatched_at DESC);
