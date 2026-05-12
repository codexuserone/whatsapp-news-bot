import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSingle: any = jest.fn();
const mockGetSupabaseClient: any = jest.fn();
const mockPgQuery: any = jest.fn();
const mockPgOn: any = jest.fn();

jest.mock('../src/db/supabase', () => ({
    getSupabaseClient: () => mockGetSupabaseClient()
}));

jest.mock('pg', () => ({
    Pool: jest.fn(() => ({
        query: mockPgQuery,
        on: mockPgOn
    }))
}));

jest.mock('../src/whatsapp/baileys', () => ({
    loadBaileys: jest.fn(async () => ({
        BufferJSON: {
            replacer: (_key: string, value: unknown) => {
                if (Buffer.isBuffer(value)) {
                    return { type: 'Buffer', data: Array.from(value.values()) };
                }
                return value;
            },
            reviver: (_key: string, value: unknown) => {
                if (
                    value &&
                    typeof value === 'object' &&
                    (value as { type?: unknown }).type === 'Buffer' &&
                    Array.isArray((value as { data?: unknown }).data)
                ) {
                    return Buffer.from((value as { data: number[] }).data);
                }
                return value;
            }
        },
        initAuthCreds: jest.fn(() => ({ registered: false }))
    }))
}));

const createSupabase = () => ({
    from: jest.fn(() => ({
        select: jest.fn(() => ({
            eq: jest.fn(() => ({
                single: mockSingle
            }))
        })),
        upsert: jest.fn(() => ({
            select: jest.fn(() => ({
                single: jest.fn(async () => ({ data: null, error: null }))
            }))
        })),
        update: jest.fn(() => ({
            eq: jest.fn(async () => ({ error: null }))
        }))
    }))
});

