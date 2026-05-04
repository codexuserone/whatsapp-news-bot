-- Migration 036: expose production Status group audience behavior as a saved setting.

INSERT INTO settings (key, value, description)
VALUES (
  'status_include_group_participants',
  'true',
  'When true, auto Status audience may include people from synced WhatsApp groups.'
)
ON CONFLICT (key) DO NOTHING;
