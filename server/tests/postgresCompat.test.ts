import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const fakeQuery: any = jest.fn();
const fakePool = {
  query: fakeQuery,
  on: jest.fn()
};

jest.mock('pg', () => ({
  Pool: jest.fn(() => fakePool)
}));

describe('postgresCompat query builder', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      DATABASE_URL: 'postgresql://example.com/test',
      DB_PROVIDER: 'postgres'
    };
    fakeQuery.mockResolvedValue({ rows: [] });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('keeps placeholder numbers distinct across chained filters', async () => {
    const { createPostgresCompatClient } = require('../src/db/postgresCompat');
    const db = createPostgresCompatClient();

    await db
      .from('message_logs')
      .delete()
      .eq('schedule_id', 'schedule-1')
      .in('status', ['pending', 'processing', 'failed']);

    expect(fakeQuery).toHaveBeenCalledWith(
      'DELETE FROM "message_logs" WHERE "schedule_id" = $1 AND "status" IN ($2, $3, $4)',
      ['schedule-1', 'pending', 'processing', 'failed']
    );
  });

  it('keeps nested or placeholders aligned with their own values', async () => {
    const { createPostgresCompatClient } = require('../src/db/postgresCompat');
    const db = createPostgresCompatClient();

    await db
      .from('feed_items')
      .select('id, created_at')
      .eq('feed_id', 'feed-1')
      .or(
        'created_at.gt.2026-04-27T10:00:00.000Z,and(created_at.eq.2026-04-27T10:00:00.000Z,id.gt.feed-item-1)'
      )
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(200);

    expect(fakeQuery).toHaveBeenCalledWith(
      'SELECT "id", "created_at" FROM "feed_items" WHERE "feed_id" = $1 AND ("created_at" > $2 OR ("created_at" = $3 AND "id" > $4)) ORDER BY "created_at" ASC, "id" ASC LIMIT $5',
      ['feed-1', '2026-04-27T10:00:00.000Z', '2026-04-27T10:00:00.000Z', 'feed-item-1', 200]
    );
  });

  it('selects only requested base columns and relation join keys', async () => {
    fakeQuery
      .mockResolvedValueOnce({ rows: [{ id: 'item-1', feed_id: 'feed-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'feed-1', name: 'Main Feed' }] });

    const { createPostgresCompatClient } = require('../src/db/postgresCompat');
    const db = createPostgresCompatClient();

    const result = await db
      .from('feed_items')
      .select('id,feed:feeds(id,name)')
      .limit(1);

    expect(fakeQuery).toHaveBeenNthCalledWith(
      1,
      'SELECT "id", "feed_id" FROM "feed_items" LIMIT $1',
      [1]
    );
    expect(fakeQuery).toHaveBeenNthCalledWith(
      2,
      'SELECT "id", "name" FROM "feeds" WHERE "id" IN ($1)',
      ['feed-1']
    );
    expect(result.data).toEqual([{ id: 'item-1', feed: { id: 'feed-1', name: 'Main Feed' } }]);
  });

  it('opens a short circuit after Neon quota errors', async () => {
    fakeQuery.mockRejectedValueOnce(
      Object.assign(new Error('Your project has exceeded the data transfer quota. Upgrade your plan to increase limits.'), {
        code: 'XX000'
      })
    );

    const { createPostgresCompatClient } = require('../src/db/postgresCompat');
    const db = createPostgresCompatClient();

    const first = await db.from('feeds').select('id');
    const second = await db.from('feeds').select('id');

    expect(first.error?.status).toBe(503);
    expect(second.error?.status).toBe(503);
    expect(String(second.error?.message || '')).toContain('Postgres temporarily unavailable');
    expect(fakeQuery).toHaveBeenCalledTimes(1);
  });

  it('serializes template sequence steps as JSON instead of a Postgres array', async () => {
    const { createPostgresCompatClient } = require('../src/db/postgresCompat');
    const db = createPostgresCompatClient();

    await db
      .from('templates')
      .insert({
        name: 'Status sequence',
        content: '{{title}}',
        sequence_steps: [{ label: 'Image', send_mode: 'media_only' }],
        send_mode: 'text_preview'
      })
      .select();

    expect(fakeQuery).toHaveBeenCalledWith(
      'INSERT INTO "templates" ("name", "content", "sequence_steps", "send_mode") VALUES ($1, $2, $3, $4) RETURNING *',
      [
        'Status sequence',
        '{{title}}',
        JSON.stringify([{ label: 'Image', send_mode: 'media_only' }]),
        'text_preview'
      ]
    );
  });
});