describe('authStore', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        delete process.env.DB_PROVIDER;
        delete process.env.NEON_DATABASE_URL;
        delete process.env.POSTGRES_URL;
        delete process.env.SUPABASE_DB_URL;
        delete process.env.DATABASE_URL;
        delete process.env.POSTGRES_QUERY_RETRIES;
        delete process.env.POSTGRES_QUERY_RETRY_BASE_MS;
        delete process.env.AUTH_STATE_QUERY_RETRIES;
        delete process.env.AUTH_STATE_QUERY_RETRY_BASE_MS;
        mockPgQuery.mockReset();
        mockPgOn.mockReset();
        mockGetSupabaseClient.mockReturnValue(createSupabase());
    });

    it('loads large key stores without normalizing every stored key at startup', async () => {
        const untouched = new Proxy(
            {},
            {
                ownKeys() {
                    throw new Error('bulk key normalization should not run on startup');
                }
            }
        );
        mockSingle.mockResolvedValue({
            data: {
                creds: { registered: true },
                keys: {
                    session: {
                        requested: { type: 'Buffer', data: [1, 2, 3] },
                        untouched
                    }
                }
            },
            error: null
        });

        const useSupabaseAuthState = require('../src/whatsapp/authStore');
        const store = await useSupabaseAuthState('primary');
        const keys = await store.state.keys.get('session', ['requested']);

        expect(Buffer.isBuffer(keys.requested)).toBe(true);
        expect(Array.from((keys.requested as Buffer).values())).toEqual([1, 2, 3]);
    });

    it('loads WhatsApp keys lazily from Postgres instead of selecting the full key blob at startup', async () => {
        process.env.DB_PROVIDER = 'neon';
        process.env.NEON_DATABASE_URL = 'postgresql://user:pass@example.com/db';
        mockGetSupabaseClient.mockReturnValue(null);
        mockPgQuery.mockImplementation(async (query: string, params: unknown[]) => {
            if (/select creds, lease_owner, lease_expires_at/i.test(query)) {
                expect(query).not.toContain('keys,');
                return {
                    rows: [
                        {
                            creds: { registered: true },
                            lease_owner: null,
                            lease_expires_at: null
                        }
                    ]
                };
            }
            if (/from auth_keys/i.test(query)) {
                expect(params).toEqual(['primary', 'session', ['abc']]);
                return {
                    rows: [
                        {
                            key_id: 'abc',
                            value: { type: 'Buffer', data: [4, 5, 6] }
                        }
                    ]
                };
            }
            throw new Error(`Unexpected query: ${query}`);
        });

        const useSupabaseAuthState = require('../src/whatsapp/authStore');
        const store = await useSupabaseAuthState('primary');

        expect(mockPgQuery).toHaveBeenCalledTimes(1);
        const keys = await store.state.keys.get('session', ['abc']);

        expect(mockPgQuery).toHaveBeenCalledTimes(2);
        expect(Buffer.isBuffer(keys.abc)).toBe(true);
        expect(Array.from((keys.abc as Buffer).values())).toEqual([4, 5, 6]);
    });

    it('uses POSTGRES_URL for auth state when DB_PROVIDER is postgres', async () => {
        process.env.DB_PROVIDER = 'postgres';
        process.env.POSTGRES_URL = 'postgresql://render-postgres/db';
        process.env.DATABASE_URL = 'postgresql://legacy-database/db';
        process.env.NEON_DATABASE_URL = 'postgresql://neon/db';
        mockGetSupabaseClient.mockReturnValue(null);
        mockPgQuery.mockResolvedValue({
            rows: [
                {
                    creds: { registered: true },
                    lease_owner: null,
                    lease_expires_at: null
                }
            ]
        });

        const useSupabaseAuthState = require('../src/whatsapp/authStore');
        await useSupabaseAuthState('primary');
        const { Pool } = require('pg');

        expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ connectionString: 'postgresql://render-postgres/db' }));
    });

    it('stores WhatsApp key updates in per-key Postgres rows', async () => {
        process.env.DB_PROVIDER = 'neon';
        process.env.NEON_DATABASE_URL = 'postgresql://user:pass@example.com/db';
        mockGetSupabaseClient.mockReturnValue(null);
        mockPgQuery.mockImplementation(async (query: string, params: unknown[]) => {
            if (/select creds, lease_owner, lease_expires_at/i.test(query)) {
                return {
                    rows: [
                        {
                            creds: { registered: true },
                            lease_owner: null,
                            lease_expires_at: null
                        }
                    ]
                };
            }
            if (/insert into auth_keys/i.test(query)) {
                expect(params[0]).toBe('primary');
                expect(JSON.parse(String(params[1]))).toEqual([
                    { category: 'session', key_id: 'a', value: { type: 'Buffer', data: [7, 8] } },
                    { category: 'sender-key', key_id: 'b', value: { ok: true } }
                ]);
                expect(query).not.toMatch(/jsonb_set/i);
                return { rows: [] };
            }
            throw new Error(`Unexpected query: ${query}`);
        });

        const useSupabaseAuthState = require('../src/whatsapp/authStore');
        const store = await useSupabaseAuthState('primary');

        await store.state.keys.set({
            session: { a: Buffer.from([7, 8]) },
            'sender-key': { b: { ok: true } }
        });

        expect(mockPgQuery).toHaveBeenCalledTimes(2);
    });

    it('does not retry Neon quota failures when loading auth state', async () => {
        process.env.DB_PROVIDER = 'neon';
        process.env.NEON_DATABASE_URL = 'postgresql://user:pass@example.com/db';
        process.env.AUTH_STATE_QUERY_RETRY_BASE_MS = '0';
        mockGetSupabaseClient.mockReturnValue(null);
        mockPgQuery.mockRejectedValue(new Error('Your project has exceeded the data transfer quota. Upgrade your plan to increase limits.'));

        const useSupabaseAuthState = require('../src/whatsapp/authStore');

        await expect(useSupabaseAuthState('primary')).rejects.toThrow(/Auth state temporarily unavailable/);
        expect(mockPgQuery).toHaveBeenCalledTimes(1);
    });

    it('retries transient auth state Postgres connection refusals', async () => {
        process.env.DB_PROVIDER = 'postgres';
        process.env.POSTGRES_URL = 'postgresql://render-postgres/db';
        process.env.AUTH_STATE_QUERY_RETRIES = '2';
        process.env.AUTH_STATE_QUERY_RETRY_BASE_MS = '0';
        mockGetSupabaseClient.mockReturnValue(null);
        mockPgQuery
            .mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED 10.28.136.81:5432'), { code: 'ECONNREFUSED' }))
            .mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED 10.28.136.81:5432'), { code: 'ECONNREFUSED' }))
            .mockResolvedValueOnce({
                rows: [
                    {
                        creds: { registered: true },
                        lease_owner: null,
                        lease_expires_at: null
                    }
                ]
            });

        const useSupabaseAuthState = require('../src/whatsapp/authStore');
        const store = await useSupabaseAuthState('primary');

        expect(store.state.creds).toEqual({ registered: true });
        expect(mockPgQuery).toHaveBeenCalledTimes(3);
    });
});
