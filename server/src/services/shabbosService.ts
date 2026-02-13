const axios = require('axios');
const logger = require('../utils/logger');
const settingsService = require('./settingsService');
const { getErrorMessage } = require('../utils/errorUtils');

type ShabbosLocation = {
  latitude: number;
  longitude: number;
  tzid: string;
  city?: string;
};

type ShabbosPeriod = {
  start: Date;
  end: Date;
  type: 'shabbos' | 'yomtov';
  title: string;
};

// Cache for Shabbos times to avoid repeated API calls
let shabbosCache: {
  data: ShabbosPeriod[] | null;
  fetchedAt: number | null;
  location: string | null;
} = {
  data: null,
  fetchedAt: null,
  location: null
};

const CACHE_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours

// Default location (New York)
const DEFAULT_LOCATION: ShabbosLocation = {
  latitude: 40.7128,
  longitude: -74.006,
  tzid: 'America/New_York',
  city: 'New York'
};

/**
 * Fetch Shabbos/Yom Tov times from HebCal API
 */
const fetchShabbosTimesFromHebcal = async (
  location: ShabbosLocation = DEFAULT_LOCATION,
  candleLightingMins: number = 18,
  havdalahMins: number = 50
) => {
  try {
    const now = new Date();
    const startDate = now.toISOString().split('T')[0] || now.toISOString();
    const endDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] ||
      new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

    const params = new URLSearchParams({
      cfg: 'json',
      v: '1',
      maj: 'on',       // Major holidays
      min: 'off',      // Minor holidays (off)
      mod: 'off',      // Modern holidays (off)
      nx: 'off',       // Rosh Chodesh
      ss: 'on',        // Special Shabbatot
      mf: 'off',       // Minor fasts
      c: 'on',         // Candle lighting
      b: String(candleLightingMins),
      M: 'on',         // Havdalah
      m: String(havdalahMins),
      geo: 'pos',
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      tzid: location.tzid,
      start: startDate,
      end: endDate // 2 weeks ahead
    });

    const response = await axios.get(`https://www.hebcal.com/hebcal?${params}`);
    return response.data;
  } catch (error) {
    logger.error({ error }, 'Failed to fetch Shabbos times from HebCal');
    return null;
  }
};

/**
 * Parse HebCal response to get upcoming Shabbos/Yom Tov periods
 */
const parseShabbosTimesFromHebcal = (data: { items?: Array<{ category?: string; date?: string; title?: string }> }) => {
  if (!data || !data.items) return [];
  
  const periods: ShabbosPeriod[] = [];
  let currentStart: Date | null = null;
  let currentCategory: 'shabbos' | 'yomtov' | null = null;

  // Sort items by date
  const sortedItems = [...data.items].sort((a, b) => {
    const aTime = a.date ? new Date(a.date).getTime() : 0;
    const bTime = b.date ? new Date(b.date).getTime() : 0;
    return aTime - bTime;
  });

  for (const item of sortedItems) {
    if (item.category === 'candles') {
      // Start of Shabbos or Yom Tov
      if (!item.date) continue;
      currentStart = new Date(item.date);
      const title = String(item.title || '').toLowerCase();
      if (title.includes('shabbos') || title.includes('shabbat')) {
        currentCategory = 'shabbos';
      } else {
        // Hebcal candle titles are usually generic; use Friday as Shabbos, other days as Yom Tov.
        currentCategory = currentStart.getDay() === 5 ? 'shabbos' : 'yomtov';
      }
    } else if (item.category === 'havdalah' && currentStart) {
      // End of Shabbos or Yom Tov
      if (!item.date) continue;
      if (!currentCategory) {
        currentCategory = 'shabbos';
      }
      periods.push({
        start: currentStart,
        end: new Date(item.date),
        type: currentCategory,
        title: item.title || ''
      });
      currentStart = null;
      currentCategory = null;
    }
  }

  return periods;
};

