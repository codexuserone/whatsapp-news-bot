import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSingle: any = jest.fn();
const mockGetSupabaseClient: any = jest.fn();

jest.mock('../src/db/supabase', () => ({
    getSupabaseClient: () => mockGetSupabaseClient()
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
});
