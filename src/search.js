import { load as loadHtml } from 'cheerio';
import { promises as fs } from 'fs';
import path from 'path';

const logFile = path.resolve('data', 'search.log');
const filterFile = path.resolve('data', 'filter.txt');

const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const FILTER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedFilters = { terms: [], expires: 0 };

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
  if (href.startsWith('http://') || href.startsWith('https://')) {
    return href;
  }
  return `https://duckduckgo.com${href}`;
}

async function loadBlockedTerms() {
  if (Date.now() < cachedFilters.expires) {
    return cachedFilters.terms;
  }
  try {
    const raw = await fs.readFile(filterFile, 'utf-8');
    const terms = raw
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line && !line.startsWith('#'));
    cachedFilters = { terms, expires: Date.now() + FILTER_CACHE_TTL_MS };
    return terms;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[search] Failed to read filter list:', error.message);
    }
    cachedFilters = { terms: [], expires: Date.now() + FILTER_CACHE_TTL_MS };
    return [];
  }
}

async function findBlockedTerm(query) {
  if (!query) return null;
  const lowered = query.toLowerCase();
  const terms = await loadBlockedTerms();
  return terms.find((term) => lowered.includes(term)) || null;
}

export async function detectFilteredPhrase(text) {
  return findBlockedTerm(text);
}

function createBlockedError(term) {
  const error = new Error('Search blocked by filter');
  error.code = 'SEARCH_BLOCKED';
  error.blockedTerm = term;
  return error;
}

function createSearchUnavailableError(reason) {
  const error = new Error(reason || 'Search network unavailable');
  error.code = 'SEARCH_NETWORK_UNAVAILABLE';
  return error;
}

function parseDuckDuckGoResults(html, limit) {
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

  return results;
}

export async function searchWeb(query, limit = 3) {
  if (!query?.trim()) {
    return { results: [], proxy: 'duckduckgo', fromCache: false };
  }

  const blockedTerm = await findBlockedTerm(query);
  if (blockedTerm) {
    throw createBlockedError(blockedTerm);
  }

  const cached = getCache(query);
  if (cached) {
    return { results: cached, proxy: 'duckduckgo-cache', fromCache: true };
  }

  const params = new URLSearchParams({ q: query, kl: 'us-en' });
  let response;
  try {
    response = await fetch(`https://duckduckgo.com/html/?${params.toString()}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'text/html',
      },
    });
  } catch (error) {
    console.warn('[search] DuckDuckGo request failed:', error.message);
    throw createSearchUnavailableError('DuckDuckGo request failed');
  }

  if (!response.ok) {
    console.warn(`[search] DuckDuckGo request failed with status ${response.status}`);
    throw createSearchUnavailableError(`DuckDuckGo response ${response.status}`);
  }

  const html = await response.text();
  const results = parseDuckDuckGoResults(html, limit);

  setCache(query, results);
  return { results, proxy: 'duckduckgo', fromCache: false };
}

export async function appendSearchLog({ userId, query, results, proxy }) {
  try {
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    const timestamp = new Date().toISOString();
    const proxyTag = proxy || 'duckduckgo';
    const lines = [
      `time=${timestamp} user=${userId} proxy=${proxyTag} query=${JSON.stringify(query)}`,
      ...results.map((entry, idx) => `  ${idx + 1}. ${entry.title} :: ${entry.url} :: ${entry.snippet}`),
      '',
    ];
    await fs.appendFile(logFile, `${lines.join('\n')}`);
  } catch (error) {
    console.warn('[search] failed to append log', error);
  }
}
