const Parser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const he = require('he');

const parser = new Parser({
  customFields: {
    item: ['media:content', 'content:encoded']
  }
});

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

const applyCleaning = (value = '', cleaning) => {
  let output = value;
  if (cleaning?.decodeEntities) {
    output = he.decode(output);
  }
  output = stripHtml(output);
  (cleaning?.removePhrases || []).forEach((phrase) => {
    if (!phrase) return;
    output = output.replace(new RegExp(phrase, 'gi'), '').trim();
  });
  return output.trim();
};

const fetchRssItems = async (feed) => {
  const data = await parser.parseURL(feed.url);
  return (data.items || []).map((item) => ({
    title: item.title,
    url: item.link,
    description: item.contentSnippet || item.content || item['content:encoded'],
    imageUrl: item.enclosure?.url || item['media:content']?.url,
    publishedAt: item.isoDate || item.pubDate
  }));
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
    publishedAt: getPath(item, 'date') || getPath(item, 'pubDate') || getPath(item, 'publishedAt')
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
      return {
        ...item,
        title: cleanedTitle,
        description: cleanedDescription,
        url: cleanedUrl
      };
    });
};

module.exports = {
  fetchFeedItems,
  removeUtm,
  applyCleaning,
  stripHtml
};
