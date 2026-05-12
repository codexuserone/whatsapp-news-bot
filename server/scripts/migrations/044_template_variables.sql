-- Migration 044: store extracted template variables.

ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS variables TEXT[] NOT NULL DEFAULT '{}';

UPDATE templates
SET variables = '{}'
WHERE variables IS NULL;
