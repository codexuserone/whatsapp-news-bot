-- Migration 045: keep group delivery history conservative.
-- Baileys group status updates are reliable enough for delivered, but too optimistic for operator-facing read/played labels.

UPDATE message_logs ml
SET
  status = 'delivered',
  read_at = NULL,
  played_at = NULL
FROM targets t
WHERE t.id = ml.target_id
  AND t.type = 'group'
  AND ml.status IN ('read', 'played');
