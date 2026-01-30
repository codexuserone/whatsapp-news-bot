const Parser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const he = require('he');

const parser = new Parser({
  customFields: {
    item: ['media:content', 'content:encoded']
  }
});

const getFileExtension = (value = '') => value.split('?')[0].split('.').pop()?.toLowerCase();

const guessMediaType = (url = '') => {
  const extension = getFileExtension(url);
  if (!extension) return undefined;
  if (['mp4', 'mov', 'm4v', 'webm'].includes(extension)) return 'video';
  if (['mp3', 'm4a', 'aac', 'wav', 'ogg'].includes(extension)) return 'audio';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extension)) return 'image';
  return undefined;
};

const getPath = (obj, path) => {
  if (!path) return undefined;
  const parts = path.replace(/\[(\w+)\]/g, '.$1').split('.');
  return parts.reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
};

const stripHtml = (value = '') => {
  const $ = cheerio.load(value);
  return $.text();
};

const removeUtm = (url) => {
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

const escapeRegExp = (value = '') => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const applyCleaning = (value = '', cleaning) => {
  let output = value;
  if (cleaning?.decodeEntities) {
    output = he.decode(output);
  }
  output = stripHtml(output);
  (cleaning?.removePhrases || []).forEach((phrase) => {
    if (!phrase) return;
    output = output.replace(new RegExp(escapeRegExp(phrase), 'gi'), '').trim();
  });
  return output.trim();
};

const getLinkFromArray = (links) => {
  if (!Array.isArray(links)) return undefined;
  const alternate = links.find((link) => link.rel === 'alternate') || links.find((link) => link.type?.includes('text/html'));
  return alternate?.href || links[0]?.href;
};

const getItemLink = (item) => {
  if (!item) return undefined;
  if (typeof item.link === 'string') return item.link;
  if (Array.isArray(item.link)) return getLinkFromArray(item.link);
  if (item.link?.href) return item.link.href;
  if (Array.isArray(item.links)) return getLinkFromArray(item.links);
  return undefined;
};

const getItemContent = (item) => {
  if (item?.content && typeof item.content === 'object' && item.content.value) {
    return item.content.value;
  }
  return item?.content;
};

const normalizeEnclosure = (item) => {
  let enclosure = item?.enclosure;
  if (!enclosure && item?.['media:content']) {
    enclosure = Array.isArray(item['media:content']) ? item['media:content'][0] : item['media:content'];
    if (enclosure?.$) {
      enclosure = { ...enclosure.$, url: enclosure.$.url || enclosure.url };
    }
  }
  if (enclosure?.url) {
    return {
      url: enclosure.url,
      type: enclosure.type || enclosure.medium || enclosure.mimeType
    };
  }
  return null;
};

const sanitizeVariableValue = (value, cleaning, key) => {
  if (typeof value === 'string') {
    if (key && key.toLowerCase().includes('url')) {
      return cleaning?.stripUtm ? removeUtm(value) : value;
    }
    return applyCleaning(value, cleaning);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeVariableValue(entry, cleaning, key));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce((acc, [childKey, childValue]) => {
      acc[childKey] = sanitizeVariableValue(childValue, cleaning, childKey);
      return acc;
    }, {});
  }
  return value;
};

const buildVariables = (item, cleaning) => {
  if (!item || typeof item !== 'object') return {};
  return Object.entries(item).reduce((acc, [key, value]) => {
    acc[key] = sanitizeVariableValue(value, cleaning, key);
    return acc;
  }, {});
};

const fetchRssItems = async (feed) => {
  const data = await parser.parseURL(feed.url);
  return (data.items || []).map((item) => {
    const media = normalizeEnclosure(item);
    const mediaType = media?.type || guessMediaType(media?.url);
    const imageUrl = mediaType?.startsWith?.('image') ? media?.url : item['media:content']?.url;
    return {
      title: item.title,
      url: getItemLink(item),
      description: item.contentSnippet || getItemContent(item) || item['content:encoded'] || item.summary,
      imageUrl,
      media: media ? { ...media, type: mediaType } : null,
      publishedAt: item.isoDate || item.pubDate,
      variables: buildVariables(item, feed.cleaning)
    };
  });
};

const fetchJsonItems = async (feed) => {
  const response = await axios.get(feed.url, { timeout: 15000 });
  const json = response.data;
  const itemsPath = feed.parseConfig?.itemsPath || 'items';
  const items = getPath(json, itemsPath) || [];
  return items.map((item) => ({
    title: getPath(item, feed.parseConfig?.titlePath || 'title'),
    url: getPath(item, feed.parseConfig?.linkPath || 'link'),
    description: getPath(item, feed.parseConfig?.descriptionPath || 'description'),
    imageUrl: getPath(item, feed.parseConfig?.imagePath || 'image'),
    videoUrl: getPath(item, feed.parseConfig?.videoPath || 'videoUrl'),
    audioUrl: getPath(item, feed.parseConfig?.audioPath || 'audioUrl'),
    mediaType: getPath(item, feed.parseConfig?.mediaTypePath || 'mediaType'),
    publishedAt: getPath(item, 'date') || getPath(item, 'pubDate') || getPath(item, 'publishedAt'),
    variables: buildVariables(item, feed.cleaning)
  }));
};

