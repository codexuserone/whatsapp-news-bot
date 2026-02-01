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
  try {
    const data = await parser.parseURL(feed.url);
    return (data.items || []).map((item) => ({
      guid: item.guid || item.id || item.link || `${feed.url}-${item.title}-${Date.now()}`,
      title: item.title,
      url: item.link,
      description: item.contentSnippet || item.content || item['content:encoded'],
      content: item['content:encoded'] || item.content || item.contentSnippet,
      author: item.creator || item.author || item['dc:creator'],
      imageUrl: item.enclosure?.url || item['media:content']?.$.url || item['media:content']?.url,
      publishedAt: item.isoDate || item.pubDate,
      categories: item.categories || []
    }));
  } catch (error) {
    console.error(`Error fetching RSS feed ${feed.url}:`, error.message);
    throw error;
  }
};

const fetchJsonItems = async (feed) => {
  try {
    const response = await axios.get(feed.url, { timeout: 15000 });
    const json = response.data;
    const itemsPath = feed.parseConfig?.itemsPath || 'items';
    const items = getPath(json, itemsPath) || [];
    return items.map((item) => {
      const url = getPath(item, feed.parseConfig?.linkPath || 'link') || getPath(item, 'url');
      return {
        guid: getPath(item, 'id') || getPath(item, 'guid') || url || `${feed.url}-${Date.now()}-${Math.random()}`,
        title: getPath(item, feed.parseConfig?.titlePath || 'title'),
        url,
        description: getPath(item, feed.parseConfig?.descriptionPath || 'description') || getPath(item, 'summary'),
        content: getPath(item, 'content') || getPath(item, 'content_html') || getPath(item, 'content_text'),
        author: getPath(item, 'author') || getPath(item, 'author.name'),
        imageUrl: getPath(item, feed.parseConfig?.imagePath || 'image') || getPath(item, 'banner_image'),
        publishedAt: getPath(item, 'date_published') || getPath(item, 'date') || getPath(item, 'pubDate') || getPath(item, 'publishedAt'),
        categories: getPath(item, 'tags') || getPath(item, 'categories') || []
      };
    });
  } catch (error) {
    console.error(`Error fetching JSON feed ${feed.url}:`, error.message);
    throw error;
  }
};

const fetchFeedItems = async (feed) => {
  try {
    const items = feed.type === 'json' ? await fetchJsonItems(feed) : await fetchRssItems(feed);
    return items
      .filter((item) => item.title || item.url) // Allow items with at least title OR url
      .map((item) => {
        const cleanedTitle = applyCleaning(item.title || '', feed.cleaning);
        const cleanedDescription = applyCleaning(item.description || '', feed.cleaning);
        const cleanedContent = applyCleaning(item.content || '', feed.cleaning);
        const cleanedUrl = feed.cleaning?.stripUtm && item.url ? removeUtm(item.url) : item.url;
        return {
          ...item,
          title: cleanedTitle || 'Untitled',
          description: cleanedDescription,
          content: cleanedContent,
          url: cleanedUrl
        };
      });
  } catch (error) {
    console.error(`Error fetching feed items from ${feed.url}:`, error.message);
    return [];
  }
};

module.exports = {
  fetchFeedItems,
  removeUtm,
  applyCleaning,
  stripHtml
};
