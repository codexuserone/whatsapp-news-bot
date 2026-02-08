-- Migration 020: Add schedule state management
-- Adds proper state column for pause/start/stop functionality

-- Add state column to schedules table
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS state TEXT DEFAULT 'active' 
  CHECK (state IN ('active', 'paused', 'stopped', 'draft'));

-- Migrate existing data: active=true -> 'active', active=false -> 'stopped'
UPDATE schedules SET state = 'active' WHERE active = true AND state IS NULL;
UPDATE schedules SET state = 'stopped' WHERE active = false AND state IS NULL;

-- Create index for state queries
CREATE INDEX IF NOT EXISTS idx_schedules_state ON schedules(state);

-- Add trigger to keep active column in sync with state (for backwards compatibility)
CREATE OR REPLACE FUNCTION sync_schedule_active_state()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.state = 'active' OR NEW.state = 'paused' THEN
        NEW.active = true;
    ELSE
        NEW.active = false;
    END IF;
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS sync_schedule_state ON schedules;
CREATE TRIGGER sync_schedule_state BEFORE INSERT OR UPDATE ON schedules
    FOR EACH ROW EXECUTE FUNCTION sync_schedule_active_state();
