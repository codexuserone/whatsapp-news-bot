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
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false
        }
      }
    ]);
  });

  it('does not fall back to NEXT_PUBLIC keys in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.SUPABASE_URL = 'https://example.supabase.co';
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
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false
        }
      }
    ]);
  });
});
