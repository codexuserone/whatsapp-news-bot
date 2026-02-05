const Parser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const he = require('he');
const { assertSafeOutboundUrl } = require('../utils/outboundUrl');

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
  detectedType?: 'rss' | 'atom' | 'json';
  contentType?: string;
};

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; WhatsAppNewsBot/0.2; +https://example.invalid)';

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

const normalizeUrlCandidate = (candidate?: string | null, baseUrl?: string | null) => {
  const raw = String(candidate || '').trim();
  if (!raw) return undefined;

  if (raw.startsWith('//')) {
    const value = `https:${raw}`;
    return isValidUrl(value) ? value : undefined;
  }

  if (isValidUrl(raw)) return raw;
  if (!baseUrl || !isValidUrl(baseUrl)) return undefined;

  try {
    const resolved = new URL(raw, baseUrl).toString();
    return isValidUrl(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
};

const isDisallowedImageCandidate = (value?: string | null) => {
  if (!value) return true;
  const normalized = String(value).toLowerCase();
  return [
    '.mp4',
    '.mov',
    '.m4v',
    '.webm',
    '.avi',
    '.mkv',
    '.mp3',
    '.wav',
    '.m3u8'
  ].some((ext) => normalized.includes(ext));
};

const pickFirstUrl = (...candidates: Array<string | undefined | null>) => {
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? candidate.trim() : '';
    if (value && isValidUrl(value)) return value;
  }
  return undefined;
};

const pickFirstImageUrl = (baseUrl?: string | null, ...candidates: Array<string | undefined | null>) => {
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? candidate.trim() : '';
    if (!value) continue;
    const resolved = normalizeUrlCandidate(value, baseUrl);
    if (!resolved) continue;
    if (isDisallowedImageCandidate(resolved)) continue;
    return resolved;
  }
  return undefined;
};

const toRenderedTextValue = (value: unknown): string | undefined => {
  const direct = toTextValue(value);
  if (direct != null) return direct;
  if (value && typeof value === 'object') {
    const rendered = (value as Record<string, unknown>).rendered;
    const renderedText = toTextValue(rendered);
    if (renderedText != null) return renderedText;
  }
  return undefined;
};

const withWordPressEmbed = (url: string) => {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.includes('/wp-json/wp/v2/') && !parsed.searchParams.has('_embed')) {
      parsed.searchParams.set('_embed', '1');
    }
    return parsed.toString();
  } catch {
    return url;
  }
};

const pickFromSrcset = (srcset?: string | null) => {
  const value = String(srcset || '').trim();
  if (!value) return undefined;
  const entries = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(/\s+/)[0])
    .filter(Boolean);
  return entries.length ? entries[entries.length - 1] : undefined;
};

const extractFirstImageFromHtml = (html?: string, baseUrl?: string | null) => {
  if (!html) return undefined;
  try {
    const $ = cheerio.load(html);
    const img = $('img').first();
    const srcset = img.attr('data-srcset') || img.attr('srcset');
    const src =
      pickFromSrcset(srcset) ||
      img.attr('data-src') ||
      img.attr('data-lazy-src') ||
      img.attr('data-original') ||
      img.attr('src');
    return normalizeUrlCandidate(src, baseUrl);
  } catch {
    return undefined;
  }
};

type FeedCleaning = {
  stripUtm?: boolean;
  decodeEntities?: boolean;
  removePhrases?: string[];
  parse_config?: Record<string, unknown>;
};

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
  type?: 'rss' | 'atom' | 'json';
  parseConfig?: Record<string, unknown>;
  parse_config?: Record<string, unknown>;
  cleaning?: FeedCleaning;
  etag?: string | null;
  last_modified?: string | null;
};

