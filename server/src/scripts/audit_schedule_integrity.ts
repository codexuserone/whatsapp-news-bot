import path from 'path';
import dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

type ScheduleRow = {
  id: string;
  name: string | null;
  feed_id: string | null;
  target_ids: string[] | null;
  delivery_mode: string | null;
  timezone: string | null;
  batch_times: string[] | null;
  state: string | null;
  active: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_queued_at: string | null;
  updated_at: string | null;
};

type TargetRow = {
  id: string;
  active: boolean;
};

const toMinuteOfDay = (timezone: string, date: Date) => {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  });
  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || '0');
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return Number.NaN;
  return hour * 60 + minute;
};

const parseBatchMinutes = (times: string[] | null | undefined) => {
  const out: number[] = [];
  for (const value of Array.isArray(times) ? times : []) {
    const match = String(value || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!match) continue;
    out.push(Number(match[1]) * 60 + Number(match[2]));
  }
  return out;
};

const isWithinWindow = (sentAt: Date, timezone: string, batchMinutes: number[], graceMinutes: number) => {
  if (!batchMinutes.length) return true;
  const localMinute = toMinuteOfDay(timezone, sentAt);
  if (!Number.isFinite(localMinute)) return false;
  return batchMinutes.some((targetMinute) => {
    const directDiff = Math.abs(localMinute - targetMinute);
    const wrappedDiff = Math.min(directDiff, 1440 - directDiff);
    return wrappedDiff <= graceMinutes;
  });
};