const fetchFeedItems = async (feed) => {
  const items = feed.type === 'json' ? await fetchJsonItems(feed) : await fetchRssItems(feed);
  return items
    .filter((item) => item.title && item.url)
    .map((item) => {
      const cleanedTitle = applyCleaning(item.title, feed.cleaning);
      const cleanedDescription = applyCleaning(item.description || '', feed.cleaning);
      const cleanedUrl = feed.cleaning?.stripUtm ? removeUtm(item.url) : item.url;
      const cleanedImageUrl = item.imageUrl
        ? feed.cleaning?.stripUtm
          ? removeUtm(item.imageUrl)
          : item.imageUrl
        : undefined;
      const mediaUrl = item.media?.url || item.mediaUrl || item.imageUrl;
      const mediaType = item.media?.type || item.mediaType || guessMediaType(mediaUrl);
      const cleanedVideoUrl = item.videoUrl ? (feed.cleaning?.stripUtm ? removeUtm(item.videoUrl) : item.videoUrl) : undefined;
      const cleanedAudioUrl = item.audioUrl ? (feed.cleaning?.stripUtm ? removeUtm(item.audioUrl) : item.audioUrl) : undefined;
      const cleanedMediaUrl = mediaUrl ? (feed.cleaning?.stripUtm ? removeUtm(mediaUrl) : mediaUrl) : undefined;
      return {
        ...item,
        title: cleanedTitle,
        description: cleanedDescription,
        url: cleanedUrl,
        imageUrl: cleanedImageUrl,
        mediaUrl: cleanedMediaUrl,
        mediaType,
        videoUrl: cleanedVideoUrl || (mediaType?.startsWith?.('video') ? cleanedMediaUrl : undefined),
        audioUrl: cleanedAudioUrl || (mediaType?.startsWith?.('audio') ? cleanedMediaUrl : undefined),
        variables: {
          ...(item.variables || {}),
          title: cleanedTitle,
          description: cleanedDescription,
          url: cleanedUrl,
          imageUrl: cleanedImageUrl,
          mediaUrl: cleanedMediaUrl,
          mediaType,
          videoUrl: cleanedVideoUrl || (mediaType?.startsWith?.('video') ? cleanedMediaUrl : undefined),
          audioUrl: cleanedAudioUrl || (mediaType?.startsWith?.('audio') ? cleanedMediaUrl : undefined)
        }
      };
    });
};

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const findArrayCandidates = (root, maxDepth = 4) => {
  const queue = [{ value: root, path: '' }];
  const results = [];
  while (queue.length) {
    const { value, path } = queue.shift();
    if (Array.isArray(value)) {
      results.push({ path, value });
      continue;
    }
    if (isPlainObject(value)) {
      Object.entries(value).forEach(([key, child]) => {
        const nextPath = path ? `${path}.${key}` : key;
        if (nextPath.split('.').length <= maxDepth) {
          queue.push({ value: child, path: nextPath });
        }
      });
    }
  }
  return results;
};

const scoreItem = (item) => {
  if (!isPlainObject(item)) return 0;
  const keys = Object.keys(item).map((key) => key.toLowerCase());
  let score = 0;
  if (keys.some((key) => ['title', 'headline', 'name'].includes(key))) score += 2;
  if (keys.some((key) => ['link', 'url', 'permalink'].includes(key))) score += 2;
  if (keys.some((key) => ['description', 'summary', 'content'].includes(key))) score += 1;
  if (keys.some((key) => ['image', 'imageurl', 'media', 'thumbnail'].includes(key))) score += 1;
  return score;
};

const findBestItemsArray = (root) => {
  const candidates = findArrayCandidates(root);
  let best = null;
  candidates.forEach((candidate) => {
    const sample = candidate.value.find((entry) => isPlainObject(entry));
    const score = scoreItem(sample || {});
    if (score > 0 && (!best || score > best.score)) {
      best = { path: candidate.path, sample, score };
    }
  });
  return best;
};

const findKeyPath = (item, variants) => {
  if (!isPlainObject(item)) return undefined;
  const lowerMap = Object.keys(item).reduce((acc, key) => {
    acc[key.toLowerCase()] = key;
    return acc;
  }, {});
  for (const variant of variants) {
    const match = lowerMap[variant];
    if (match) return match;
  }
  return undefined;
};

const probeJsonFeed = async (url) => {
  const response = await axios.get(url, { timeout: 15000 });
  const json = response.data;
  const best = findBestItemsArray(json);
  const itemsPath = best?.path || 'items';
  const sample = best?.sample || (getPath(json, itemsPath) || [])[0] || {};
  return {
    itemsPath,
    titlePath: findKeyPath(sample, ['title', 'headline', 'name']),
    linkPath: findKeyPath(sample, ['link', 'url', 'permalink']),
    descriptionPath: findKeyPath(sample, ['description', 'summary', 'content']),
    imagePath: findKeyPath(sample, ['image', 'imageurl', 'thumbnail', 'media']),
    videoPath: findKeyPath(sample, ['video', 'videourl']),
    audioPath: findKeyPath(sample, ['audio', 'audiourl']),
    mediaTypePath: findKeyPath(sample, ['mediatype', 'type'])
  };
};

module.exports = {
  fetchFeedItems,
  removeUtm,
  applyCleaning,
  stripHtml,
  probeJsonFeed
};
