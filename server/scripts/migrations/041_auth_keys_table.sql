CREATE TABLE IF NOT EXISTS auth_keys (
  session_id TEXT NOT NULL,
  category TEXT NOT NULL,
  key_id TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (session_id, category, key_id)
);

INSERT INTO auth_keys (session_id, category, key_id, value, updated_at)
SELECT auth_state.session_id, categories.key, entries.key, entries.value, NOW()
FROM auth_state
CROSS JOIN LATERAL jsonb_each(COALESCE(auth_state.keys, '{}'::jsonb)) AS categories(key, value)
CROSS JOIN LATERAL jsonb_each(COALESCE(categories.value, '{}'::jsonb)) AS entries(key, value)
ON CONFLICT (session_id, category, key_id)
DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

UPDATE auth_state
SET keys = '{}'::jsonb
WHERE keys IS NOT NULL AND keys <> '{}'::jsonb;
