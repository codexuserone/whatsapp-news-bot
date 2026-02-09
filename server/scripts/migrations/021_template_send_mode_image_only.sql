UPDATE templates
SET send_mode = CASE
  WHEN send_mode = 'image' AND COALESCE(send_images, true) = false THEN 'image_only'
  WHEN send_mode IS NULL OR send_mode NOT IN ('image', 'image_only', 'link_preview', 'text_only') THEN
    CASE
      WHEN COALESCE(send_images, true) = false THEN 'link_preview'
      ELSE 'image'
    END
  ELSE send_mode
END;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'templates_send_mode_check'
  ) THEN
    ALTER TABLE templates
      DROP CONSTRAINT templates_send_mode_check;
  END IF;
END $$;

ALTER TABLE templates
  ADD CONSTRAINT templates_send_mode_check
  CHECK (send_mode IN ('image', 'image_only', 'link_preview', 'text_only'));

ALTER TABLE templates
  ALTER COLUMN send_mode SET DEFAULT 'image';

ALTER TABLE templates
  ALTER COLUMN send_mode SET NOT NULL;
