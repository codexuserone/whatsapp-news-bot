-- Migration 032: template status text styling.

ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS status_background_color TEXT,
  ADD COLUMN IF NOT EXISTS status_font INTEGER;

UPDATE templates
SET status_background_color = NULL
WHERE status_background_color IS NOT NULL
  AND status_background_color !~ '^#[0-9A-Fa-f]{6}$';

UPDATE templates
SET status_font = NULL
WHERE status_font IS NOT NULL
  AND (status_font < 0 OR status_font > 8);
