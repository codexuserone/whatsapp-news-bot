import { describe, expect, it } from '@jest/globals';

const sharp = require('sharp');
const { prepareNewsletterImage } = require('../src/utils/whatsappMedia');

describe('prepareNewsletterImage', () => {
    it('converts webp payloads into jpeg buffers before WhatsApp sends', async () => {
        const webpBuffer = await sharp({
            create: {
                width: 64,
                height: 64,
                channels: 3,
                background: { r: 12, g: 140, b: 210 }
            }
        })
            .webp()
            .toBuffer();

        const result = await prepareNewsletterImage(webpBuffer, { maxBytes: 1024 * 1024 });

        expect(result.mimetype).toBe('image/jpeg');
        expect(result.converted).toBe(true);
        expect(Buffer.isBuffer(result.buffer)).toBe(true);
        expect(result.buffer.slice(0, 3).toString('hex')).toBe('ffd8ff');
    });
});
