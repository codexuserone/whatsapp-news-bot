const Parser = require('rss-parser');
const cheerio = require('cheerio');
const he = require('he');
const { assertSafeOutboundUrl } = require('../utils/outboundUrl');
const { safeAxiosRequest } = require('../utils/safeAxios');
const { buildDefaultUserAgent } = require('../utils/httpClientIdentity');
const { normalizeFeedMedia } = require('../utils/feedMedia');

const parser = new Parser({
  customFields: {
    item: ['media:content', 'media:thumbnail', 'itunes:image', 'image', 'content:encoded']
  }
});

type FetchMeta = {
  status?: number;
  etag?: string;
  lastModified?: string;
  notModified?: boolean;
  durationMs?: number;
  detectedType?: 'rss' | 'atom' | 'json' | 'html';
  contentType?: string;
  sourceUrl?: string;
  discoveredFromUrl?: string;
};

const DEFAULT_USER_AGENT = buildDefaultUserAgent();

const getPath = (obj: Record<string, unknown>, path?: string) => {
  if (!path) return undefined;
  const parts = path.replace(/\[(\w+)\]/g, '.$1').split('.');
  return parts.reduce((acc: unknown, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
};

const toTextValue = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
};

const extractJsonItemsArray = (json: unknown, itemsPath?: string): unknown[] => {
  if (itemsPath) {
    try {
      const picked = getPath(json as Record<string, unknown>, itemsPath);
      if (Array.isArray(picked)) return picked;
    } catch {
      // ignore
    }
  }

  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  const obj = json as Record<string, unknown>;

  const candidates = [
    getPath(obj, 'items'),
    getPath(obj, 'feed.items'),
    getPath(obj, 'data.items'),
    getPath(obj, 'data'),
    getPath(obj, 'results'),
    getPath(obj, 'articles'),
    getPath(obj, 'entries'),
    getPath(obj, 'posts')
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  const topLevelArrays = Object.values(obj).filter((value) => Array.isArray(value));
  if (topLevelArrays.length === 1) {
    return topLevelArrays[0] as unknown[];
  }
  return [];
};

const stripHtml = (value: string = '') => {
  const $ = cheerio.load(value);
  return $.text();
};

const removeUtm = (url: string) => {
  try {
    const parsed = new URL(url);
    [...parsed.searchParams.keys()].forEach((key) => {
      if (key.toLowerCase().startsWith('utm_')) {
        parsed.searchParams.delete(key);
      }
    });
    parsed.search = parsed.searchParams.toString();
    return parsed.toString();
  } catch (error) {
    return url;
  }
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isValidUrl = (value?: string) => {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const pickFirstUrl = (...candidates: Array<string | undefined | null>) => {
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? candidate.trim() : '';
    if (value && isValidUrl(value)) return value;
  }
  return undefined;
};

const resolveRelativeUrl = (baseUrl: string, candidate?: string | null) => {
  const raw = String(candidate || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return '';
  }
};

const detectFeedTypeHint = (value?: string | null): 'rss' | 'atom' | 'json' | null => {
  const normalized = String(value || '').toLowerCase();
  if (!normalized) return null;
  if (normalized.includes('json') || normalized.includes('feed+json')) return 'json';
  if (normalized.includes('atom')) return 'atom';
  if (normalized.includes('rss') || normalized.includes('xml')) return 'rss';
  return null;
};

const getHeaderText = (headers: Record<string, unknown> | undefined, name: string) => {
  const lowerName = name.toLowerCase();
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === lowerName);
  return entry ? String(entry[1] || '') : '';
};

const looksLikeJsonPayload = (contentType: string, bodyText: string) => {
  const normalizedType = String(contentType || '').toLowerCase();
  const trimmed = String(bodyText || '').trimStart();
  return normalizedType.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[');
};

const discoverFeedEndpointFromHtml = async (
  pageUrl: string
): Promise<{ url: string; type: 'rss' | 'atom' | 'json' | null } | null> => {
  await assertSafeOutboundUrl(pageUrl);
  const response = await safeAxiosRequest(pageUrl, {
    timeout: 15000,
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
    }
  });

  const html = String(response.data || '');
  if (!html.trim()) return null;
  const $ = cheerio.load(html);

  const candidates: Array<{ url: string; type: 'rss' | 'atom' | 'json' | null; score: number }> = [];
  const pushCandidate = (urlLike?: string | null, hint?: string | null, score = 0) => {
    const resolved = resolveRelativeUrl(pageUrl, urlLike);
    if (!resolved || !isValidUrl(resolved)) return;
    candidates.push({
      url: resolved,
      type: detectFeedTypeHint(hint),
      score
    });
  };

  // First preference: canonical feed autodiscovery tags.
  $('link[rel~="alternate"][href]').each((_: number, element: unknown) => {
    const el = $(element);
    pushCandidate(el.attr('href'), el.attr('type') || el.attr('title'), 100);
  });

  // Second preference: any feed-like link tag.
  $('link[href]').each((_: number, element: unknown) => {
    const el = $(element);
    const href = String(el.attr('href') || '').trim();
    if (!href) return;
    const combinedHint = `${String(el.attr('type') || '')} ${String(el.attr('title') || '')} ${href}`.toLowerCase();
    const looksLikeFeed = /feed|rss|atom|json/.test(combinedHint);
    if (!looksLikeFeed) return;
    pushCandidate(href, combinedHint, 80);
  });

  // Fallback: obvious feed-like anchors.
  $('a[href]').slice(0, 200).each((_: number, element: unknown) => {
    const el = $(element);
    const href = String(el.attr('href') || '').trim();
    if (!href) return;
    const text = String(el.text() || '').trim().toLowerCase();
    const hint = `${href} ${text}`.toLowerCase();
    const looksLikeFeed = /\/feed(?:[/?#]|$)|rss|atom|json/.test(hint);
    if (!looksLikeFeed) return;
    pushCandidate(href, hint, 40);
  });

  if (!candidates.length) return null;

  const current = String(pageUrl).trim();
  const deduped = new Map<string, { url: string; type: 'rss' | 'atom' | 'json' | null; score: number }>();
  for (const item of candidates) {
    const key = item.url.toLowerCase();
    const existing = deduped.get(key);
    if (!existing || item.score > existing.score) {
      deduped.set(key, item);
    }
  }

  const ranked = Array.from(deduped.values())
    .filter((item) => item.url !== current)
    .sort((a, b) => b.score - a.score);

  return ranked[0] || null;
};

const pickLargestSrcsetUrl = (srcset?: string) => {
  const candidates = String(srcset || '')
    .split(',')
    .map((entry) => {
      const [url, descriptor] = entry.trim().split(/\s+/, 2);
      const widthMatch = String(descriptor || '').match(/^(\d+)w$/i);
      const width = widthMatch ? Number(widthMatch[1]) : 0;
      return { url, width: Number.isFinite(width) ? width : 0 };
    })
    .filter((entry) => Boolean(entry.url));

  candidates.sort((a, b) => b.width - a.width);
  return candidates[0]?.url;
};

const extractFirstImageFromHtml = (html?: string, baseUrl?: string) => {
  if (!html) return undefined;
  try {
    const $ = cheerio.load(html);
    const image = $('img').first();
    const src = pickFirstUrl(
      resolveRelativeUrl(baseUrl || '', pickLargestSrcsetUrl(image.attr('srcset'))),
      resolveRelativeUrl(baseUrl || '', image.attr('data-src')),
      resolveRelativeUrl(baseUrl || '', image.attr('src')),
      pickLargestSrcsetUrl(image.attr('srcset')),
      image.attr('data-src'),
      image.attr('src')
    );
    return src && isValidUrl(src) ? src : undefined;
  } catch {
    return undefined;
  }
};

type FeedCleaning = { stripUtm?: boolean; decodeEntities?: boolean; removePhrases?: string[] };

const applyCleaning = (value: string = '', cleaning?: FeedCleaning) => {
  let output = value;
  if (cleaning?.decodeEntities) {
    output = he.decode(output);
  }
  output = stripHtml(output);
  const phrases = Array.isArray(cleaning?.removePhrases) ? cleaning?.removePhrases : [];
  phrases.forEach((phrase) => {
    if (!phrase) return;
    output = output.replace(new RegExp(escapeRegExp(phrase), 'gi'), '').trim();
  });
  return output.trim();
};

type FeedConfig = {
  url: string;
  type?: 'rss' | 'atom' | 'json' | 'html';
  parseConfig?: Record<string, unknown>;
  cleaning?: FeedCleaning;
  etag?: string | null;
  last_modified?: string | null;
};

type FeedItemResult = {
  guid?: string | undefined;
  title?: string | undefined;
  url?: string | undefined;
  description?: string | undefined;
  content?: string | undefined;
  author?: string | undefined;
  imageUrl?: string | undefined;
  mediaUrl?: string | undefined;
  mediaKind?: 'image' | 'video' | 'audio' | 'document' | undefined;
  mediaMime?: string | undefined;
  mediaFilename?: string | undefined;
  publishedAt?: string | Date | undefined;
  categories?: string[] | undefined;
  raw?: Record<string, unknown>;
};

const hasExplicitTimeComponent = (value: string) => {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/[T\s]\d{1,2}:\d{2}/.test(text)) return true;
  if (/:\d{2}/.test(text)) return true;
  return false;
};

const parsePublishedAt = (value: unknown): { value?: string; precision?: 'date' | 'datetime'; original?: string } => {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) return {};
    return {
      value: value.toISOString(),
      precision: 'datetime',
      original: value.toISOString()
    };
  }

  const raw = toTextValue(value)?.trim();
  if (!raw) return {};

  const parsed = new Date(raw);
  const ms = parsed.getTime();
  if (!Number.isFinite(ms)) {
    return { original: raw };
  }

  return {
    value: parsed.toISOString(),
    precision: hasExplicitTimeComponent(raw) ? 'datetime' : 'date',
    original: raw
  };
};

const parseRssPublishedAt = (isoDateValue: unknown, pubDateValue: unknown) => {
  const rawPubDate = toTextValue(pubDateValue)?.trim();
  const rawIsoDate = toTextValue(isoDateValue)?.trim();

  if (rawPubDate) {
    const parsedPubDate = parsePublishedAt(rawPubDate);
    if (parsedPubDate.value) {
      return {
        value: parsedPubDate.value,
        precision: hasExplicitTimeComponent(rawPubDate) ? 'datetime' : 'date',
        original: rawPubDate
      } as const;
    }
  }

  return parsePublishedAt(rawIsoDate);
};

const extractWordPressPostId = (...candidates: Array<unknown>) => {
  for (const candidate of candidates) {
    const value = toTextValue(candidate)?.trim();
    if (!value) continue;
    const queryMatch = value.match(/[?&]p=(\d+)/i);
    if (queryMatch?.[1]) return queryMatch[1];
    const idMatch = value.match(/\/\?p=(\d+)(?:$|[&#])/i);
    if (idMatch?.[1]) return idMatch[1];
  }
  return undefined;
};

const chunkValues = <T>(values: T[], chunkSize: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
};

const enrichWordPressRssPublishedAt = async (feedUrl: string, items: FeedItemResult[]) => {
  if (!Array.isArray(items) || !items.length) return items;

  let origin = '';
  try {
    origin = new URL(feedUrl).origin;
  } catch {
    return items;
  }

  const postsById = new Map<string, FeedItemResult[]>();
  for (const item of items) {
    const raw = item.raw && typeof item.raw === 'object' ? item.raw : undefined;
    if (!raw) continue;
    const precision = String(raw.published_precision || '').toLowerCase();
    if (precision !== 'date') continue;
    const postId = String(raw.wp_post_id || '').trim();
    if (!postId) continue;
    const bucket = postsById.get(postId) || [];
    bucket.push(item);
    postsById.set(postId, bucket);
  }

  if (!postsById.size) return items;

  const endpoint = `${origin}/wp-json/wp/v2/posts`;
  try {
    await assertSafeOutboundUrl(endpoint);
  } catch {
    return items;
  }

  const postIds = Array.from(postsById.keys());
  const maxEnrichedPosts = 120;
  const idsToEnrich = postIds.slice(0, maxEnrichedPosts);
  const batches = chunkValues(idsToEnrich, 50);

  for (const batch of batches) {
    try {
      const response = await safeAxiosRequest(endpoint, {
        timeout: 12000,
        params: {
          include: batch.join(','),
          per_page: batch.length,
          _embed: 'wp:featuredmedia',
          _fields: 'id,date_gmt,date,_embedded.wp:featuredmedia'
        },
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          Accept: 'application/json, text/json, */*;q=0.8'
        }
      });

      const posts = Array.isArray(response.data) ? response.data : [];
      for (const post of posts as Record<string, unknown>[]) {
        const postId = String(post.id || '').trim();
        if (!postId) continue;
        const publishedValue = toTextValue(post.date_gmt) || toTextValue(post.date);
        const published = parsePublishedAt(publishedValue);
        if (!published.value) continue;
        const featuredMediaMime = toTextValue(getPath(post, '_embedded.wp:featuredmedia[0].mime_type'));
        const featuredMediaType = String(getPath(post, '_embedded.wp:featuredmedia[0].media_type') || '').trim().toLowerCase();
        const featuredMediaIsImage = featuredMediaType === 'image' || String(featuredMediaMime || '').toLowerCase().startsWith('image/');
        const featuredImageUrl = featuredMediaIsImage ? pickFirstUrl(
          toTextValue(getPath(post, '_embedded.wp:featuredmedia[0].media_details.sizes.full.source_url')),
          toTextValue(getPath(post, '_embedded.wp:featuredmedia[0].source_url')),
          toTextValue(getPath(post, '_embedded.wp:featuredmedia[0].media_details.sizes.large.source_url')),
          toTextValue(getPath(post, '_embedded.wp:featuredmedia[0].media_details.sizes.medium_large.source_url')),
          toTextValue(getPath(post, '_embedded.wp:featuredmedia[0].guid.rendered'))
        ) : undefined;
        const featuredMediaUrl = featuredMediaIsImage
          ? featuredImageUrl
          : toTextValue(getPath(post, '_embedded.wp:featuredmedia[0].source_url'));
        const featuredMediaFilename =
          toTextValue(getPath(post, '_embedded.wp:featuredmedia[0].slug')) ||
          toTextValue(getPath(post, '_embedded.wp:featuredmedia[0].title.rendered'));

        const matchingItems = postsById.get(postId) || [];
        for (const item of matchingItems) {
          item.publishedAt = published.value;
          if (featuredMediaUrl) {
            const normalizedMedia = normalizeFeedMedia({
              mediaUrl: featuredMediaUrl,
              mediaMime: featuredMediaMime,
              mediaFilename: featuredMediaFilename,
              imageUrl: featuredImageUrl
            });
            item.imageUrl = normalizedMedia.imageUrl || item.imageUrl;
            item.mediaUrl = normalizedMedia.mediaUrl || item.mediaUrl;
            item.mediaKind = normalizedMedia.mediaKind || item.mediaKind;
            item.mediaMime = normalizedMedia.mediaMime || item.mediaMime;
            item.mediaFilename = normalizedMedia.mediaFilename || item.mediaFilename;
          }
          const itemRaw = item.raw && typeof item.raw === 'object' ? item.raw : {};
          itemRaw.published_precision = 'datetime';
          itemRaw.published_source = 'wp_rest';
          if (toTextValue(post.date_gmt)) itemRaw.wp_date_gmt = toTextValue(post.date_gmt);
          if (toTextValue(post.date)) itemRaw.wp_date = toTextValue(post.date);
          if (item.mediaUrl) itemRaw.media_url = item.mediaUrl;
          if (item.mediaKind) itemRaw.media_kind = item.mediaKind;
          if (item.mediaMime) itemRaw.media_mime = item.mediaMime;
          if (item.mediaFilename) itemRaw.media_filename = item.mediaFilename;
          if (featuredImageUrl) itemRaw.wp_featured_image = featuredImageUrl;
          item.raw = itemRaw;
        }
      }
    } catch (error) {
      console.warn(
        `WordPress publish-time enrichment failed for ${feedUrl}:`,
        error instanceof Error ? error.message : String(error)
      );
      break;
    }
  }

  return items;
};

const toStringValue = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  return String(value);
};

const toTextLike = (value: unknown): string | undefined => {
  const direct = toTextValue(value);
  if (direct !== undefined) return direct;
  if (!value || typeof value !== 'object') return undefined;
  return (
    toTextValue(getPath(value as Record<string, unknown>, 'rendered')) ||
    toTextValue(getPath(value as Record<string, unknown>, 'url')) ||
    toTextValue(getPath(value as Record<string, unknown>, 'href')) ||
    toTextValue(getPath(value as Record<string, unknown>, 'name'))
  );
};

const firstTextLike = (...values: unknown[]) => {
  for (const value of values) {
    const text = toTextLike(value);
    if (text !== undefined && String(text).trim() !== '') return text;
  }
  return undefined;
};

const getWordPressFeaturedMedia = (item: Record<string, unknown>) => {
  const media = getPath(item, '_embedded.wp:featuredmedia[0]');
  return media && typeof media === 'object' ? (media as Record<string, unknown>) : null;
};

const isWordPressFeaturedMediaImage = (media: Record<string, unknown> | null) => {
  const mediaType = String(media?.media_type || '').trim().toLowerCase();
  const mimeType = String(media?.mime_type || '').trim().toLowerCase();
  return mediaType === 'image' || mimeType.startsWith('image/');
};

const pickWordPressFeaturedImageUrl = (item: Record<string, unknown>) => {
  const media = getWordPressFeaturedMedia(item);
  if (!isWordPressFeaturedMediaImage(media)) return undefined;
  return pickFirstUrl(
    toTextLike(getPath(item, '_embedded.wp:featuredmedia[0].media_details.sizes.full.source_url')),
    toTextLike(getPath(item, '_embedded.wp:featuredmedia[0].source_url')),
    toTextLike(getPath(item, '_embedded.wp:featuredmedia[0].media_details.sizes.large.source_url')),
    toTextLike(getPath(item, '_embedded.wp:featuredmedia[0].media_details.sizes.medium_large.source_url')),
    toTextLike(getPath(item, '_embedded.wp:featuredmedia[0].media_details.sizes.medium.source_url')),
    toTextLike(getPath(item, '_embedded.wp:featuredmedia[0].media_details.sizes.thumbnail.source_url')),
    toTextLike(getPath(item, '_embedded.wp:featuredmedia[0].guid.rendered'))
  );
};

const extractJsonRawFields = (
  item: Record<string, unknown>,
  media?: {
    mediaUrl?: string;
    mediaKind?: 'image' | 'video' | 'audio' | 'document' | null;
    mediaMime?: string;
    mediaFilename?: string;
    imageUrl?: string;
  }
) => {
  const raw: Record<string, unknown> = {};
  const set = (key: string, value: unknown) => {
    const text = toTextLike(value);
    if (text === undefined || text === '') return;
    raw[key] = text;
  };

  // WordPress REST API common fields
  set('wp_id', getPath(item, 'id'));
  set('wp_slug', getPath(item, 'slug'));
  set('wp_type', getPath(item, 'type'));
  set('wp_status', getPath(item, 'status'));
  set('wp_featured_media', getPath(item, 'featured_media'));
  set('wp_date', getPath(item, 'date'));
  set('wp_modified', getPath(item, 'modified'));
  if (media?.imageUrl) {
    raw.wp_featured_image = media.imageUrl;
  }
  if (media?.mediaUrl) {
    raw.media_url = media.mediaUrl;
  }
  if (media?.mediaKind) {
    raw.media_kind = media.mediaKind;
  }
  if (media?.mediaMime) {
    raw.media_mime = media.mediaMime;
  }
  if (media?.mediaFilename) {
    raw.media_filename = media.mediaFilename;
  }

  const tags = getPath(item, 'tags');
  if (Array.isArray(tags) && tags.length) {
    raw.wp_tags = tags.map((value) => String(value)).join(', ');
  }

  const categories = getPath(item, 'categories');
  if (Array.isArray(categories) && categories.length) {
    raw.wp_categories = categories.map((value) => String(value)).join(', ');
  }

  // Generic scalar fields from JSON feeds
  const reserved = new Set([
    'id',
    'guid',
    'title',
    'description',
    'summary',
    'content',
    'link',
    'url',
    'author',
    'image',
    'image_url',
    'imageUrl',
    'categories',
    'tags'
  ]);

  for (const [key, value] of Object.entries(item || {})) {
    if (!/^[a-zA-Z_]\w{0,63}$/.test(key)) continue;
    if (reserved.has(key)) continue;
    if (value == null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      raw[key] = value;
    }
  }

  return raw;
};

const mapJsonFeedItem = (feed: FeedConfig, item: Record<string, unknown>): FeedItemResult => {
  const rawUrl =
    getPath(item, (feed.parseConfig?.linkPath as string) || 'link') ||
    getPath(item, 'url') ||
    getPath(item, 'link') ||
    getPath(item, 'external_url') ||
    getPath(item, 'permalink') ||
    getPath(item, 'guid.rendered') ||
    getPath(item, 'guid');

  const url =
    toTextLike(rawUrl) ||
    toTextLike(getPath(rawUrl as Record<string, unknown>, 'url')) ||
    toTextLike(getPath(rawUrl as Record<string, unknown>, 'href'));

  const guidRaw = getPath(item, 'id') || getPath(item, 'guid') || url;

  const title =
    toTextLike(getPath(item, (feed.parseConfig?.titlePath as string) || 'title')) ||
    toTextLike(getPath(item, 'title.rendered'));

  const description = firstTextLike(
    getPath(item, (feed.parseConfig?.descriptionPath as string) || 'description'),
    getPath(item, 'excerpt.rendered'),
    getPath(item, 'excerpt'),
    getPath(item, 'summary'),
    getPath(item, 'content_text'),
    getPath(item, 'content.rendered'),
    getPath(item, 'content_html'),
    getPath(item, 'content')
  );

  const content = firstTextLike(
    getPath(item, 'content.rendered'),
    getPath(item, 'content'),
    getPath(item, 'content_html'),
    getPath(item, 'content_text'),
    description
  );

  const imageCandidate = pickFirstUrl(
    toTextLike(getPath(item, (feed.parseConfig?.imagePath as string) || 'image')),
    toTextLike(getPath(item, 'image_url')),
    toTextLike(getPath(item, 'imageUrl')),
    toTextLike(getPath(item, 'image.url')),
    toTextLike(getPath(item, 'image.href')),
    toTextLike(getPath(item, 'thumbnail')),
    toTextLike(getPath(item, 'thumbnail_url')),
    toTextLike(getPath(item, 'featured_image')),
    toTextLike(getPath(item, 'banner_image')),
    toTextLike(getPath(item, 'yoast_head_json.og_image[0].url')),
    pickWordPressFeaturedImageUrl(item)
  );
  const wordpressFeaturedMedia = getWordPressFeaturedMedia(item);
  const wordpressFeaturedMediaSourceUrl = isWordPressFeaturedMediaImage(wordpressFeaturedMedia)
    ? undefined
    : toTextLike(wordpressFeaturedMedia?.source_url);
  const mediaCandidate = pickFirstUrl(
    toTextLike(getPath(item, 'video_url')),
    toTextLike(getPath(item, 'videoUrl')),
    toTextLike(getPath(item, 'audio_url')),
    toTextLike(getPath(item, 'audioUrl')),
    toTextLike(getPath(item, 'document_url')),
    toTextLike(getPath(item, 'documentUrl')),
    toTextLike(getPath(item, 'media_url')),
    toTextLike(getPath(item, 'mediaUrl')),
    toTextLike(getPath(item, 'enclosure.url')),
    wordpressFeaturedMediaSourceUrl
  );
  const mediaMimeCandidate =
    toTextLike(getPath(item, 'mime_type')) ||
    toTextLike(getPath(item, 'mimeType')) ||
    toTextLike(getPath(item, '_embedded.wp:featuredmedia[0].mime_type')) ||
    toTextLike(getPath(item, 'enclosure.type'));
  const mediaFilenameCandidate =
    toTextLike(getPath(item, 'file_name')) ||
    toTextLike(getPath(item, 'filename')) ||
    toTextLike(getPath(item, 'slug')) ||
    toTextLike(getPath(item, 'title.rendered'));
  const normalizedMedia = normalizeFeedMedia({
    mediaUrl: mediaCandidate,
    mediaMime: mediaMimeCandidate,
    mediaFilename: mediaFilenameCandidate,
    imageUrl: imageCandidate
  });

  const publishedCandidate =
    toTextLike(getPath(item, 'date_published')) ||
    toTextLike(getPath(item, 'date')) ||
    toTextLike(getPath(item, 'pubDate')) ||
    toTextLike(getPath(item, 'publishedAt'));
  const published = parsePublishedAt(publishedCandidate);
  const rawData = extractJsonRawFields(item, {
    mediaUrl: normalizedMedia.mediaUrl || undefined,
    mediaKind: normalizedMedia.mediaKind,
    mediaMime: normalizedMedia.mediaMime || undefined,
    mediaFilename: normalizedMedia.mediaFilename || undefined,
    imageUrl: normalizedMedia.imageUrl || undefined
  });
  if (published.original) rawData.published_input = published.original;
  if (published.precision) rawData.published_precision = published.precision;

  return {
    guid: toStringValue(guidRaw) || `${feed.url}-${Date.now()}-${Math.random()}`,
    title,
    url: removeUtm(String(url || '')),
    description,
    content,
    author: toTextLike(getPath(item, 'author.name')) || toTextLike(getPath(item, 'author')),
    imageUrl: normalizedMedia.imageUrl || undefined,
    mediaUrl: normalizedMedia.mediaUrl || undefined,
    mediaKind: normalizedMedia.mediaKind || undefined,
    mediaMime: normalizedMedia.mediaMime || undefined,
    mediaFilename: normalizedMedia.mediaFilename || undefined,
    publishedAt: published.value || publishedCandidate,
    categories: Array.isArray(getPath(item, 'tags'))
      ? (getPath(item, 'tags') as unknown[]).map((value) => String(value))
      : Array.isArray(getPath(item, 'categories'))
        ? (getPath(item, 'categories') as unknown[]).map((value) => String(value))
        : [],
    raw: rawData
  };
};

const fetchRssItems = async (feed: FeedConfig): Promise<FeedItemResult[]> => {
  try {
    const data = await parser.parseURL(feed.url);
    const mapped = (data.items || []).map((item: Record<string, unknown>) => {
      const rssItem = item as Record<string, unknown> & {
        enclosure?: { url?: string };
        'media:content'?: { $?: { url?: string }; url?: string };
        categories?: unknown[];
      };
      const guidRaw = rssItem.guid || rssItem.id || rssItem.link;
      const guidValue = toStringValue(guidRaw) || `${feed.url}-${rssItem.title}-${Date.now()}`;
      const published = parseRssPublishedAt(rssItem.isoDate, rssItem.pubDate);
      const wpPostId = extractWordPressPostId(rssItem.guid, rssItem.link, guidRaw);
      const raw: Record<string, unknown> = {};
      if (wpPostId) raw.wp_post_id = wpPostId;
      if (published.original) raw.published_input = published.original;
      if (published.precision) raw.published_precision = published.precision;
      return {
        guid: guidValue,
        title: toStringValue(rssItem.title),
        url: removeUtm(toStringValue(rssItem.link) || ''),
        description: firstTextLike(
          rssItem.description,
          rssItem.summary,
          rssItem.contentSnippet,
          rssItem.content,
          rssItem['content:encoded']
        ),
        content: firstTextLike(
          rssItem['content:encoded'],
          rssItem.content,
          rssItem.description,
          rssItem.summary,
          rssItem.contentSnippet
        ),
        author: toStringValue(rssItem.creator || rssItem.author || rssItem['dc:creator']),
        ...(() => {
          const explicitImageCandidate = undefined;
          const normalizedMedia = normalizeFeedMedia({
            mediaUrl: toStringValue(rssItem.enclosure?.url || rssItem['media:content']?.$?.url || rssItem['media:content']?.url),
            mediaMime: toStringValue((rssItem.enclosure as { type?: string } | undefined)?.type),
            mediaFilename: toStringValue(rssItem.title),
            imageUrl: explicitImageCandidate
          });
          if (normalizedMedia.mediaUrl) raw.media_url = normalizedMedia.mediaUrl;
          if (normalizedMedia.mediaKind) raw.media_kind = normalizedMedia.mediaKind;
          if (normalizedMedia.mediaMime) raw.media_mime = normalizedMedia.mediaMime;
          if (normalizedMedia.mediaFilename) raw.media_filename = normalizedMedia.mediaFilename;
          return {
            imageUrl: normalizedMedia.imageUrl || undefined,
            mediaUrl: normalizedMedia.mediaUrl || undefined,
            mediaKind: normalizedMedia.mediaKind || undefined,
            mediaMime: normalizedMedia.mediaMime || undefined,
            mediaFilename: normalizedMedia.mediaFilename || undefined
          };
        })(),
        publishedAt: published.value || toStringValue(rssItem.pubDate || rssItem.isoDate),
        categories: Array.isArray(rssItem.categories) ? rssItem.categories.map((value) => String(value)) : [],
        raw
      };
    });
    return enrichWordPressRssPublishedAt(feed.url, mapped);
  } catch (error) {
    console.error(`Error fetching RSS feed ${feed.url}:`, error instanceof Error ? error.message : String(error));
    throw error;
  }
};

const fetchRssItemsWithMeta = async (feed: FeedConfig): Promise<{ items: FeedItemResult[]; meta: FetchMeta }> => {
  await assertSafeOutboundUrl(feed.url);
  const headers: Record<string, string> = {};
  if (feed.etag) headers['If-None-Match'] = String(feed.etag);
  if (feed.last_modified) headers['If-Modified-Since'] = String(feed.last_modified);
  headers['User-Agent'] = DEFAULT_USER_AGENT;
  headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8';

  const response = await safeAxiosRequest(feed.url, {
    timeout: 20000,
    headers,
    responseType: 'arraybuffer', // CRITICAL: Get raw bytes to handle encoding manually
    validateStatus: (status: number) => (status >= 200 && status < 300) || status === 304
  });

  const meta: FetchMeta = {
    status: response.status,
    etag: response.headers?.etag,
    lastModified: response.headers?.['last-modified'],
    notModified: response.status === 304,
    contentType: getHeaderText(response.headers, 'content-type')
  };

  if (response.status === 304) {
    return { items: [], meta };
  }

  // Convert buffer to string, handling encoding if possible
  const buffer = response.data;
  const decoder = new TextDecoder('utf-8'); // Default to utf-8
  const xmlString = decoder.decode(buffer);

  if (looksLikeJsonPayload(String(meta.contentType || ''), xmlString)) {
    try {
      const json = JSON.parse(xmlString);
      const itemsPath = (feed.parseConfig?.itemsPath as string) || 'items';
      const items = extractJsonItemsArray(json, itemsPath);
      return {
        items: (items as Record<string, unknown>[]).map((item) => mapJsonFeedItem(feed, item)),
        meta: { ...meta, detectedType: 'json' }
      };
    } catch {
      // Fall through to XML parsing so malformed JSON still reports the real parse failure.
    }
  }

  const data = await parser.parseString(xmlString);
  const items = (data.items || []).map((item: Record<string, unknown>) => {
    const rssItem = item as Record<string, unknown> & {
      enclosure?: { url?: string };
      'media:content'?: { $?: { url?: string }; url?: string };
      'media:thumbnail'?: { $?: { url?: string }; url?: string };
      'itunes:image'?: { href?: string; url?: string };
      image?: { url?: string; href?: string } | string;
      categories?: unknown[];
    };
    const guidRaw = rssItem.guid || rssItem.id || rssItem.link;
    const guidValue = toStringValue(guidRaw) || `${feed.url}-${rssItem.title}-${Date.now()}`;
    const published = parseRssPublishedAt(rssItem.isoDate, rssItem.pubDate);
    const wpPostId = extractWordPressPostId(rssItem.guid, rssItem.link, guidRaw);
    const raw: Record<string, unknown> = {};
    if (wpPostId) raw.wp_post_id = wpPostId;
    if (published.original) raw.published_input = published.original;
    if (published.precision) raw.published_precision = published.precision;
    const htmlImage = pickFirstUrl(
      extractFirstImageFromHtml(toStringValue(rssItem['content:encoded']), feed.url),
      extractFirstImageFromHtml(toStringValue(rssItem.content), feed.url),
      extractFirstImageFromHtml(toStringValue(rssItem.description), feed.url),
      extractFirstImageFromHtml(toStringValue(rssItem.summary), feed.url),
      extractFirstImageFromHtml(toStringValue(rssItem.contentSnippet), feed.url)
    );
    const explicitImageCandidate = pickFirstUrl(
      htmlImage,
      toStringValue(rssItem['media:thumbnail']?.$?.url || rssItem['media:thumbnail']?.url),
      toStringValue(rssItem['itunes:image']?.href || rssItem['itunes:image']?.url),
      toStringValue((rssItem.image as { url?: string })?.url || (rssItem.image as { href?: string })?.href),
      toStringValue(typeof rssItem.image === 'string' ? rssItem.image : undefined)
    );
    const mediaCandidate = pickFirstUrl(
      toStringValue(rssItem.enclosure?.url),
      toStringValue(rssItem['media:content']?.$?.url || rssItem['media:content']?.url)
    );
    const normalizedMedia = normalizeFeedMedia({
      mediaUrl: mediaCandidate,
      mediaMime: toStringValue((rssItem.enclosure as { type?: string } | undefined)?.type),
      mediaFilename: toStringValue(rssItem.title),
      imageUrl: explicitImageCandidate
    });
    if (normalizedMedia.mediaUrl) raw.media_url = normalizedMedia.mediaUrl;
    if (normalizedMedia.mediaKind) raw.media_kind = normalizedMedia.mediaKind;
    if (normalizedMedia.mediaMime) raw.media_mime = normalizedMedia.mediaMime;
    if (normalizedMedia.mediaFilename) raw.media_filename = normalizedMedia.mediaFilename;
    return {
      guid: guidValue,
      title: toStringValue(rssItem.title),
      url: removeUtm(toStringValue(rssItem.link) || ''),
      description: firstTextLike(
        rssItem.description,
        rssItem.summary,
        rssItem.contentSnippet,
        rssItem.content,
        rssItem['content:encoded']
      ),
      content: firstTextLike(
        rssItem['content:encoded'],
        rssItem.content,
        rssItem.description,
        rssItem.summary,
        rssItem.contentSnippet
      ),
      author: toStringValue(rssItem.creator || rssItem.author || rssItem['dc:creator']),
      imageUrl: normalizedMedia.imageUrl || undefined,
      mediaUrl: normalizedMedia.mediaUrl || undefined,
      mediaKind: normalizedMedia.mediaKind || undefined,
      mediaMime: normalizedMedia.mediaMime || undefined,
      mediaFilename: normalizedMedia.mediaFilename || undefined,
      publishedAt: published.value || toStringValue(rssItem.pubDate || rssItem.isoDate),
      categories: Array.isArray(rssItem.categories) ? rssItem.categories.map((value) => String(value)) : [],
      raw
    };
  });

  const enrichedItems = await enrichWordPressRssPublishedAt(feed.url, items);
  return { items: enrichedItems, meta };
};

const fetchJsonItems = async (feed: FeedConfig): Promise<FeedItemResult[]> => {
  try {
    await assertSafeOutboundUrl(feed.url);
    const response = await safeAxiosRequest(feed.url, { timeout: 15000 });
    const json = response.data;
    const itemsPath = (feed.parseConfig?.itemsPath as string) || 'items';
    const itemsRaw = getPath(json as Record<string, unknown>, itemsPath);
    const items = Array.isArray(itemsRaw) ? itemsRaw : [];
    return (items as Record<string, unknown>[]).map((item) => mapJsonFeedItem(feed, item));
  } catch (error) {
    console.error(`Error fetching JSON feed ${feed.url}:`, error instanceof Error ? error.message : String(error));
    throw error;
  }
};

const fetchJsonItemsWithMeta = async (feed: FeedConfig): Promise<{ items: FeedItemResult[]; meta: FetchMeta }> => {
  await assertSafeOutboundUrl(feed.url);
  const headers: Record<string, string> = {};
  if (feed.etag) headers['If-None-Match'] = String(feed.etag);
  if (feed.last_modified) headers['If-Modified-Since'] = String(feed.last_modified);
  headers['User-Agent'] = DEFAULT_USER_AGENT;
  headers['Accept'] = 'application/json, text/json, */*;q=0.8';

  const response = await safeAxiosRequest(feed.url, {
    timeout: 15000,
    headers,
    params: /\/wp-json\/wp\/v2\//i.test(feed.url) ? { _embed: 'wp:featuredmedia' } : undefined,
    validateStatus: (status: number) => (status >= 200 && status < 300) || status === 304
  });

  const meta: FetchMeta = {
    status: response.status,
    etag: response.headers?.etag,
    lastModified: response.headers?.['last-modified'],
    notModified: response.status === 304,
    contentType: response.headers?.['content-type']
  };

  if (response.status === 304) {
    return { items: [], meta };
  }

  const json = response.data;
  const itemsPath = (feed.parseConfig?.itemsPath as string) || 'items';
  const items = extractJsonItemsArray(json, itemsPath);
  const mapped = (items as Record<string, unknown>[]).map((item) => mapJsonFeedItem(feed, item));

  return { items: mapped, meta };
};

const fetchFeedItemsWithMeta = async (feed: FeedConfig): Promise<{ items: FeedItemResult[]; meta: FetchMeta }> => {
  const start = Date.now();
  let sourceFeed = { ...feed };
  let discoveredFromHtmlUrl: string | null = null;

  // If user explicitly picked HTML, treat this URL as a web page and discover
  // the real feed endpoint first (RSS/Atom/JSON).
  if (feed.type === 'html') {
    try {
      const discovered = await discoverFeedEndpointFromHtml(feed.url);
      if (discovered?.url) {
        discoveredFromHtmlUrl = feed.url;
        sourceFeed = {
          ...feed,
          url: discovered.url,
          ...(discovered.type ? { type: discovered.type } : {})
        };
      }
    } catch {
      // Keep original URL if discovery fails; fallback logic below still applies.
    }
  }

  const tryFetch = async (kind: 'json' | 'xml', sourceFeed: FeedConfig = feed) => {
    if (kind === 'json') {
      return fetchJsonItemsWithMeta({ ...sourceFeed, type: 'json' });
    }
    return fetchRssItemsWithMeta({
      ...sourceFeed,
      type: sourceFeed.type === 'atom' ? 'atom' : 'rss'
    });
  };

  const preferred: 'json' | 'xml' = sourceFeed.type === 'json' ? 'json' : 'xml';
  const fallback: 'json' | 'xml' = preferred === 'json' ? 'xml' : 'json';

  let items: FeedItemResult[] = [];
  let meta: FetchMeta = {};
  let detectedType: FetchMeta['detectedType'] = sourceFeed.type || (preferred === 'json' ? 'json' : 'rss');

  try {
    const result = await tryFetch(preferred, sourceFeed);
    items = result.items;
    meta = result.meta;
    detectedType = result.meta?.detectedType || (
      preferred === 'json' ? 'json' : sourceFeed.type === 'atom' ? 'atom' : 'rss'
    );

    if (!meta?.notModified && (!items || items.length === 0)) {
      try {
        const alt = await tryFetch(fallback, sourceFeed);
        if (alt?.items?.length) {
          items = alt.items;
          meta = alt.meta;
          detectedType = alt.meta?.detectedType || (fallback === 'json' ? 'json' : 'rss');
        }
      } catch {
        // ignore fallback errors
      }
    }
  } catch (error) {
    const alt = await tryFetch(fallback, sourceFeed);
    items = alt.items;
    meta = alt.meta;
    detectedType = alt.meta?.detectedType || (fallback === 'json' ? 'json' : 'rss');
  }

  // Last fallback: if the URL is an HTML page, auto-discover its feed endpoint and retry.
  if (!meta?.notModified && (!items || items.length === 0)) {
    try {
      const discovered = await discoverFeedEndpointFromHtml(feed.url);
      if (discovered?.url) {
        const resolvedDiscoveredType = discovered.type || feed.type;
        const discoveredFeed: FeedConfig = {
          ...feed,
          url: discovered.url,
          ...(resolvedDiscoveredType ? { type: resolvedDiscoveredType } : {})
        };
        const discoveredPreferred: 'json' | 'xml' = discoveredFeed.type === 'json' ? 'json' : 'xml';
        const discoveredFallback: 'json' | 'xml' = discoveredPreferred === 'json' ? 'xml' : 'json';

        try {
          const discoveredResult = await tryFetch(discoveredPreferred, discoveredFeed);
          items = discoveredResult.items;
          meta = {
            ...discoveredResult.meta,
            sourceUrl: discovered.url,
            discoveredFromUrl: feed.url
          };
          detectedType = discoveredResult.meta?.detectedType || (
            discoveredPreferred === 'json'
              ? 'json'
              : discoveredFeed.type === 'atom'
                ? 'atom'
                : 'rss'
          );

          if (!meta?.notModified && (!items || items.length === 0)) {
            const discoveredAlt = await tryFetch(discoveredFallback, discoveredFeed);
            if (discoveredAlt?.items?.length) {
              items = discoveredAlt.items;
              meta = {
                ...discoveredAlt.meta,
                sourceUrl: discovered.url,
                discoveredFromUrl: feed.url
              };
              detectedType = discoveredAlt.meta?.detectedType || (discoveredFallback === 'json' ? 'json' : 'rss');
            }
          }
        } catch {
          const discoveredAlt = await tryFetch(discoveredFallback, discoveredFeed);
          items = discoveredAlt.items;
          meta = {
            ...discoveredAlt.meta,
            sourceUrl: discovered.url,
            discoveredFromUrl: feed.url
          };
          detectedType = discoveredAlt.meta?.detectedType || (discoveredFallback === 'json' ? 'json' : 'rss');
        }
      }
    } catch {
      // Keep original result if discovery fails.
    }
  }

  // Default cleaning options - always strip UTM and decode HTML entities
  const cleaning = feed.cleaning || { stripUtm: true, decodeEntities: true };
  const cleaned = items
    .filter((item) => item.title || item.url)
    .map((item: FeedItemResult) => {
      const cleanedTitle = applyCleaning(item.title || '', cleaning);
      const cleanedDescription = applyCleaning(item.description || '', cleaning);
      const cleanedContent = applyCleaning(item.content || '', cleaning);
      const cleanedUrl = cleaning?.stripUtm && item.url ? removeUtm(item.url) : item.url;
      const cleanedImageUrl =
        cleaning?.stripUtm && item.imageUrl ? removeUtm(item.imageUrl) : item.imageUrl;
      const cleanedMediaUrl =
        cleaning?.stripUtm && item.mediaUrl ? removeUtm(item.mediaUrl) : item.mediaUrl;
      return {
        ...item,
        title: cleanedTitle || 'Untitled',
        description: cleanedDescription,
        content: cleanedContent,
        url: cleanedUrl,
        imageUrl: cleanedImageUrl,
        mediaUrl: cleanedMediaUrl
      };
    });
  const discoveredFromUrl = meta?.discoveredFromUrl || discoveredFromHtmlUrl;

  return {
    items: cleaned,
    meta: {
      ...meta,
      sourceUrl: meta?.sourceUrl || sourceFeed.url,
      ...(discoveredFromUrl ? { discoveredFromUrl } : {}),
      detectedType,
      durationMs: Date.now() - start
    }
  };
};

const fetchFeedItems = async (feed: FeedConfig): Promise<FeedItemResult[]> => {
  try {
    const { items } = await fetchFeedItemsWithMeta(feed);
    return items;
  } catch (error) {
    console.error(`Error fetching feed items from ${feed.url}:`, error instanceof Error ? error.message : String(error));
    return [];
  }
};

module.exports = {
  fetchFeedItems,
  fetchFeedItemsWithMeta,
  removeUtm,
  applyCleaning,
  stripHtml
};
export { };
