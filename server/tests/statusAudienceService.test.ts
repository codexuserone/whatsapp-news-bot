import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type Row = Record<string, any>;
type TableName = 'status_recipients' | 'message_logs' | 'targets';

const buildSupabaseMock = (seed?: Partial<Record<TableName, Row[]>>) => {
    const tables: Record<TableName, Row[]> = {
        status_recipients: [...(seed?.status_recipients || [])].map((row) => ({ ...row })),
        message_logs: [...(seed?.message_logs || [])].map((row) => ({ ...row })),
        targets: [...(seed?.targets || [])].map((row) => ({ ...row }))
    };

    class QueryBuilder {
        private readonly table: TableName;
        private readonly filters: Array<(row: Row) => boolean> = [];
        private readonly orders: Array<{ field: string; ascending: boolean }> = [];
        private limitValue: number | null = null;
        private selectFields: string[] | null = null;
        private countExact = false;
        private headOnly = false;
        private operation: 'select' | 'delete' = 'select';

        constructor(table: TableName) {
            this.table = table;
        }

        select(fields?: string, options?: { count?: string; head?: boolean }) {
            if (fields && fields !== '*') {
                this.selectFields = fields.split(',').map((value) => value.trim()).filter(Boolean);
            }
            this.countExact = options?.count === 'exact';
            this.headOnly = options?.head === true;
            return this;
        }

        delete() {
            this.operation = 'delete';
            return this;
        }

        eq(field: string, value: any) {
            this.filters.push((row) => row[field] === value);
            return this;
        }

        in(field: string, values: any[]) {
            this.filters.push((row) => values.includes(row[field]));
            return this;
        }

        not(field: string, operator: string, value: any) {
            if (operator === 'is' && value === null) {
                this.filters.push((row) => row[field] !== null && row[field] !== undefined);
            }
            return this;
        }

        gte(field: string, value: any) {
            this.filters.push((row) => row[field] >= value);
            return this;
        }

        lt(field: string, value: any) {
            this.filters.push((row) => row[field] < value);
            return this;
        }

        order(field: string, options?: { ascending?: boolean }) {
            this.orders.push({ field, ascending: options?.ascending !== false });
            return this;
        }

        limit(value: number) {
            this.limitValue = value;
            return this;
        }

        async then(resolve: (value: any) => any, reject?: (reason: any) => any) {
            try {
                return resolve(await this.execute());
            } catch (error) {
                return reject ? reject(error) : Promise.reject(error);
            }
        }

        private async execute() {
            const tableRows = tables[this.table];
            const matchingRows = tableRows.filter((row) => this.filters.every((filter) => filter(row)));

            if (this.operation === 'delete') {
                tables[this.table] = tableRows.filter((row) => !this.filters.every((filter) => filter(row)));
                return { data: matchingRows, error: null };
            }

            const orderedRows = [...matchingRows];
            for (const order of this.orders.reverse()) {
                orderedRows.sort((left, right) => {
                    const a = left[order.field];
                    const b = right[order.field];
                    if (a === b) return 0;
                    if (a == null) return order.ascending ? 1 : -1;
                    if (b == null) return order.ascending ? -1 : 1;
                    return order.ascending ? (a < b ? -1 : 1) : (a > b ? -1 : 1);
                });
            }

            const limitedRows = this.limitValue == null ? orderedRows : orderedRows.slice(0, this.limitValue);
            if (this.headOnly) {
                return {
                    data: null,
                    error: null,
                    count: this.countExact ? matchingRows.length : null
                };
            }

            const data = this.selectFields
                ? limitedRows.map((row) => {
                    const selected: Row = {};
                    for (const field of this.selectFields || []) {
                        selected[field] = row[field];
                    }
                    return selected;
                })
                : limitedRows.map((row) => ({ ...row }));

            return { data, error: null, count: this.countExact ? matchingRows.length : null };
        }
    }

    const supabase = {
        from(table: TableName) {
            return {
                select: (fields?: string, options?: { count?: string; head?: boolean }) =>
                    new QueryBuilder(table).select(fields, options),
                delete: () => new QueryBuilder(table).delete(),
                upsert: async (rows: Row[], options?: { onConflict?: string }) => {
                    const keys = String(options?.onConflict || '')
                        .split(',')
                        .map((value) => value.trim())
                        .filter(Boolean);
                    for (const row of rows) {
                        const existingIndex = tables[table].findIndex((candidate) =>
                            keys.every((key) => candidate[key] === row[key])
                        );
                        if (existingIndex >= 0) {
                            tables[table][existingIndex] = {
                                ...tables[table][existingIndex],
                                ...row
                            };
                        } else {
                            tables[table].push({ ...row });
                        }
                    }
                    return { data: rows, error: null };
                }
            };
        }
    };

    return { supabase, tables };
};

