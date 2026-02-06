ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS send_mode TEXT DEFAULT 'image';

UPDATE templates
SET send_mode = CASE
  WHEN COALESCE(send_images, true) = false THEN 'link_preview'
  ELSE 'image'
END
WHERE send_mode IS NULL
   OR send_mode NOT IN ('image', 'link_preview', 'text_only');

ALTER TABLE templates
  ALTER COLUMN send_mode SET DEFAULT 'image';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'templates_send_mode_check'
  ) THEN
    ALTER TABLE templates
      ADD CONSTRAINT templates_send_mode_check
      CHECK (send_mode IN ('image', 'link_preview', 'text_only'));
  END IF;
END $$;

ALTER TABLE templates
  ALTER COLUMN send_mode SET NOT NULL;
