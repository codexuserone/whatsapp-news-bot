const Parser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const he = require('he');

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

const extractFirstImageFromHtml = (html?: string) => {
  if (!html) return undefined;
  try {
    const $ = cheerio.load(html);
    const src = $('img').first().attr('src');
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
  type?: 'rss' | 'atom' | 'json';
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
        categories?: unknown[];
      };
      const guidRaw = rssItem.guid || rssItem.id || rssItem.link;
      const guidValue = toStringValue(guidRaw) || `${feed.url}-${rssItem.title}-${Date.now()}`;
      return {
        guid: guidValue,
        title: toStringValue(rssItem.title),
        url: removeUtm(toStringValue(rssItem.link) || ''),
        description: toStringValue(rssItem.contentSnippet || rssItem.content || rssItem['content:encoded']),
        content: toStringValue(rssItem['content:encoded'] || rssItem.content || rssItem.contentSnippet),
        author: toStringValue(rssItem.creator || rssItem.author || rssItem['dc:creator']),
        imageUrl: toStringValue(
          rssItem.enclosure?.url || rssItem['media:content']?.$?.url || rssItem['media:content']?.url
        ),
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
    notModified: response.status === 304
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
    const htmlImage = extractFirstImageFromHtml(
      toStringValue(rssItem['content:encoded'] || rssItem.content || rssItem.contentSnippet)
    );
    const imageUrl = pickFirstUrl(
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
      url: removeUtm(toStringValue(rssItem.link) || ''),
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
    const response = await axios.get(feed.url, { timeout: 15000 });
    const json = response.data;
    const itemsPath = (feed.parseConfig?.itemsPath as string) || 'items';
    const itemsRaw = getPath(json as Record<string, unknown>, itemsPath);
    const items = Array.isArray(itemsRaw) ? itemsRaw : [];
    return (items as Record<string, unknown>[]).map((item) => {
      const url =
        getPath(item, (feed.parseConfig?.linkPath as string) || 'link') || getPath(item, 'url');
      const guidRaw = getPath(item, 'id') || getPath(item, 'guid') || url;
      return {
        guid: toStringValue(guidRaw) || `${feed.url}-${Date.now()}-${Math.random()}`,
        title: toStringValue(getPath(item, (feed.parseConfig?.titlePath as string) || 'title')),
        url: removeUtm(String(url || '')),
        description:
          toStringValue(getPath(item, (feed.parseConfig?.descriptionPath as string) || 'description')) ||
          toStringValue(getPath(item, 'summary')),
        content:
          toStringValue(getPath(item, 'content')) ||
          toStringValue(getPath(item, 'content_html')) ||
          toStringValue(getPath(item, 'content_text')),
        author:
          toStringValue(getPath(item, 'author')) || toStringValue(getPath(item, 'author.name')),
        imageUrl:
          toStringValue(getPath(item, (feed.parseConfig?.imagePath as string) || 'image')) ||
          toStringValue(getPath(item, 'banner_image')),
        publishedAt:
          toStringValue(getPath(item, 'date_published')) ||
          toStringValue(getPath(item, 'date')) ||
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
  const headers: Record<string, string> = {};
  if (feed.etag) headers['If-None-Match'] = String(feed.etag);
  if (feed.last_modified) headers['If-Modified-Since'] = String(feed.last_modified);
  headers['User-Agent'] = DEFAULT_USER_AGENT;
  headers['Accept'] = 'application/json, text/json, */*;q=0.8';

  const response = await axios.get(feed.url, {
    timeout: 15000,
    headers,
    validateStatus: (status: number) => (status >= 200 && status < 300) || status === 304
  });

  const meta: FetchMeta = {
    status: response.status,
    etag: response.headers?.etag,
    lastModified: response.headers?.['last-modified'],
    notModified: response.status === 304
  };

  if (response.status === 304) {
    return { items: [], meta };
  }

  const json = response.data;
  const itemsPath = (feed.parseConfig?.itemsPath as string) || 'items';
  const itemsRaw = getPath(json as Record<string, unknown>, itemsPath);
  const items = Array.isArray(itemsRaw) ? itemsRaw : [];
  const mapped = (items as Record<string, unknown>[]).map((item) => {
    const url =
      getPath(item, (feed.parseConfig?.linkPath as string) || 'link') || getPath(item, 'url');
    const guidRaw = getPath(item, 'id') || getPath(item, 'guid') || url;
    const imageCandidate = pickFirstUrl(
      toStringValue(getPath(item, (feed.parseConfig?.imagePath as string) || 'image')),
      toStringValue(getPath(item, 'image_url')),
      toStringValue(getPath(item, 'imageUrl')),
      toStringValue(getPath(item, 'image.url')),
      toStringValue(getPath(item, 'image.href')),
      toStringValue(getPath(item, 'thumbnail')),
      toStringValue(getPath(item, 'thumbnail_url')),
      toStringValue(getPath(item, 'featured_image')),
      toStringValue(getPath(item, 'banner_image'))
    );
    return {
      guid: toStringValue(guidRaw) || `${feed.url}-${Date.now()}-${Math.random()}`,
      title: toStringValue(getPath(item, (feed.parseConfig?.titlePath as string) || 'title')),
      url: removeUtm(String(url || '')),
      description:
        toStringValue(getPath(item, (feed.parseConfig?.descriptionPath as string) || 'description')) ||
        toStringValue(getPath(item, 'summary')),
      content:
        toStringValue(getPath(item, 'content')) ||
        toStringValue(getPath(item, 'content_html')) ||
        toStringValue(getPath(item, 'content_text')),
      author:
        toStringValue(getPath(item, 'author')) || toStringValue(getPath(item, 'author.name')),
      imageUrl: imageCandidate,
      publishedAt:
        toStringValue(getPath(item, 'date_published')) ||
        toStringValue(getPath(item, 'date')) ||
        toStringValue(getPath(item, 'pubDate')) ||
        toStringValue(getPath(item, 'publishedAt')),
      categories: (getPath(item, 'tags') as string[]) || (getPath(item, 'categories') as string[]) || []
    };
  });

  return { items: mapped, meta };
};

const fetchFeedItemsWithMeta = async (feed: FeedConfig): Promise<{ items: FeedItemResult[]; meta: FetchMeta }> => {
  const start = Date.now();
  const { items, meta } =
    feed.type === 'json' ? await fetchJsonItemsWithMeta(feed) : await fetchRssItemsWithMeta(feed);

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
    meta: { ...meta, durationMs: Date.now() - start }
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