/**
 * Get cached or fresh Shabbos times
 */
const getShabbosTimesWithCache = async (
  location: ShabbosLocation = DEFAULT_LOCATION,
  candleLightingMins: number = 18,
  havdalahMins: number = 50
) => {
  const cacheKey = `${location.latitude},${location.longitude},${candleLightingMins},${havdalahMins}`;
  const now = Date.now();

  const fetchedAt = shabbosCache.fetchedAt;
  if (
    shabbosCache.data &&
    shabbosCache.location === cacheKey &&
    fetchedAt &&
    (now - fetchedAt) < CACHE_DURATION_MS
  ) {
    return shabbosCache.data;
  }

  const hebcalData = await fetchShabbosTimesFromHebcal(location, candleLightingMins, havdalahMins);
  if (hebcalData) {
    const periods = parseShabbosTimesFromHebcal(hebcalData);
    shabbosCache = {
      data: periods,
      fetchedAt: now,
      location: cacheKey
    };
    return periods;
  }

  return shabbosCache.data || [];
};

/**
 * Check if currently Shabbos or Yom Tov
 */
const isCurrentlyShabbos = async () => {
  try {
    const settings = await settingsService.getSettings();
    
    // Check if Shabbos mode is enabled
    if (!settings.shabbosMode?.enabled) {
      return { isShabbos: false, reason: 'Shabbos mode disabled' };
    }

    const location = settings.shabbosMode?.location || DEFAULT_LOCATION;
    const candleMins = settings.shabbosMode?.candleLightingMins ?? 18;
    const havdalahMins = settings.shabbosMode?.havdalahMins ?? 50;
    const periods = await getShabbosTimesWithCache(location, candleMins, havdalahMins);
    const now = new Date();

    for (const period of periods) {
      if (now >= period.start && now <= period.end) {
        return {
          isShabbos: true,
          type: period.type,
          endsAt: period.end,
          title: period.title,
          reason: `Currently ${period.type === 'shabbos' ? 'Shabbos' : 'Yom Tov'}`
        };
      }
    }

    const nextPeriod = periods.find(p => p.start > now);
    return {
      isShabbos: false,
      nextStart: nextPeriod?.start,
      nextShabbos: nextPeriod ? { start: nextPeriod.start, end: nextPeriod.end } : null,
      reason: 'Not currently Shabbos/Yom Tov'
    };
  } catch (error) {
    logger.error({ error: getErrorMessage(error) }, 'Error checking Shabbos status');
    return { isShabbos: false, reason: 'Error checking status', error: getErrorMessage(error) };
  }
};

/**
 * Get upcoming Shabbos times for display
 */
const getUpcomingShabbos = async (): Promise<ShabbosPeriod[]> => {
  try {
    const settings = await settingsService.getSettings();
    const location = settings.shabbosMode?.location || DEFAULT_LOCATION;
    const candleMins = settings.shabbosMode?.candleLightingMins ?? 18;
    const havdalahMins = settings.shabbosMode?.havdalahMins ?? 50;
    const periods = await getShabbosTimesWithCache(location, candleMins, havdalahMins);
    const now = new Date();
    
    // Return upcoming periods
    return periods.filter(p => p.end > now).slice(0, 5);
  } catch (error) {
    logger.error({ error: getErrorMessage(error) }, 'Error getting upcoming Shabbos times');
    return [];
  }
};

/**
 * Calculate time until next Shabbos ends (for queue processing)
 */
const getTimeUntilShabbosEnds = async (): Promise<number | null> => {
  const status = await isCurrentlyShabbos();
  if (!status.isShabbos || !status.endsAt) {
    return null;
  }
  return status.endsAt.getTime() - Date.now();
};

module.exports = {
  isCurrentlyShabbos,
  getUpcomingShabbos,
  getTimeUntilShabbosEnds,
  getShabbosTimesWithCache,
  DEFAULT_LOCATION
};
export {};
