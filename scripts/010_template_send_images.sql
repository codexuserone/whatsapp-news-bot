-- Add per-template image attachment setting
ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS send_images BOOLEAN DEFAULT true;

UPDATE templates
SET send_images = true
WHERE send_images IS NULL;
