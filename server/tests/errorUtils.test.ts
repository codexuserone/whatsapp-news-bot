import { describe, expect, it } from '@jest/globals';

const { getErrorMessage, getErrorStatus } = require('../src/utils/errorUtils');

describe('getErrorMessage', () => {
    it('returns message from native Error', () => {
        expect(getErrorMessage(new Error('boom'))).toBe('boom');
    });

    it('returns message from structured error objects', () => {
        expect(getErrorMessage({ message: 'Request failed' })).toBe('Request failed');
    });

    it('returns nested cause message when direct message is missing', () => {
        expect(getErrorMessage({ cause: new Error('inner failure') })).toBe('inner failure');
    });

    it('returns fallback when message cannot be derived', () => {
        expect(getErrorMessage({ foo: 'bar' }, 'fallback text')).toBe('fallback text');
    });
});

describe('getErrorStatus', () => {
    it('reads status directly', () => {
        expect(getErrorStatus({ status: 404 })).toBe(404);
    });

    it('reads statusCode and response.status values', () => {
        expect(getErrorStatus({ statusCode: 429 })).toBe(429);
        expect(getErrorStatus({ response: { status: 503 } })).toBe(503);
    });

    it('falls back when status is missing or invalid', () => {
        expect(getErrorStatus({ status: 'abc' }, 418)).toBe(418);
        expect(getErrorStatus(null, 418)).toBe(418);
    });
});