const getSupabaseClientMock: any = jest.fn();
const loggerWarnMock: any = jest.fn();

jest.mock('../src/db/supabase', () => ({
    getSupabaseClient: (...args: any[]) => getSupabaseClientMock(...args)
}));

jest.mock('../src/utils/logger', () => ({
    warn: (...args: any[]) => loggerWarnMock(...args),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('node-cron', () => ({
    schedule: jest.fn(() => ({ stop: jest.fn() }))
}));

const {
    ensureFreshStatusRecipients,
    refreshStatusRecipients
} = require('../src/services/statusAudienceService');

describe('statusAudienceService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('does not preserve a group-metadata-only stored snapshot when a connected client resolves only self', async () => {
        const refreshedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
        const storedRecipients = Array.from({ length: 40 }, (_value, index) => `${1000000000 + index}@s.whatsapp.net`);
        const { supabase, tables } = buildSupabaseMock({
            status_recipients: storedRecipients.map((recipient) => ({
                session_id: 'primary',
                recipient_jid: recipient,
                refreshed_at: refreshedAt,
                sources: {
                    contactsCache: 0,
                    storeContacts: 0,
                    storeChats: 0,
                    groupMetadata: 39,
                    env: 0,
                    me: 1,
                    recentSuccessfulDirectRecipients: 0
                },
                warnings: []
            }))
        });
        getSupabaseClientMock.mockReturnValue(supabase);

        const result = await refreshStatusRecipients(
            {
                getStatus: () => ({ status: 'connected' }),
                getStatusParticipants: () => ['16465527019@s.whatsapp.net'],
                getStatusAudience: () => ({
                    participantCount: 1,
                    sample: ['16465527019@s.whatsapp.net'],
                    selfJid: '16465527019@s.whatsapp.net',
                    sources: {
                        contactsCache: 0,
                        storeContacts: 0,
                        storeChats: 0,
                        groupMetadata: 0,
                        env: 0,
                        me: 1
                    },
                    warnings: []
                })
            },
            { sampleSize: 10 }
        );

        expect(result.participantCount).toBe(0);
        expect(result.recipients).not.toContain('16465527019@s.whatsapp.net');
        expect(result.recipients).not.toContain('1000000000@s.whatsapp.net');
        expect(result.warnings.some((warning: string) => warning.includes('Preserved the previous status audience snapshot'))).toBe(false);
        expect(tables.status_recipients).toHaveLength(0);
    });

    it('does not preserve a group-heavy lid snapshot with only tiny trusted signal', async () => {
        const refreshedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
        const storedRecipients = Array.from({ length: 50 }, (_value, index) => `${1000000000 + index}@lid`);
        const { supabase, tables } = buildSupabaseMock({
            status_recipients: storedRecipients.map((recipient) => ({
                session_id: 'primary',
                recipient_jid: recipient,
                refreshed_at: refreshedAt,
                sources: {
                    contactsCache: 2,
                    storeContacts: 0,
                    storeChats: 0,
                    groupMetadata: 48,
                    env: 0,
                    me: 1,
                    recentSuccessfulDirectRecipients: 0
                },
                warnings: []
            }))
        });
        getSupabaseClientMock.mockReturnValue(supabase);

        const result = await refreshStatusRecipients(
            {
                getStatus: () => ({ status: 'connected' }),
                getStatusParticipants: () => ['16465527019@s.whatsapp.net'],
                getStatusAudience: () => ({
                    participantCount: 1,
                    sample: ['16465527019@s.whatsapp.net'],
                    selfJid: '16465527019@s.whatsapp.net',
                    sources: {
                        contactsCache: 1,
                        storeContacts: 0,
                        storeChats: 0,
                        groupMetadata: 0,
                        env: 0,
                        me: 1
                    },
                    warnings: []
                })
            },
            { sampleSize: 10 }
        );

        expect(result.participantCount).toBe(0);
        expect(result.recipients).toEqual([]);
        expect(tables.status_recipients).toHaveLength(0);
    });

    it('does not preserve an old snapshot when the current audience has real warm sources', async () => {
        const refreshedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
        const { supabase } = buildSupabaseMock({
            status_recipients: Array.from({ length: 30 }, (_value, index) => ({
                session_id: 'primary',
                recipient_jid: `${1200000000 + index}@s.whatsapp.net`,
                refreshed_at: refreshedAt,
                sources: {
                    contactsCache: 0,
                    storeContacts: 0,
                    storeChats: 0,
                    groupMetadata: 29,
                    env: 0,
                    me: 1,
                    recentSuccessfulDirectRecipients: 0
                },
                warnings: []
            }))
        });
        getSupabaseClientMock.mockReturnValue(supabase);

        const result = await refreshStatusRecipients(
            {
                getStatus: () => ({ status: 'connected' }),
                getStatusParticipants: () => ['16465527019@s.whatsapp.net', '16465527020@s.whatsapp.net'],
                getStatusAudience: () => ({
                    participantCount: 2,
                    sample: ['16465527019@s.whatsapp.net', '16465527020@s.whatsapp.net'],
                    sources: {
                        contactsCache: 1,
                        storeContacts: 1,
                        storeChats: 0,
                        groupMetadata: 0,
                        env: 0,
                        me: 0
                    },
                    warnings: []
                })
            },
            { sampleSize: 10 }
        );

        expect(result.participantCount).toBe(2);
        expect(result.recipients).toEqual(['16465527019@s.whatsapp.net', '16465527020@s.whatsapp.net']);
        expect(result.warnings.some((warning: string) => warning.includes('Preserved the previous status audience snapshot'))).toBe(false);
    });

    it('uses active private targets as explicit status audience recipients', async () => {
        const { supabase } = buildSupabaseMock({
            targets: [
                {
                    id: 'target-1',
                    type: 'individual',
                    active: true,
                    phone_number: '16465527019'
                },
                {
                    id: 'target-2',
                    type: 'group',
                    active: true,
                    phone_number: '120363000000000000@g.us'
                }
            ]
        });
        getSupabaseClientMock.mockReturnValue(supabase);

        const result = await refreshStatusRecipients(
            {
                getStatus: () => ({ status: 'connected' }),
                getStatusParticipants: () => [],
                getStatusAudience: () => ({
                    participantCount: 0,
                    sample: [],
                    sources: {
                        contactsCache: 0,
                        storeContacts: 0,
                        storeChats: 0,
                        groupMetadata: 0,
                        env: 0,
                        me: 0
                    },
                    warnings: []
                })
            },
            { sampleSize: 10 }
        );

        expect(result.recipients).toEqual(['16465527019@s.whatsapp.net']);
        expect(result.sources.activeIndividualTargets).toBe(1);
    });

    it('reuses a fresh stored snapshot without refreshing again', async () => {
        const refreshedAt = new Date().toISOString();
        const { supabase } = buildSupabaseMock({
            status_recipients: [
                {
                    session_id: 'primary',
                    recipient_jid: '16465527019@s.whatsapp.net',
                    refreshed_at: refreshedAt,
                    sources: {
                        contactsCache: 0,
                        storeContacts: 0,
                        storeChats: 0,
                        groupMetadata: 0,
                        env: 0,
                        me: 0,
                        activeIndividualTargets: 1,
                        recentSuccessfulDirectRecipients: 0
                    },
                    warnings: []
                }
            ]
        });
        getSupabaseClientMock.mockReturnValue(supabase);

        const result = await ensureFreshStatusRecipients(
            {
                getStatus: () => ({ status: 'connected' }),
                getStatusParticipants: jest.fn(() => {
                    throw new Error('should not refresh');
                })
            },
            { maxAgeMinutes: 10, sampleSize: 10 }
        );

        expect(result.participantCount).toBe(1);
        expect(result.recipients).toEqual(['16465527019@s.whatsapp.net']);
    });
});
