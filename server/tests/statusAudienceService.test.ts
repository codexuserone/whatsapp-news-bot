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
const getSettingsMock: any = jest.fn();

jest.mock('../src/db/supabase', () => ({
    getSupabaseClient: (...args: any[]) => getSupabaseClientMock(...args)
}));

jest.mock('../src/utils/logger', () => ({
    warn: (...args: any[]) => loggerWarnMock(...args),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../src/services/settingsService', () => ({
    getSettings: (...args: any[]) => getSettingsMock(...args)
}));

jest.mock('node-cron', () => ({
    schedule: jest.fn(() => ({ stop: jest.fn() }))
}));

const {
    __testUtils,
    ensureFreshStatusRecipients,
    getStatusRecipientSnapshot,
    refreshStatusRecipients
} = require('../src/services/statusAudienceService');

describe('statusAudienceService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        __testUtils.clearInMemoryStatusAudienceCache();
        getSettingsMock.mockResolvedValue({
            status_audience_mode: 'auto',
            status_audience_jids: '',
            status_include_group_participants: false
        });
        delete process.env.WHATSAPP_STATUS_AUDIENCE_JIDS;
        delete process.env.WHATSAPP_STATUS_JID_LIST;
        delete process.env.WHATSAPP_STATUS_AUDIENCE_MODE;
        delete process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS;
        delete process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE;
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

    it('does not trust a fresh group-participant snapshot just because LIDs mapped to phone JIDs', async () => {
        const refreshedAt = new Date().toISOString();
        const storedRecipients = Array.from({ length: 40 }, (_value, index) => `${1200000000 + index}@s.whatsapp.net`);
        const { supabase, tables } = buildSupabaseMock({
            status_recipients: storedRecipients.map((recipient) => ({
                session_id: 'primary',
                recipient_jid: recipient,
                refreshed_at: refreshedAt,
                sources: {
                    contactsCache: 0,
                    storeContacts: 0,
                    storeChats: 0,
                    groupMetadata: 80,
                    env: 0,
                    me: 1,
                    lidMappings: 40,
                    activeIndividualTargets: 0,
                    recentSuccessfulDirectRecipients: 0
                },
                warnings: []
            }))
        });
        getSupabaseClientMock.mockReturnValue(supabase);

        const result = await ensureFreshStatusRecipients(
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
                        me: 1,
                        lidMappings: 0
                    },
                    warnings: []
                })
            },
            { maxAgeMinutes: 10, sampleSize: 10 }
        );

        expect(result.participantCount).toBe(0);
        expect(result.recipients).toEqual([]);
        expect(tables.status_recipients).toHaveLength(0);
    });

    it('preserves a small trusted contact snapshot during cold reconnect', async () => {
        const refreshedAt = new Date(Date.now() - 60_000).toISOString();
        const storedRecipients = ['16465527019@s.whatsapp.net', '16465527020@s.whatsapp.net'];
        const { supabase, tables } = buildSupabaseMock({
            status_recipients: storedRecipients.map((recipient) => ({
                session_id: 'primary',
                recipient_jid: recipient,
                refreshed_at: refreshedAt,
                sources: {
                    contactsCache: 2,
                    storeContacts: 0,
                    storeChats: 0,
                    groupMetadata: 0,
                    env: 0,
                    me: 1,
                    activeIndividualTargets: 0,
                    recentSuccessfulDirectRecipients: 0
                },
                warnings: []
            }))
        });
        getSupabaseClientMock.mockReturnValue(supabase);

        const result = await refreshStatusRecipients(
            {
                getStatus: () => ({ status: 'connected' }),
                getStatusParticipants: () => ['16465527018@s.whatsapp.net'],
                getStatusAudience: () => ({
                    participantCount: 1,
                    sample: ['16465527018@s.whatsapp.net'],
                    selfJid: '16465527018@s.whatsapp.net',
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

        expect(result.recipients).toEqual(storedRecipients);
        expect(result.warnings.some((warning: string) => warning.includes('Preserved the previous status audience snapshot'))).toBe(true);
        expect(tables.status_recipients).toHaveLength(2);
    });

    it('does not trust a one-recipient cache-only stored status audience', async () => {
        const refreshedAt = new Date().toISOString();
        const { supabase, tables } = buildSupabaseMock({
            status_recipients: [
                {
                    session_id: 'primary',
                    recipient_jid: '103140015788103@lid',
                    refreshed_at: refreshedAt,
                    sources: {
                        contactsCache: 1,
                        storeContacts: 0,
                        storeChats: 0,
                        groupMetadata: 0,
                        env: 0,
                        me: 1,
                        activeIndividualTargets: 0,
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
                getStatusParticipants: () => [],
                getStatusAudience: () => ({
                    participantCount: 0,
                    sample: [],
                    selfJid: '103140015788103@lid',
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
            { maxAgeMinutes: 10, sampleSize: 10 }
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

    it('uses group participant phone recipients only with an explicit unsafe override', async () => {
        process.env.WHATSAPP_STATUS_INCLUDE_GROUP_PARTICIPANTS = 'true';
        process.env.WHATSAPP_STATUS_ALLOW_GROUP_PARTICIPANT_AUDIENCE = 'unsafe';
        const { supabase, tables } = buildSupabaseMock();
        getSupabaseClientMock.mockReturnValue(supabase);

        const result = await refreshStatusRecipients(
            {
                getStatus: () => ({ status: 'connected' }),
                getStatusParticipants: () => ['19144477725@s.whatsapp.net', '15551234567@s.whatsapp.net', '103140015788103@lid'],
                getStatusAudience: () => ({
                    participantCount: 3,
                    sample: ['19144477725@s.whatsapp.net', '15551234567@s.whatsapp.net', '103140015788103@lid'],
                    selfJid: '16465527019@s.whatsapp.net',
                    sources: {
                        contactsCache: 0,
                        storeContacts: 0,
                        storeChats: 0,
                        groupMetadata: 3,
                        env: 0,
                        me: 1,
                        lidMappings: 0
                    },
                    warnings: ['Status audience has 1 LID recipients without phone-number mappings.']
                })
            },
            { sampleSize: 10 }
        );

        expect(result.recipients).toEqual(['15551234567@s.whatsapp.net', '19144477725@s.whatsapp.net']);
        expect(result.sources.groupMetadata).toBe(3);
        expect(result.warnings.some((warning: string) => warning.includes('resolved only from group participants'))).toBe(false);
        expect(result.warnings.some((warning: string) => warning.includes('without phone-number mappings'))).toBe(false);
        expect(result.warnings.some((warning: string) => warning.includes('Ignored 1 unresolved group-participant LID'))).toBe(true);
        expect(tables.status_recipients.map((row) => row.recipient_jid).sort()).toEqual(result.recipients);
    });

    it('limits the stored and returned audience to explicit env recipients', async () => {
        process.env.WHATSAPP_STATUS_AUDIENCE_JIDS = '19144477725, 15551234567@s.whatsapp.net';
        process.env.WHATSAPP_STATUS_AUDIENCE_MODE = 'explicit';
        const { supabase, tables } = buildSupabaseMock({
            status_recipients: [
                {
                    session_id: 'primary',
                    recipient_jid: '16465527019@s.whatsapp.net',
                    refreshed_at: new Date(Date.now() - 60_000).toISOString(),
                    sources: {
                        contactsCache: 1,
                        storeContacts: 0,
                        storeChats: 0,
                        groupMetadata: 0,
                        env: 0,
                        me: 1,
                        activeIndividualTargets: 0,
                        recentSuccessfulDirectRecipients: 0
                    },
                    warnings: []
                }
            ]
        });
        getSupabaseClientMock.mockReturnValue(supabase);

        const result = await refreshStatusRecipients(
            {
                getStatus: () => ({ status: 'connected' }),
                getStatusParticipants: () => ['16465527019@s.whatsapp.net', '15559876543@s.whatsapp.net'],
                getStatusAudience: () => ({
                    participantCount: 2,
                    sample: ['16465527019@s.whatsapp.net', '15559876543@s.whatsapp.net'],
                    sources: {
                        contactsCache: 2,
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

        expect(result.recipients).toEqual(['15551234567@s.whatsapp.net', '19144477725@s.whatsapp.net']);
        expect(result.sources.env).toBe(2);
        expect(result.sources.contactsCache).toBe(0);
        expect(tables.status_recipients.map((row) => row.recipient_jid).sort()).toEqual(result.recipients);
    });

    it('does not reuse an old env-limited snapshot when status audience mode is auto', async () => {
        process.env.WHATSAPP_STATUS_AUDIENCE_JIDS = '19144477725@s.whatsapp.net';
        const { supabase, tables } = buildSupabaseMock({
            status_recipients: [
                {
                    session_id: 'primary',
                    recipient_jid: '19144477725@s.whatsapp.net',
                    refreshed_at: new Date().toISOString(),
                    sources: {
                        contactsCache: 0,
                        storeContacts: 0,
                        storeChats: 0,
                        groupMetadata: 0,
                        env: 1,
                        me: 1,
                        activeIndividualTargets: 0,
                        recentSuccessfulDirectRecipients: 0
                    },
                    warnings: ['Status audience is limited to WHATSAPP_STATUS_AUDIENCE_JIDS.']
                }
            ]
        });
        getSupabaseClientMock.mockReturnValue(supabase);

        const result = await ensureFreshStatusRecipients(
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
            { maxAgeMinutes: 10, sampleSize: 10 }
        );

        expect(result.recipients).toEqual([]);
        expect(result.warnings.some((warning: string) => warning.includes('limited to WHATSAPP_STATUS_AUDIENCE_JIDS'))).toBe(false);
        expect(tables.status_recipients).toHaveLength(0);
    });

    it('does not return an unsafe stored group snapshot while WhatsApp is disconnected', async () => {
        const refreshedAt = new Date().toISOString();
        const storedRecipients = Array.from({ length: 20 }, (_value, index) => `${1200000000 + index}@s.whatsapp.net`);
        const { supabase } = buildSupabaseMock({
            status_recipients: storedRecipients.map((recipient) => ({
                session_id: 'primary',
                recipient_jid: recipient,
                refreshed_at: refreshedAt,
                sources: {
                    contactsCache: 0,
                    storeContacts: 0,
                    storeChats: 0,
                    groupMetadata: 20,
                    env: 0,
                    me: 1,
                    lidMappings: 20,
                    activeIndividualTargets: 0,
                    recentSuccessfulDirectRecipients: 0
                },
                warnings: []
            }))
        });
        getSupabaseClientMock.mockReturnValue(supabase);

        const result = await refreshStatusRecipients(
            {
                getStatus: () => ({ status: 'qr' })
            },
            { sampleSize: 10 }
        );

        expect(result.participantCount).toBe(0);
        expect(result.recipients).toEqual([]);
        expect(result.stale).toBe(true);
        expect(result.warnings.some((warning: string) => warning.includes('not safe to use'))).toBe(true);
    });

    it('does not show an unsafe stored group snapshot in the status audience UI snapshot', async () => {
        const refreshedAt = new Date().toISOString();
        const { supabase } = buildSupabaseMock({
            status_recipients: [
                {
                    session_id: 'primary',
                    recipient_jid: '19144477725@s.whatsapp.net',
                    refreshed_at: refreshedAt,
                    sources: {
                        contactsCache: 0,
                        storeContacts: 0,
                        storeChats: 0,
                        groupMetadata: 1,
                        env: 0,
                        me: 1,
                        lidMappings: 1,
                        activeIndividualTargets: 0,
                        recentSuccessfulDirectRecipients: 0
                    },
                    warnings: []
                }
            ]
        });
        getSupabaseClientMock.mockReturnValue(supabase);

        const result = await getStatusRecipientSnapshot({ sampleSize: 10 });

        expect(result.participantCount).toBe(0);
        expect(result.sample).toEqual([]);
        expect(result.stale).toBe(true);
        expect(result.warnings.some((warning: string) => warning.includes('not safe to use'))).toBe(true);
    });

    it('drops implicit group LID recipients when no phone mappings or explicit recipients exist', async () => {
        const { supabase, tables } = buildSupabaseMock();
        getSupabaseClientMock.mockReturnValue(supabase);

        const result = await refreshStatusRecipients(
            {
                getStatus: () => ({ status: 'connected' }),
                getStatusParticipants: () => ['103140015788103@lid', '103140015788104@lid'],
                getStatusAudience: () => ({
                    participantCount: 2,
                    sample: ['103140015788103@lid', '103140015788104@lid'],
                    sources: {
                        contactsCache: 0,
                        storeContacts: 0,
                        storeChats: 0,
                        groupMetadata: 2,
                        env: 0,
                        me: 1,
                        lidMappings: 0
                    },
                    warnings: []
                })
            },
            { sampleSize: 10 }
        );

        expect(result.participantCount).toBe(0);
        expect(result.recipients).toEqual([]);
        expect(result.warnings.some((warning: string) => warning.includes('resolved only from group participants'))).toBe(true);
        expect(tables.status_recipients).toHaveLength(0);
    });

    it('drops recipients resolved only from group participant metadata even after LID mapping', async () => {
        const { supabase, tables } = buildSupabaseMock();
        getSupabaseClientMock.mockReturnValue(supabase);

        const result = await refreshStatusRecipients(
            {
                getStatus: () => ({ status: 'connected' }),
                getStatusParticipants: () => ['972501234567@s.whatsapp.net', '103140015788104@lid'],
                getStatusAudience: () => ({
                    participantCount: 2,
                    sample: ['972501234567@s.whatsapp.net', '103140015788104@lid'],
                    sources: {
                        contactsCache: 0,
                        storeContacts: 0,
                        storeChats: 0,
                        groupMetadata: 2,
                        env: 0,
                        me: 1,
                        lidMappings: 1
                    },
                    warnings: []
                })
            },
            { sampleSize: 10 }
        );

        expect(result.participantCount).toBe(0);
        expect(result.recipients).toEqual([]);
        expect(result.sources.lidMappings).toBe(1);
        expect(result.warnings.some((warning: string) => warning.includes('resolved only from group participants'))).toBe(true);
        expect(tables.status_recipients).toHaveLength(0);
    });

    it('uses saved group-audience setting when refreshing production status recipients', async () => {
        const { supabase, tables } = buildSupabaseMock();
        getSupabaseClientMock.mockReturnValue(supabase);
        getSettingsMock.mockResolvedValue({
            status_audience_mode: 'auto',
            status_audience_jids: '',
            status_include_group_participants: true
        });

        const getStatusParticipants = jest.fn(() => ['972501234567@s.whatsapp.net']);
        const getStatusAudience = jest.fn(() => ({
            participantCount: 1,
            sample: ['972501234567@s.whatsapp.net'],
            selfJid: '16465527019@s.whatsapp.net',
            sources: {
                contactsCache: 0,
                storeContacts: 0,
                storeChats: 0,
                groupMetadata: 1,
                env: 0,
                me: 1,
                lidMappings: 0
            },
            warnings: []
        }));

        const result = await refreshStatusRecipients(
            {
                getStatus: () => ({ status: 'connected' }),
                getStatusParticipants,
                getStatusAudience
            },
            { sampleSize: 10 }
        );

        expect(getStatusParticipants as any).toHaveBeenCalledWith({ includeGroupParticipants: true });
        expect(getStatusAudience as any).toHaveBeenCalledWith({ sampleSize: 10, includeGroupParticipants: true });
        expect(result.groupAudienceAllowed).toBe(true);
        expect(result.recipients).toEqual(['972501234567@s.whatsapp.net']);
        expect(tables.status_recipients.map((row) => row.recipient_jid)).toEqual(['972501234567@s.whatsapp.net']);
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

    it('does not prune the stored snapshot when status recipient upsert fails', async () => {
        const refreshedAt = new Date(Date.now() - 60_000).toISOString();
        const storedRecipients = ['16465527019@s.whatsapp.net', '16465527020@s.whatsapp.net'];
        const { supabase, tables } = buildSupabaseMock({
            status_recipients: storedRecipients.map((recipient) => ({
                session_id: 'primary',
                recipient_jid: recipient,
                refreshed_at: refreshedAt,
                sources: {
                    contactsCache: 2,
                    storeContacts: 0,
                    storeChats: 0,
                    groupMetadata: 0,
                    env: 0,
                    me: 1,
                    activeIndividualTargets: 0,
                    recentSuccessfulDirectRecipients: 0
                },
                warnings: []
            }))
        });
        const originalFrom = supabase.from.bind(supabase);
        let failedOnce = false;
        (supabase as any).from = (table: TableName) => {
            const query = originalFrom(table);
            if (table !== 'status_recipients') {
                return query;
            }
            return {
                ...query,
                upsert: async (rows: Row[], options?: { onConflict?: string }) => {
                    if (!failedOnce) {
                        failedOnce = true;
                        return { data: null, error: { message: 'statement timeout' } };
                    }
                    return query.upsert(rows, options);
                }
            };
        };
        getSupabaseClientMock.mockReturnValue(supabase);

        const result = await refreshStatusRecipients(
            {
                getStatus: () => ({ status: 'connected' }),
                getStatusParticipants: () => ['16465527021@s.whatsapp.net'],
                getStatusAudience: () => ({
                    participantCount: 1,
                    sample: ['16465527021@s.whatsapp.net'],
                    selfJid: '16465527018@s.whatsapp.net',
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

        expect(result.recipients).toEqual(['16465527021@s.whatsapp.net']);
        expect(tables.status_recipients.map((row) => row.recipient_jid).sort()).toEqual(storedRecipients);
        expect(loggerWarnMock).toHaveBeenCalled();
    });
});
