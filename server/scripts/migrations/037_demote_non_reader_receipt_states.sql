-- Migration 037: keep historical receipt states truthful.
-- Only direct chats and groups have useful reader receipt states in this app.

UPDATE message_logs ml
SET
  status = 'sent',
  delivered_at = NULL,
  read_at = NULL,
  played_at = NULL
WHERE ml.status IN ('delivered', 'read', 'played')
  AND NOT EXISTS (
    SELECT 1
    FROM targets t
    WHERE t.id = ml.target_id
      AND t.type IN ('individual', 'group')
  );
