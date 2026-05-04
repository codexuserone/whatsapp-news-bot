INSERT INTO settings (key, value)
VALUES ('status_include_sender', 'false'::jsonb)
ON CONFLICT (key) DO UPDATE
SET value = 'false'::jsonb;
