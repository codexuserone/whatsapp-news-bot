import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockParseString: any = jest.fn();
const mockSafeAxiosRequest: any = jest.fn();
const mockAssertSafeOutboundUrl: any = jest.fn(async () => undefined);

jest.mock('rss-parser', () =>
    jest.fn().mockImplementation(() => ({
        parseString: mockParseString,
        parseURL: jest.fn()
    }))
);

jest.mock('../src/utils/safeAxios', () => ({
    safeAxiosRequest: (...args: any[]) => mockSafeAxiosRequest(...args)
}));

jest.mock('../src/utils/outboundUrl', () => ({
    assertSafeOutboundUrl: (...args: any[]) => mockAssertSafeOutboundUrl(...args)
}));

const { fetchFeedItemsWithMeta } = require('../src/services/feedFetcher');

describe('fetchFeedItemsWithMeta', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('normalizes JSON feed items across image and video payloads', async () => {
        mockSafeAxiosRequest.mockResolvedValueOnce({
            status: 200,
            headers: { 'content-type': 'application/json' },
            data: {
                items: [
                    {
                        id: 'video-1',
                        title: 'Video item',
                        link: 'https://example.com/post?utm_source=test&utm_medium=social',
                        description: 'Video description',
                        image_url: 'https://cdn.example.com/poster.jpg',
                        media_url: 'https://cdn.example.com/clip.mp4',
                        date_published: '2026-03-15T12:34:56Z',
                        categories: ['News']
                    },
                    {
                        id: 'image-1',
                        title: 'Image item',
                        link: 'https://example.com/image-post?utm_campaign=spring',
                        description: 'Image description',
                        image_url: 'https://cdn.example.com/featured.webp',
                        date_published: '2026-03-15T12:00:00Z',
                        tags: ['Updates']
                    }
                ]
            }
        });

        const result = await fetchFeedItemsWithMeta({
            url: 'https://example.com/feed.json',
            type: 'json'
        });

        expect(result.meta.detectedType).toBe('json');
        expect(result.items).toHaveLength(2);
        expect(result.items[0]).toMatchObject({
            guid: 'video-1',
            title: 'Video item',
            url: 'https://example.com/post',
            mediaUrl: 'https://cdn.example.com/clip.mp4',
            mediaKind: 'video',
            imageUrl: undefined,
            categories: ['News']
        });
        expect(result.items[0].raw).toMatchObject({
            media_url: 'https://cdn.example.com/clip.mp4',
            media_kind: 'video',
            published_precision: 'datetime'
        });
        expect(result.items[1]).toMatchObject({
            guid: 'image-1',
            title: 'Image item',
            url: 'https://example.com/image-post',
            mediaUrl: 'https://cdn.example.com/featured.webp',
            mediaKind: 'image',
            imageUrl: 'https://cdn.example.com/featured.webp',
            categories: ['Updates']
        });
    });

    it('discovers feed endpoints from HTML sources before parsing items', async () => {
        mockSafeAxiosRequest
            .mockResolvedValueOnce({
                status: 200,
                headers: { 'content-type': 'text/html; charset=utf-8' },
                data: `
                    <html>
                        <head>
                            <link rel="alternate" type="application/feed+json" href="/feed.json" />
                        </head>
                    </html>
                `
            })
            .mockResolvedValueOnce({
                status: 200,
                headers: { 'content-type': 'application/feed+json' },
                data: {
                    items: [
                        {
                            id: 'html-json-1',
                            title: 'Discovered item',
                            link: 'https://example.com/discovered',
                            image_url: 'https://cdn.example.com/discovered.jpg'
                        }
                    ]
                }
            });

        const result = await fetchFeedItemsWithMeta({
            url: 'https://example.com/newsroom',
            type: 'html'
        });

        expect(result.meta.detectedType).toBe('json');
        expect(result.meta.sourceUrl).toBe('https://example.com/feed.json');
        expect(result.meta.discoveredFromUrl).toBe('https://example.com/newsroom');
        expect(result.items[0]).toMatchObject({
            guid: 'html-json-1',
            title: 'Discovered item',
            mediaKind: 'image',
            mediaUrl: 'https://cdn.example.com/discovered.jpg',
            imageUrl: 'https://cdn.example.com/discovered.jpg'
        });
    });

    it('prefers RSS enclosure videos over image thumbnails when both exist', async () => {
        mockSafeAxiosRequest.mockResolvedValueOnce({
            status: 200,
            headers: { 'content-type': 'application/rss+xml' },
            data: Buffer.from('<rss version="2.0"><channel><title>Example</title></channel></rss>', 'utf8')
        });
        mockParseString.mockResolvedValueOnce({
            items: [
                {
                    guid: 'rss-video-1',
                    title: 'RSS video item',
                    link: 'https://example.com/rss-item?utm_source=rss',
                    pubDate: 'Sun, 15 Mar 2026 12:34:56 GMT',
                    enclosure: { url: 'https://cdn.example.com/rss-video.mp4' },
                    'media:thumbnail': { url: 'https://cdn.example.com/rss-thumb.jpg' },
                    categories: ['Alerts']
                },
                {
                    guid: 'rss-image-1',
                    title: 'RSS image item',
                    link: 'https://example.com/rss-image',
                    pubDate: 'Sun, 15 Mar 2026 10:00:00 GMT',
                    'media:thumbnail': { url: 'https://cdn.example.com/rss-image.jpg' },
                    categories: ['Photos']
                }
            ]
        });

        const result = await fetchFeedItemsWithMeta({
            url: 'https://example.com/feed.xml',
            type: 'rss'
        });

        expect(result.meta.detectedType).toBe('rss');
        expect(result.items).toHaveLength(2);
        expect(result.items[0]).toMatchObject({
            guid: 'rss-video-1',
            url: 'https://example.com/rss-item',
            mediaUrl: 'https://cdn.example.com/rss-video.mp4',
            mediaKind: 'video',
            imageUrl: undefined,
            categories: ['Alerts']
        });
        expect(result.items[1]).toMatchObject({
            guid: 'rss-image-1',
            mediaUrl: 'https://cdn.example.com/rss-image.jpg',
            mediaKind: 'image',
            imageUrl: 'https://cdn.example.com/rss-image.jpg',
            categories: ['Photos']
        });
    });
});
