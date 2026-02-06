-- Ensure chat_messages keeps one row per WhatsApp message id.
-- This removes legacy duplicates (same whatsapp_id) and prevents re-inserts
-- when Baileys emits repeated upsert events.

WITH ranked AS (
  SELECT
    ctid,
    row_number() OVER (
      PARTITION BY whatsapp_id
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM chat_messages
  WHERE whatsapp_id IS NOT NULL
)
DELETE FROM chat_messages
WHERE ctid IN (SELECT ctid FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_whatsapp_id_unique
  ON chat_messages(whatsapp_id)
  WHERE whatsapp_id IS NOT NULL;
