import { describe, it, expect } from '@jest/globals';

const { inferMediaKindFromUrl, normalizeFeedMedia } = require('../src/utils/feedMedia');

describe('inferMediaKindFromUrl', () => {
    it('detects image URLs by extension', () => {
        expect(inferMediaKindFromUrl('https://example.com/photo.jpg')).toBe('image');
        expect(inferMediaKindFromUrl('https://example.com/photo.webp?size=large')).toBe('image');
    });

    it('detects video URLs by extension', () => {
        expect(inferMediaKindFromUrl('https://example.com/clip.mp4')).toBe('video');
        expect(inferMediaKindFromUrl('https://example.com/clip.webm#fragment')).toBe('video');
    });

    it('returns null for non-media URLs', () => {
        expect(inferMediaKindFromUrl('https://example.com/post')).toBeNull();
        expect(inferMediaKindFromUrl('')).toBeNull();
    });
});

describe('normalizeFeedMedia', () => {
    it('prefers explicit media metadata when valid', () => {
        expect(
            normalizeFeedMedia({
                mediaUrl: 'https://example.com/video.mp4',
                mediaKind: 'video',
                imageUrl: 'https://example.com/image.jpg'
            })
        ).toEqual({
            mediaUrl: 'https://example.com/video.mp4',
            mediaKind: 'video',
            imageUrl: ''
        });
    });

    it('falls back to raw_data media metadata', () => {
        expect(
            normalizeFeedMedia({
                rawData: {
                    media_url: 'https://example.com/image.jpg',
                    media_kind: 'image'
                }
            })
        ).toEqual({
            mediaUrl: 'https://example.com/image.jpg',
            mediaKind: 'image',
            imageUrl: 'https://example.com/image.jpg'
        });
    });

    it('uses imageUrl when that is all that exists', () => {
        expect(
            normalizeFeedMedia({
                imageUrl: 'https://example.com/featured.png'
            })
        ).toEqual({
            mediaUrl: 'https://example.com/featured.png',
            mediaKind: 'image',
            imageUrl: 'https://example.com/featured.png'
        });
    });
});
