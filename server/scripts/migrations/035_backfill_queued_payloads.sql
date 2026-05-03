-- Backfill queued feed rows that were created before queue payload previews were stored.
WITH queue_payloads AS (
  SELECT
    ml.id,
    NULLIF(BTRIM(
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(
              REPLACE(
                REPLACE(
                  REPLACE(
                    REPLACE(t.content, '{{title}}', COALESCE(fi.title, '')),
                    '{{ title }}', COALESCE(fi.title, '')
                  ),
                  '{{description}}', COALESCE(fi.description, '')
                ),
                '{{ description }}', COALESCE(fi.description, '')
              ),
              '{{content}}', COALESCE(fi.content, '')
            ),
            '{{ content }}', COALESCE(fi.content, '')
          ),
          '{{link}}', COALESCE(fi.link, '')
        ),
        '{{ link }}', COALESCE(fi.link, '')
      )
    ), '') AS rendered_content,
    CASE
      WHEN COALESCE(t.send_images, true) IS FALSE THEN NULL
      WHEN COALESCE(t.send_mode, 'auto_media') IN ('text_only', 'text_preview', 'link_preview') THEN NULL
      WHEN fi.media_url IS NOT NULL AND COALESCE(fi.media_kind, '') IN ('image', 'video', 'audio', 'document') THEN fi.media_url
      ELSE COALESCE(fi.image_url, fi.media_url)
    END AS preview_media_url,
    CASE
      WHEN COALESCE(t.send_images, true) IS FALSE THEN NULL
      WHEN COALESCE(t.send_mode, 'auto_media') IN ('text_only', 'text_preview', 'link_preview') THEN NULL
      WHEN fi.media_url IS NOT NULL AND COALESCE(fi.media_kind, '') IN ('image', 'video', 'audio', 'document') THEN fi.media_kind
      WHEN COALESCE(fi.image_url, fi.media_url) IS NOT NULL THEN 'image'
      ELSE NULL
    END AS preview_media_type,
    CASE
      WHEN COALESCE(t.send_images, true) IS FALSE THEN false
      WHEN COALESCE(t.send_mode, 'auto_media') IN ('media_only', 'image_only') THEN false
      WHEN COALESCE(t.send_mode, 'auto_media') IN ('text_only', 'text_preview', 'link_preview') THEN false
      ELSE true
    END AS preview_include_caption,
    COALESCE(t.send_mode, '') = 'text_only' AS preview_disable_link_preview
  FROM message_logs ml
  JOIN templates t ON t.id = ml.template_id
  JOIN feed_items fi ON fi.id = ml.feed_item_id
  WHERE ml.schedule_id IS NOT NULL
    AND ml.status IN ('pending', 'awaiting_approval')
)
UPDATE message_logs ml
SET
  message_content = COALESCE(NULLIF(BTRIM(ml.message_content), ''), queue_payloads.rendered_content),
  media_url = COALESCE(NULLIF(BTRIM(ml.media_url), ''), queue_payloads.preview_media_url),
  media_type = COALESCE(NULLIF(BTRIM(ml.media_type), ''), queue_payloads.preview_media_type),
  include_caption = COALESCE(ml.include_caption, queue_payloads.preview_include_caption),
  disable_link_preview = COALESCE(ml.disable_link_preview, queue_payloads.preview_disable_link_preview),
  updated_at = NOW()
FROM queue_payloads
WHERE ml.id = queue_payloads.id
  AND (
    NULLIF(BTRIM(ml.message_content), '') IS NULL
    OR NULLIF(BTRIM(ml.media_url), '') IS NULL
    OR NULLIF(BTRIM(ml.media_type), '') IS NULL
    OR ml.include_caption IS NULL
    OR ml.disable_link_preview IS NULL
  );
