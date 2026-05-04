ALTER TABLE templates
  DROP CONSTRAINT IF EXISTS templates_send_mode_check;

UPDATE templates
SET send_mode = CASE
  WHEN send_mode = 'image' THEN 'auto_media'
  WHEN send_mode = 'image_only' THEN 'media_only'
  WHEN send_mode = 'link_preview' THEN 'text_preview'
  WHEN send_mode IN ('auto_media', 'media_only', 'text_preview', 'text_only') THEN send_mode
  WHEN COALESCE(send_images, true) = false THEN 'text_preview'
  ELSE 'auto_media'
END;

UPDATE templates
SET send_images = send_mode IN ('auto_media', 'media_only');

ALTER TABLE templates
  ADD CONSTRAINT templates_send_mode_check
  CHECK (send_mode IN ('auto_media', 'media_only', 'text_preview', 'text_only'));

ALTER TABLE templates
  ALTER COLUMN send_mode SET DEFAULT 'auto_media';

ALTER TABLE templates
  ALTER COLUMN send_mode SET NOT NULL;
