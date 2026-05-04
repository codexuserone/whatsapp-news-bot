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
      'SELECT * FROM "feed_items" WHERE "feed_id" = $1 AND ("created_at" > $2 OR ("created_at" = $3 AND "id" > $4)) ORDER BY "created_at" ASC, "id" ASC LIMIT $5',
      ['feed-1', '2026-04-27T10:00:00.000Z', '2026-04-27T10:00:00.000Z', 'feed-item-1', 200]
    );
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
