import { describe, it, expect } from '@jest/globals';

const {
    normalizeChannelJid,
    normalizeGroupJid,
    normalizeIndividualJid,
    inferTargetType,
    normalizePhoneForType,
    normalizeTargetJidForSend,
    isValidChannelJid
} = require('../src/utils/targetJid');

describe('normalizeGroupJid', () => {
    it('passes through already-normalized group JIDs', () => {
        expect(normalizeGroupJid('120363000000000000@g.us')).toBe('120363000000000000@g.us');
    });

    it('appends @g.us suffix to bare numeric-dash strings', () => {
        expect(normalizeGroupJid('120363000000000000')).toBe('120363000000000000@g.us');
        expect(normalizeGroupJid('120363-000000000000')).toBe('120363-000000000000@g.us');
    });

    it('is case-insensitive for the suffix', () => {
        expect(normalizeGroupJid('120363000000000000@G.US')).toBe('120363000000000000@g.us');
    });

    it('returns empty for empty input', () => {
        expect(normalizeGroupJid('')).toBe('');
        expect(normalizeGroupJid(null)).toBe('');
        expect(normalizeGroupJid(undefined)).toBe('');
    });

    it('returns fallback for unknown @ domains', () => {
        const result = normalizeGroupJid('abc@unknown', { returnEmptyOnInvalid: true });
        expect(result).toBe('');
    });
});

describe('normalizeChannelJid', () => {
    it('passes through already-normalized channel JIDs', () => {
        expect(normalizeChannelJid('120363abcdef@newsletter')).toBe('120363abcdef@newsletter');
    });

    it('appends @newsletter to bare alphanumeric strings (>= 6 chars)', () => {
        expect(normalizeChannelJid('abcdef123')).toBe('abcdef123@newsletter');
    });

    it('strips true_/false_ prefix from user part', () => {
        expect(normalizeChannelJid('true_somechannel@newsletter')).toBe('somechannel@newsletter');
        expect(normalizeChannelJid('false_anotherchannel@newsletter')).toBe('anotherchannel@newsletter');
    });

    it('returns empty for empty input', () => {
        expect(normalizeChannelJid('')).toBe('');
        expect(normalizeChannelJid(null)).toBe('');
    });

    it('validates channel JIDs', () => {
        expect(isValidChannelJid('120363abcdef@newsletter')).toBe(true);
        expect(isValidChannelJid('')).toBe(false);
        expect(isValidChannelJid('120363000000000000@g.us')).toBe(false);
    });
});

describe('normalizeIndividualJid', () => {
    it('passes through already-normalized individual JIDs', () => {
        expect(normalizeIndividualJid('972501234567@s.whatsapp.net')).toBe('972501234567@s.whatsapp.net');
    });

    it('recognizes status@broadcast as individual', () => {
        expect(normalizeIndividualJid('status@broadcast')).toBe('status@broadcast');
    });

    it('appends @s.whatsapp.net to bare digit strings', () => {
        expect(normalizeIndividualJid('972501234567')).toBe('972501234567@s.whatsapp.net');
    });

    it('strips non-digits from bare numbers', () => {
        expect(normalizeIndividualJid('+972-50-123-4567')).toBe('972501234567@s.whatsapp.net');
    });

    it('returns empty for empty input', () => {
        expect(normalizeIndividualJid('')).toBe('');
        expect(normalizeIndividualJid(null)).toBe('');
    });

    it('handles @lid suffix', () => {
        expect(normalizeIndividualJid('123@lid')).toBe('123@lid');
    });
});

describe('inferTargetType', () => {
    it('detects status from phone_number', () => {
        expect(inferTargetType(undefined, 'status@broadcast')).toBe('status');
    });

    it('detects channel from @newsletter suffix', () => {
        expect(inferTargetType(undefined, 'abc@newsletter')).toBe('channel');
    });

    it('detects group from @g.us suffix', () => {
        expect(inferTargetType(undefined, '120363000000@g.us')).toBe('group');
    });

    it('detects individual from @s.whatsapp.net suffix', () => {
        expect(inferTargetType(undefined, '972501234567@s.whatsapp.net')).toBe('individual');
    });

    it('falls back to explicit type when phone is ambiguous', () => {
        expect(inferTargetType('group', '120363000000')).toBe('group');
        expect(inferTargetType('channel', 'somechannel')).toBe('channel');
        expect(inferTargetType('status', '')).toBe('status');
    });

    it('defaults to individual for unknown type and ambiguous phone', () => {
        expect(inferTargetType(undefined, '972501234567')).toBe('individual');
        expect(inferTargetType('', '972501234567')).toBe('individual');
    });
});

describe('normalizePhoneForType', () => {
    it('returns status@broadcast for status type', () => {
        expect(normalizePhoneForType('status', 'anything')).toBe('status@broadcast');
    });

    it('normalizes group JIDs', () => {
        expect(normalizePhoneForType('group', '120363000000')).toBe('120363000000@g.us');
    });

    it('normalizes channel JIDs', () => {
        expect(normalizePhoneForType('channel', 'abcdef123@newsletter')).toBe('abcdef123@newsletter');
    });

    it('normalizes individual JIDs', () => {
        expect(normalizePhoneForType('individual', '972501234567')).toBe('972501234567@s.whatsapp.net');
    });
});

describe('normalizeTargetJidForSend', () => {
    it('normalizes a group target', () => {
        expect(normalizeTargetJidForSend({ phone_number: '120363000000@g.us', type: 'group' }))
            .toBe('120363000000@g.us');
    });

    it('normalizes a channel target', () => {
        expect(normalizeTargetJidForSend({ phone_number: 'somechannel@newsletter', type: 'channel' }))
            .toBe('somechannel@newsletter');
    });

    it('normalizes a status target', () => {
        expect(normalizeTargetJidForSend({ phone_number: 'status@broadcast', type: 'status' }))
            .toBe('status@broadcast');
    });

    it('normalizes an individual target', () => {
        expect(normalizeTargetJidForSend({ phone_number: '972501234567', type: 'individual' }))
            .toBe('972501234567@s.whatsapp.net');
    });

    it('infers type from phone pattern when type is missing', () => {
        expect(normalizeTargetJidForSend({ phone_number: '120363000000@g.us' }))
            .toBe('120363000000@g.us');
        expect(normalizeTargetJidForSend({ phone_number: 'abc@newsletter' }))
            .toBe('abc@newsletter');
        expect(normalizeTargetJidForSend({ phone_number: 'status@broadcast' }))
            .toBe('status@broadcast');
    });

    it('returns empty for missing phone_number', () => {
        expect(normalizeTargetJidForSend({})).toBe('');
        expect(normalizeTargetJidForSend({ phone_number: '' })).toBe('');
    });
});
