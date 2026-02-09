-- Migration 022: Fix schedule state sync semantics
-- "paused" must not be treated as running.

UPDATE schedules
SET state = CASE
  WHEN COALESCE(active, false) THEN 'active'
  ELSE 'stopped'
END
WHERE state IS NULL;

UPDATE schedules
SET active = CASE
  WHEN state = 'active' THEN true
  ELSE false
END
WHERE state IN ('active', 'paused', 'stopped', 'draft');

CREATE OR REPLACE FUNCTION sync_schedule_active_state()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.state IS NULL OR NEW.state NOT IN ('active', 'paused', 'stopped', 'draft') THEN
        NEW.state = CASE
            WHEN COALESCE(NEW.active, false) THEN 'active'
            ELSE 'stopped'
        END;
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.state = OLD.state AND NEW.active IS DISTINCT FROM OLD.active THEN
        NEW.state = CASE
            WHEN COALESCE(NEW.active, false) THEN 'active'
            ELSE 'stopped'
        END;
    END IF;

    NEW.active = (NEW.state = 'active');
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS sync_schedule_state ON schedules;
CREATE TRIGGER sync_schedule_state BEFORE INSERT OR UPDATE ON schedules
    FOR EACH ROW EXECUTE FUNCTION sync_schedule_active_state();