const main = async () => {
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const lookbackHoursRaw = Number(process.env.AUDIT_LOOKBACK_HOURS || 24);
  const lookbackHours = Number.isFinite(lookbackHoursRaw) ? Math.max(1, Math.floor(lookbackHoursRaw)) : 24;
  const graceRaw = Number(process.env.BATCH_WINDOW_GRACE_MINUTES || 8);
  const graceMinutes = Number.isFinite(graceRaw) ? Math.min(Math.max(Math.floor(graceRaw), 1), 30) : 8;
  const strict = String(process.env.AUDIT_STRICT || '').toLowerCase() === 'true';

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  try {
    const schedulesRes = await client.query<ScheduleRow>(`
      select
        id,
        name,
        feed_id,
        target_ids,
        delivery_mode,
        timezone,
        batch_times,
        state,
        active,
        next_run_at,
        last_run_at,
        last_queued_at,
        updated_at
      from schedules
      where feed_id is not null
      order by created_at asc
    `);

    const schedules = schedulesRes.rows;
    const report: Array<Record<string, unknown>> = [];
    const alerts: string[] = [];

    for (const schedule of schedules) {
      const targetIds = Array.isArray(schedule.target_ids) ? schedule.target_ids : [];

      const targetsRes = targetIds.length
        ? await client.query<TargetRow>('select id, active from targets where id = any($1::uuid[])', [targetIds])
        : { rows: [] as TargetRow[] };
      const activeTargetIds = targetsRes.rows.filter((row) => row.active).map((row) => row.id);

      const feedCountRes = await client.query<{ count: number }>(
        `
          select count(*)::int as count
          from feed_items
          where feed_id = $1
            and created_at >= now() - ($2::text || ' hours')::interval
        `,
        [schedule.feed_id, String(lookbackHours)]
      );
      const feedItems = Number(feedCountRes.rows[0]?.count || 0);

      const logCountsRes = await client.query<{
        total: number;
        sent: number;
        failed: number;
        pending: number;
        processing: number;
      }>(
        `
          select
            count(*)::int as total,
            count(*) filter (where status in ('sent','delivered','read','played'))::int as sent,
            count(*) filter (where status = 'failed')::int as failed,
            count(*) filter (where status = 'pending')::int as pending,
            count(*) filter (where status = 'processing')::int as processing
          from message_logs
          where schedule_id = $1
            and created_at >= now() - ($2::text || ' hours')::interval
        `,
        [schedule.id, String(lookbackHours)]
      );
      const counts = logCountsRes.rows[0] || { total: 0, sent: 0, failed: 0, pending: 0, processing: 0 };

      let missingPairs = 0;
      if (activeTargetIds.length) {
        const missingRes = await client.query<{ missing_pairs: number }>(
          `
            with recent_items as (
              select id
              from feed_items
              where feed_id = $1
                and created_at >= now() - ($2::text || ' hours')::interval
            ),
            required as (
              select i.id as feed_item_id, t.target_id
              from recent_items i
              cross join unnest($3::uuid[]) as t(target_id)
            )
            select count(*)::int as missing_pairs
            from required r
            left join message_logs ml
              on ml.schedule_id = $4
             and ml.feed_item_id = r.feed_item_id
             and ml.target_id = r.target_id
            where ml.id is null
          `,
          [schedule.feed_id, String(lookbackHours), activeTargetIds, schedule.id]
        );
        missingPairs = Number(missingRes.rows[0]?.missing_pairs || 0);
      }

      let offWindowCount = 0;
      const offWindowSamples: Array<{ logId: string; sentAt: string; localMinute: number }> = [];
      const deliveryMode = schedule.delivery_mode === 'batch' ? 'batched' : schedule.delivery_mode || 'immediate';
      if (deliveryMode === 'batched') {
        const lookbackStartMs = Date.now() - lookbackHours * 60 * 60 * 1000;
        const sentRowsRes = await client.query<{ id: string; sent_at: string }>(
          `
            select id, sent_at
            from message_logs
            where schedule_id = $1
              and status in ('sent','delivered','read','played')
              and sent_at >= now() - ($2::text || ' hours')::interval
            order by sent_at desc
          `,
          [schedule.id, String(lookbackHours)]
        );
        const batchMinutes = parseBatchMinutes(schedule.batch_times);
        const timezone = String(schedule.timezone || 'UTC');
        for (const row of sentRowsRes.rows) {
          const sentAt = new Date(row.sent_at);
          if (!Number.isFinite(sentAt.getTime()) || sentAt.getTime() < lookbackStartMs) {
            continue;
          }
          const ok = isWithinWindow(sentAt, timezone, batchMinutes, graceMinutes);
          if (ok) continue;
          offWindowCount += 1;
          if (offWindowSamples.length < 8) {
            offWindowSamples.push({
              logId: row.id,
              sentAt: row.sent_at,
              localMinute: toMinuteOfDay(timezone, sentAt)
            });
          }
        }
      }

      if (missingPairs > 0) {
        alerts.push(`missing_pairs schedule=${schedule.id} count=${missingPairs}`);
      }
      if (offWindowCount > 0) {
        alerts.push(`off_window_sent schedule=${schedule.id} count=${offWindowCount}`);
      }
      if (Number(counts.failed || 0) > 0) {
        alerts.push(`failed_logs schedule=${schedule.id} count=${counts.failed}`);
      }

      report.push({
        scheduleId: schedule.id,
        name: schedule.name,
        state: schedule.state,
        active: schedule.active,
        deliveryMode,
        timezone: schedule.timezone,
        batchTimes: schedule.batch_times,
        nextRunAt: schedule.next_run_at,
        lastRunAt: schedule.last_run_at,
        lastQueuedAt: schedule.last_queued_at,
        targetCount: targetIds.length,
        activeTargetCount: activeTargetIds.length,
        feedItemsLookback: feedItems,
        logCountsLookback: counts,
        missingPairsLookback: missingPairs,
        offWindowSentLookback: offWindowCount,
        offWindowSamples
      });
    }

    const output = {
      generatedAt: new Date().toISOString(),
      lookbackHours,
      batchWindowGraceMinutes: graceMinutes,
      scheduleCount: report.length,
      alerts,
      schedules: report
    };

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (strict && alerts.length > 0) {
      process.exitCode = 2;
    }
  } finally {
    await client.end();
  }
};

main().catch((error) => {
  process.stderr.write(`${String((error as { message?: unknown })?.message || error)}\n`);
  process.exit(1);
});

export {};
