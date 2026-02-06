-- Repair schema drift that can block dispatch and delivery verification.
-- 1) Ensure message_logs has updated_at required by update triggers.
-- 2) Ensure ON CONFLICT (whatsapp_id) works for chat_messages upserts.

ALTER TABLE IF EXISTS message_logs
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

UPDATE message_logs
SET updated_at = NOW()
WHERE updated_at IS NULL;

DROP TRIGGER IF EXISTS update_message_logs_updated_at ON message_logs;
CREATE TRIGGER update_message_logs_updated_at
  BEFORE UPDATE ON message_logs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_whatsapp_id_unique_full
  ON chat_messages(whatsapp_id);
