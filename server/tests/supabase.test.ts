import { beforeEach, afterAll, describe, expect, it, jest } from '@jest/globals';

const createClientMock = jest.fn(() => ({ from: jest.fn() }));

jest.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock
}));

describe('server Supabase client configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('uses the service role key and disables browser auth behaviors', () => {
    process.env.NODE_ENV = 'production';
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

    const { getSupabaseClient } = require('../src/db/supabase');
    getSupabaseClient();

    expect(createClientMock.mock.calls[0]).toEqual([
      'https://example.supabase.co',
      'service-role-key',
      expect.objectContaining({
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false
        },
        global: expect.objectContaining({
          fetch: expect.any(Function)
        })
      })
    ]);
  });

  it('does not fall back to NEXT_PUBLIC keys in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.DB_PROVIDER = 'supabase';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-anon-key';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://public.supabase.co';

    const { getSupabaseClient } = require('../src/db/supabase');
    const client = getSupabaseClient();

    expect(client).toBeNull();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('allows anon fallback only outside production', () => {
    process.env.NODE_ENV = 'development';
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';

    const { getSupabaseClient } = require('../src/db/supabase');
    getSupabaseClient();

    expect(createClientMock.mock.calls[0]).toEqual([
      'https://example.supabase.co',
      'anon-key',
      expect.objectContaining({
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false
        },
        global: expect.objectContaining({
          fetch: expect.any(Function)
        })
      })
    ]);
  });

  it('preserves Postgres failure detail in health state', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DB_PROVIDER = 'postgres';
    process.env.DATABASE_URL = 'postgresql://example.com/test';

    jest.doMock('../src/db/postgresCompat', () => ({
      createPostgresCompatClient: jest.fn(),
      resolvePostgresConnectionString: jest.fn(() => 'postgresql://example.com/test'),
      testPostgresConnection: jest.fn(async () => false),
      getPostgresHealthState: jest.fn(() => ({
        circuitOpen: true,
        retryAfterMs: 45_000,
        lastFailureAt: '2026-05-10T03:00:00.000Z',
        lastFailureMessage: 'Your project has exceeded the data transfer quota. Upgrade your plan to increase limits.'
      }))
    }));

    const { getSupabaseHealthState, testConnection } = require('../src/db/supabase');

    await expect(testConnection()).resolves.toBe(false);

    expect(getSupabaseHealthState().lastFailureMessage).toContain('data transfer quota');
  });
});
