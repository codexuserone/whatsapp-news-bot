ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS media_source TEXT NOT NULL DEFAULT 'auto';

UPDATE templates
SET media_source = 'auto'
WHERE media_source IS NULL
   OR media_source NOT IN ('auto', 'image', 'video');

ALTER TABLE templates
  DROP CONSTRAINT IF EXISTS templates_media_source_check;

ALTER TABLE templates
  ADD CONSTRAINT templates_media_source_check
  CHECK (media_source IN ('auto', 'image', 'video'));
