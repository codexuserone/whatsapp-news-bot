import { describe, expect, it } from '@jest/globals';

const { redactConsoleArgs } = require('../src/utils/logRedaction');

describe('logRedaction', () => {
    it('redacts libsignal session objects from console output', () => {
        const redacted = redactConsoleArgs([
            'Closing session:',
            {
                currentRatchet: {
                    ephemeralKeyPair: {
                        privKey: Buffer.from('secret')
                    }
                }
            }
        ]);

        expect(redacted).toEqual(['Closing session: [redacted]']);
    });

    it('leaves unrelated console messages unchanged', () => {
        const args = ['WhatsApp connected successfully', { ok: true }];

        expect(redactConsoleArgs(args)).toBe(args);
    });
});
