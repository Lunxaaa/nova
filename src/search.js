import { load as loadHtml } from 'cheerio';

const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function makeCacheKey(query) {
  return query.trim().toLowerCase();
}

function setCache(query, data) {
  const key = makeCacheKey(query);
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

function getCache(query) {
  const key = makeCacheKey(query);
  const cached = cache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expires) {
    cache.delete(key);
    return null;
  }
  return cached.data;
}

function sanitizeText(text) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

function absoluteUrl(href) {
  if (!href) return '';
  if (href.startsWith('http')) return href;
  return `https://duckduckgo.com${href}`;
}

export async function searchWeb(query, limit = 3) {
  if (!query?.trim()) return [];
  const cached = getCache(query);
  if (cached) return cached;

  const params = new URLSearchParams({ q: query, kl: 'us-en' });
  const response = await fetch(`https://duckduckgo.com/html/?${params.toString()}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      Accept: 'text/html',
    },
  });

  if (!response.ok) {
    console.warn(`[search] DuckDuckGo request failed with status ${response.status}`);
    return [];
  }

  const html = await response.text();
  const $ = loadHtml(html);
  const results = [];

  $('.result').each((_, el) => {
    if (results.length >= limit) return false;
    const title = sanitizeText($(el).find('.result__title').text());
    const href = absoluteUrl($(el).find('.result__url').attr('href'));
    const snippet = sanitizeText($(el).find('.result__snippet').text());
    if (title && href) {
      results.push({ title, url: href, snippet });
    }
    return undefined;
  });

  setCache(query, results);
  return results;
}
