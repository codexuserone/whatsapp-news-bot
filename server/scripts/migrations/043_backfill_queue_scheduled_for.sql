-- Migration 043: backfill scheduled ordering for existing queued automation rows.

WITH ordered_queue AS (
  SELECT
    ml.id,
    (
      COALESCE(fi.pub_date, ml.created_at)
      + (GREATEST(COALESCE(ml.sequence_step_index, 0), 0) * INTERVAL '45 seconds')
      + (
        (ROW_NUMBER() OVER (
          PARTITION BY ml.schedule_id, ml.target_id
          ORDER BY
            COALESCE(fi.pub_date, ml.created_at) ASC,
            fi.created_at ASC NULLS LAST,
            GREATEST(COALESCE(ml.sequence_step_index, 0), 0) ASC,
            ml.created_at ASC,
            ml.id ASC
        ) - 1) * INTERVAL '1 second'
      )
    ) AS next_scheduled_for
  FROM message_logs ml
  LEFT JOIN feed_items fi ON fi.id = ml.feed_item_id
  WHERE ml.schedule_id IS NOT NULL
    AND ml.feed_item_id IS NOT NULL
    AND ml.scheduled_for IS NULL
    AND ml.status IN ('awaiting_approval', 'pending')
)
UPDATE message_logs ml
SET scheduled_for = ordered_queue.next_scheduled_for
FROM ordered_queue
WHERE ml.id = ordered_queue.id;