const resolveParseConfig = (feed: FeedConfig): Record<string, unknown> => {
  const raw =
    (feed.parseConfig && typeof feed.parseConfig === 'object' ? feed.parseConfig : null) ||
    (feed.parse_config && typeof feed.parse_config === 'object' ? feed.parse_config : null) ||
    (feed.cleaning && typeof feed.cleaning === 'object'
      ? (feed.cleaning as { parse_config?: unknown }).parse_config
      : null);
  if (raw && typeof raw === 'object') {
    return raw as Record<string, unknown>;
  }
  return {} as Record<string, unknown>;
};

type FeedItemResult = {
  guid?: string | undefined;
  title?: string | undefined;
  url?: string | undefined;
  description?: string | undefined;
  content?: string | undefined;
  author?: string | undefined;
  imageUrl?: string | undefined;
  publishedAt?: string | Date | undefined;
  categories?: string[] | undefined;
  raw?: Record<string, unknown>;
};

const toStringValue = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  return String(value);
};

const fetchRssItems = async (feed: FeedConfig): Promise<FeedItemResult[]> => {
  try {
    const data = await parser.parseURL(feed.url);
    return (data.items || []).map((item: Record<string, unknown>) => {
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
      const link = removeUtm(toStringValue(rssItem.link) || '');
      const htmlImage = extractFirstImageFromHtml(
        toStringValue(rssItem['content:encoded'] || rssItem.content || rssItem.contentSnippet),
        link
      );
      const imageUrl = pickFirstImageUrl(
        link,
        toStringValue(rssItem.enclosure?.url),
        toStringValue(rssItem['media:content']?.$?.url || rssItem['media:content']?.url),
        toStringValue(rssItem['media:thumbnail']?.$?.url || rssItem['media:thumbnail']?.url),
        toStringValue(rssItem['itunes:image']?.href || rssItem['itunes:image']?.url),
        toStringValue((rssItem.image as { url?: string })?.url || (rssItem.image as { href?: string })?.href),
        toStringValue(typeof rssItem.image === 'string' ? rssItem.image : undefined),
        htmlImage
      );
      return {
        guid: guidValue,
        title: toStringValue(rssItem.title),
        url: link,
        description: toStringValue(rssItem.contentSnippet || rssItem.content || rssItem['content:encoded']),
        content: toStringValue(rssItem['content:encoded'] || rssItem.content || rssItem.contentSnippet),
        author: toStringValue(rssItem.creator || rssItem.author || rssItem['dc:creator']),
        imageUrl,
        publishedAt: toStringValue(rssItem.isoDate || rssItem.pubDate),
        categories: Array.isArray(rssItem.categories) ? rssItem.categories.map((value) => String(value)) : []
      };
    });
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
  headers['Accept'] = 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7';

  const response = await axios.get(feed.url, {
    timeout: 15000,
    headers,
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

  const data = await parser.parseString(String(response.data || ''));
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
    const link = removeUtm(toStringValue(rssItem.link) || '');
    const htmlImage = extractFirstImageFromHtml(
      toStringValue(rssItem['content:encoded'] || rssItem.content || rssItem.contentSnippet),
      link
    );
    const imageUrl = pickFirstImageUrl(
      link,
      toStringValue(rssItem.enclosure?.url),
      toStringValue(rssItem['media:content']?.$?.url || rssItem['media:content']?.url),
      toStringValue(rssItem['media:thumbnail']?.$?.url || rssItem['media:thumbnail']?.url),
      toStringValue(rssItem['itunes:image']?.href || rssItem['itunes:image']?.url),
      toStringValue((rssItem.image as { url?: string })?.url || (rssItem.image as { href?: string })?.href),
      toStringValue(typeof rssItem.image === 'string' ? rssItem.image : undefined),
      htmlImage
    );
    return {
      guid: guidValue,
      title: toStringValue(rssItem.title),
      url: link,
      description: toStringValue(rssItem.contentSnippet || rssItem.content || rssItem['content:encoded']),
      content: toStringValue(rssItem['content:encoded'] || rssItem.content || rssItem.contentSnippet),
      author: toStringValue(rssItem.creator || rssItem.author || rssItem['dc:creator']),
      imageUrl,
      publishedAt: toStringValue(rssItem.isoDate || rssItem.pubDate),
      categories: Array.isArray(rssItem.categories) ? rssItem.categories.map((value) => String(value)) : []
    };
  });

  return { items, meta };
};

const fetchJsonItems = async (feed: FeedConfig): Promise<FeedItemResult[]> => {
  try {
    const parseConfig = resolveParseConfig(feed);
    const requestUrl = withWordPressEmbed(feed.url);
    await assertSafeOutboundUrl(requestUrl);
    const response = await axios.get(requestUrl, { timeout: 15000 });
    const json = response.data;
    const itemsPath = (parseConfig?.itemsPath as string) || 'items';
    const items = extractJsonItemsArray(json, itemsPath);
    return (items as Record<string, unknown>[]).map((item) => {
      const rawUrl =
        getPath(item, (parseConfig?.linkPath as string) || 'link') ||
        getPath(item, 'url') ||
        getPath(item, 'link') ||
        getPath(item, 'external_url') ||
        getPath(item, 'permalink');
      const url =
        toTextValue(rawUrl) ||
        toTextValue(getPath(rawUrl as Record<string, unknown>, 'url')) ||
        toTextValue(getPath(rawUrl as Record<string, unknown>, 'href'));
      const guidRaw = getPath(item, 'id') || getPath(item, 'guid') || url;
      const contentCandidate =
        toRenderedTextValue(getPath(item, 'content.rendered')) ||
        toRenderedTextValue(getPath(item, 'content')) ||
        toRenderedTextValue(getPath(item, 'content_html')) ||
        toRenderedTextValue(getPath(item, 'content_text'));
      const descriptionCandidate =
        toRenderedTextValue(getPath(item, (parseConfig?.descriptionPath as string) || 'description')) ||
        toRenderedTextValue(getPath(item, 'excerpt.rendered')) ||
        toRenderedTextValue(getPath(item, 'summary')) ||
        contentCandidate;
      return {
        guid: toStringValue(guidRaw) || `${feed.url}-${Date.now()}-${Math.random()}`,
        title:
          toRenderedTextValue(getPath(item, (parseConfig?.titlePath as string) || 'title')) ||
          toRenderedTextValue(getPath(item, 'title.rendered')) ||
          toRenderedTextValue(getPath(item, 'name')),
        url: removeUtm(String(url || '')),
        description: descriptionCandidate,
        content: contentCandidate,
        author:
          toStringValue(getPath(item, 'author')) || toStringValue(getPath(item, 'author.name')),
        imageUrl: pickFirstImageUrl(
          url as string,
          toRenderedTextValue(getPath(item, (parseConfig?.imagePath as string) || 'image')),
          toRenderedTextValue(getPath(item, 'image_url')),
          toRenderedTextValue(getPath(item, 'imageUrl')),
          toRenderedTextValue(getPath(item, 'image.url')),
          toRenderedTextValue(getPath(item, 'image.href')),
          toRenderedTextValue(getPath(item, 'thumbnail')),
          toRenderedTextValue(getPath(item, 'thumbnail_url')),
          toRenderedTextValue(getPath(item, 'featured_image')),
          toRenderedTextValue(getPath(item, 'banner_image')),
          toRenderedTextValue(getPath(item, 'yoast_head_json.og_image[0].url')),
          toRenderedTextValue(getPath(item, '_embedded.wp:featuredmedia[0].media_details.sizes.full.source_url')),
          toRenderedTextValue(getPath(item, '_embedded.wp:featuredmedia[0].media_details.sizes.large.source_url')),
          toRenderedTextValue(getPath(item, '_embedded.wp:featuredmedia[0].source_url'))
        ),
        publishedAt:
          toStringValue(getPath(item, 'date_gmt')) ||
          toStringValue(getPath(item, 'date')) ||
          toStringValue(getPath(item, 'date_published')) ||
          toStringValue(getPath(item, 'pubDate')) ||
          toStringValue(getPath(item, 'publishedAt')),
        categories: (getPath(item, 'tags') as string[]) || (getPath(item, 'categories') as string[]) || []
      };
    });
  } catch (error) {
    console.error(`Error fetching JSON feed ${feed.url}:`, error instanceof Error ? error.message : String(error));
    throw error;
  }
};

const fetchJsonItemsWithMeta = async (feed: FeedConfig): Promise<{ items: FeedItemResult[]; meta: FetchMeta }> => {
  const parseConfig = resolveParseConfig(feed);
  const requestUrl = withWordPressEmbed(feed.url);
  await assertSafeOutboundUrl(requestUrl);
  const headers: Record<string, string> = {};
  if (feed.etag) headers['If-None-Match'] = String(feed.etag);
  if (feed.last_modified) headers['If-Modified-Since'] = String(feed.last_modified);
  headers['User-Agent'] = DEFAULT_USER_AGENT;
  headers['Accept'] = 'application/json, text/json, */*;q=0.8';

  const response = await axios.get(requestUrl, {
    timeout: 15000,
    headers,
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
  const itemsPath = (parseConfig?.itemsPath as string) || 'items';
  const items = extractJsonItemsArray(json, itemsPath);
  const mapped = (items as Record<string, unknown>[]).map((item) => {
    const rawUrl =
      getPath(item, (parseConfig?.linkPath as string) || 'link') ||
      getPath(item, 'url') ||
      getPath(item, 'link') ||
      getPath(item, 'external_url') ||
      getPath(item, 'permalink');
    const url =
      toTextValue(rawUrl) ||
      toTextValue(getPath(rawUrl as Record<string, unknown>, 'url')) ||
      toTextValue(getPath(rawUrl as Record<string, unknown>, 'href'));
    const guidRaw = getPath(item, 'id') || getPath(item, 'guid') || url;
    const imageCandidate = pickFirstImageUrl(
      url as string,
      toRenderedTextValue(getPath(item, (parseConfig?.imagePath as string) || 'image')),
      toRenderedTextValue(getPath(item, 'image_url')),
      toRenderedTextValue(getPath(item, 'imageUrl')),
      toRenderedTextValue(getPath(item, 'image.url')),
      toRenderedTextValue(getPath(item, 'image.href')),
      toRenderedTextValue(getPath(item, 'thumbnail')),
      toRenderedTextValue(getPath(item, 'thumbnail_url')),
      toRenderedTextValue(getPath(item, 'featured_image')),
      toRenderedTextValue(getPath(item, 'banner_image')),
      toRenderedTextValue(getPath(item, 'yoast_head_json.og_image[0].url')),
      toRenderedTextValue(getPath(item, '_embedded.wp:featuredmedia[0].media_details.sizes.full.source_url')),
      toRenderedTextValue(getPath(item, '_embedded.wp:featuredmedia[0].media_details.sizes.large.source_url')),
      toRenderedTextValue(getPath(item, '_embedded.wp:featuredmedia[0].source_url'))
    );
    const titleCandidate =
      toRenderedTextValue(getPath(item, (parseConfig?.titlePath as string) || 'title')) ||
      toRenderedTextValue(getPath(item, 'title.rendered')) ||
      toRenderedTextValue(getPath(item, 'name'));
    const descriptionCandidate =
      toRenderedTextValue(getPath(item, (parseConfig?.descriptionPath as string) || 'description')) ||
      toRenderedTextValue(getPath(item, 'excerpt.rendered')) ||
      toRenderedTextValue(getPath(item, 'summary'));
    const contentCandidate =
      toRenderedTextValue(getPath(item, 'content.rendered')) ||
      toRenderedTextValue(getPath(item, 'content')) ||
      toRenderedTextValue(getPath(item, 'content_html')) ||
      toRenderedTextValue(getPath(item, 'content_text'));
    const authorCandidate =
      toRenderedTextValue(getPath(item, '_embedded.author[0].name')) ||
      toRenderedTextValue(getPath(item, 'author.name')) ||
      toRenderedTextValue(getPath(item, 'author'));
    const wpId = toStringValue(getPath(item, 'id'));
    return {
      guid: toStringValue(guidRaw) || `${feed.url}-${Date.now()}-${Math.random()}`,
      title: titleCandidate || descriptionCandidate || contentCandidate,
      url: removeUtm(String(url || '')),
      description: descriptionCandidate || contentCandidate,
      content: contentCandidate,
      author: authorCandidate,
      imageUrl: imageCandidate,
      publishedAt:
        toTextValue(getPath(item, 'date_published')) ||
        toTextValue(getPath(item, 'date_gmt')) ||
        toTextValue(getPath(item, 'date')) ||
        toTextValue(getPath(item, 'pubDate')) ||
        toTextValue(getPath(item, 'publishedAt')),
      categories: Array.isArray(getPath(item, 'tags'))
        ? (getPath(item, 'tags') as unknown[]).map((value) => String(value))
        : Array.isArray(getPath(item, 'categories'))
          ? (getPath(item, 'categories') as unknown[]).map((value) => String(value))
          : [],
      raw: {
        ...(wpId ? { wp_id: wpId } : {}),
        wp_slug: toTextValue(getPath(item, 'slug')),
        wp_type: toTextValue(getPath(item, 'type')),
        wp_status: toTextValue(getPath(item, 'status')),
        wp_featured_media: toTextValue(getPath(item, 'featured_media')),
        wp_featured_image: imageCandidate
      }
    };
  });

  return { items: mapped, meta };
};

const fetchFeedItemsWithMeta = async (feed: FeedConfig): Promise<{ items: FeedItemResult[]; meta: FetchMeta }> => {
  const start = Date.now();

  const tryFetch = async (kind: 'json' | 'xml') => {
    if (kind === 'json') {
      return fetchJsonItemsWithMeta({ ...feed, type: 'json' });
    }
    return fetchRssItemsWithMeta({ ...feed, type: feed.type === 'atom' ? 'atom' : 'rss' });
  };

  const preferred: 'json' | 'xml' = feed.type === 'json' ? 'json' : 'xml';
  const fallback: 'json' | 'xml' = preferred === 'json' ? 'xml' : 'json';

  let items: FeedItemResult[] = [];
  let meta: FetchMeta = {};
  let detectedType: FetchMeta['detectedType'] = feed.type || (preferred === 'json' ? 'json' : 'rss');

  try {
    const result = await tryFetch(preferred);
    items = result.items;
    meta = result.meta;
    detectedType =
      preferred === 'json' ? 'json' : feed.type === 'atom' ? 'atom' : 'rss';

    if (!meta?.notModified && (!items || items.length === 0)) {
      try {
        const alt = await tryFetch(fallback);
        if (alt?.items?.length) {
          items = alt.items;
          meta = alt.meta;
          detectedType = fallback === 'json' ? 'json' : 'rss';
        }
      } catch {
        // ignore fallback errors
      }
    }
  } catch (error) {
    const alt = await tryFetch(fallback);
    items = alt.items;
    meta = alt.meta;
    detectedType = fallback === 'json' ? 'json' : 'rss';
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
      return {
        ...item,
        title: cleanedTitle || 'Untitled',
        description: cleanedDescription,
        content: cleanedContent,
        url: cleanedUrl,
        imageUrl: cleanedImageUrl
      };
    });

  return {
    items: cleaned,
    meta: { ...meta, detectedType, durationMs: Date.now() - start }
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
export {};
