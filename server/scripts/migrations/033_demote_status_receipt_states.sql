-- Migration 033: remove unreliable read/delivered labels from historical Status logs.

UPDATE message_logs ml
SET status = 'sent'
FROM targets t
WHERE t.id = ml.target_id
  AND t.type = 'status'
  AND ml.status IN ('delivered', 'read', 'played')
  AND ml.whatsapp_message_id IS NOT NULL;
