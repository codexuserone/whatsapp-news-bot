-- Migration 034: keep first feed imports from silently skipping current items.

INSERT INTO settings (key, value, description)
VALUES
  ('initial_fetch_limit', '20', 'Number of newest items imported the first time a feed is fetched')
ON CONFLICT (key) DO UPDATE
SET value = CASE
    WHEN settings.value IS NULL THEN EXCLUDED.value
    WHEN jsonb_typeof(settings.value) = 'number' AND (settings.value #>> '{}')::numeric < 20 THEN EXCLUDED.value
    WHEN jsonb_typeof(settings.value) = 'string'
      AND (settings.value #>> '{}') ~ '^[0-9]+(\.[0-9]+)?$'
      AND (settings.value #>> '{}')::numeric < 20 THEN EXCLUDED.value
    ELSE settings.value
  END,
  description = COALESCE(settings.description, EXCLUDED.description);
