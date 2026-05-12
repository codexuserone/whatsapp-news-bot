import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getSupabaseClientMock: any = jest.fn();

jest.mock('../src/db/supabase', () => ({
  getSupabaseClient: () => getSupabaseClientMock()
}));

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const { syncTargetsFromWhatsApp } = require('../src/services/targetSyncService');

const buildSupabaseMock = (seed: Array<Record<string, any>>) => {
  const rows = seed.map((row) => ({ ...row }));

  class SelectBuilder {
    private filters: Array<(row: Record<string, any>) => boolean> = [];

    eq(field: string, value: any) {
      this.filters.push((row) => row[field] === value);
      return this;
    }

    order() {
      return this;
    }

    then(resolve: (value: any) => any) {
      return resolve({
        data: rows.filter((row) => this.filters.every((filter) => filter(row))).map((row) => ({ ...row })),
        error: null
      });
    }
  }

  class UpdateBuilder {
    private filters: Array<(row: Record<string, any>) => boolean> = [];

    constructor(private readonly patch: Record<string, any>) {}

    eq(field: string, value: any) {
      this.filters.push((row) => row[field] === value);
      return this;
    }

    then(resolve: (value: any) => any) {
      for (const row of rows) {
        if (this.filters.every((filter) => filter(row))) {
          Object.assign(row, this.patch);
        }
      }
      return resolve({ data: null, error: null });
    }
  }

  return {
    rows,
    supabase: {
      from: () => ({
        select: () => new SelectBuilder(),
        insert: async (row: Record<string, any>) => {
          rows.push({ id: `inserted-${rows.length + 1}`, ...row });
          return { data: row, error: null };
        },
        update: (patch: Record<string, any>) => new UpdateBuilder(patch)
      })
    }
  };
};

describe('targetSyncService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps saved channels active when WhatsApp only returns some channels', async () => {
    const { rows, supabase } = buildSupabaseMock([
      {
        id: 'channel-main',
        type: 'channel',
        active: true,
        name: 'Main Channel',
        phone_number: '120363400000000000@newsletter',
        created_at: '2026-05-10T00:00:00.000Z'
      },
      {
        id: 'channel-test',
        type: 'channel',
        active: true,
        name: 'Test Channel',
        phone_number: '120363406955649221@newsletter',
        created_at: '2026-05-10T00:00:01.000Z'
      }
    ]);
    getSupabaseClientMock.mockReturnValue(supabase);

    await syncTargetsFromWhatsApp(
      {
        getStatus: () => ({ status: 'connected' }),
        getGroups: async () => [],
        getChannelsWithDiagnostics: async () => ({
          channels: [
            {
              jid: '120363406955649221@newsletter',
              name: 'Test Channel',
              subscribers: 10
            }
          ],
          diagnostics: {
            sourceCounts: { api: 0, cache: 0, metadata: 1, store: 0 }
          }
        })
      },
      { includeStatus: true, strict: true }
    );

    expect(rows.find((row) => row.id === 'channel-main')?.active).toBe(true);
    expect(rows.find((row) => row.id === 'channel-test')?.active).toBe(true);
  });
});
