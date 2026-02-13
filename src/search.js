import { load as loadHtml } from 'cheerio';
import { promises as fs } from 'fs';
import path from 'path';
import { ProxyAgent } from 'undici';
import { config } from './config.js';

const logFile = path.resolve('data', 'search.log');
const filterFile = path.resolve('data', 'filter.txt');

const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const FILTER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedFilters = { terms: [], expires: 0 };
let proxyPool = [];
let proxyPoolExpires = 0;
let proxyCursor = 0;

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

function createBlockedError(term) {
  const error = new Error('Search blocked by filter');
  error.code = 'SEARCH_BLOCKED';
  error.blockedTerm = term;
  return error;
}

function createProxyUnavailableError(reason) {
  const error = new Error(reason || 'Proxy network unavailable');
  error.code = 'SEARCH_PROXY_UNAVAILABLE';
  return error;
}

function parseProxyList(raw) {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function removeProxyFromPool(proxy) {
  if (!proxy) return;
  proxyPool = proxyPool.filter((entry) => entry !== proxy);
  if (!proxyPool.length) {
    proxyPoolExpires = 0;
    proxyCursor = 0;
  }
}

async function hydrateProxyPool() {
  if (!config.proxyScrapeEnabled) {
    proxyPool = [];
    proxyPoolExpires = 0;
    proxyCursor = 0;
    return;
  }
  const endpoint = config.proxyScrapeEndpoint;
  const response = await fetch(endpoint, {
    headers: {
      Accept: 'text/plain',
      'User-Agent': 'NovaBot/1.0 (+https://github.com/) ProxyScrape client',
    },
  });
  if (!response.ok) {
    throw createProxyUnavailableError(`Failed to fetch proxy list (HTTP ${response.status})`);
  }
  const text = await response.text();
  const proxies = parseProxyList(text);
  if (!proxies.length) {
    throw createProxyUnavailableError('Proxy list came back empty');
  }
  proxyPool = proxies;
  proxyPoolExpires = Date.now() + (config.proxyScrapeRefreshMs || 10 * 60 * 1000);
  proxyCursor = 0;
}

async function ensureProxyPool() {
  if (!config.proxyScrapeEnabled) return;
  if (proxyPool.length && Date.now() < proxyPoolExpires) {
    return;
  }
  await hydrateProxyPool();
}

async function getProxyInfo() {
  await ensureProxyPool();
  if (!config.proxyScrapeEnabled || !proxyPool.length) {
    return null;
  }
  const proxy = proxyPool[proxyCursor % proxyPool.length];
  proxyCursor = (proxyCursor + 1) % proxyPool.length;
  return {
    proxy,
    agent: new ProxyAgent(`http://${proxy}`),
  };
}

async function fetchDuckDuckGoHtml(url, headers) {
  const maxAttempts = config.proxyScrapeEnabled
    ? Math.max(1, config.proxyScrapeMaxAttempts || 5)
    : 1;
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let proxyInfo = null;
    try {
      const options = { headers };
      if (config.proxyScrapeEnabled) {
        proxyInfo = await getProxyInfo();
        if (!proxyInfo) {
          throw createProxyUnavailableError('No proxies available');
        }
        options.dispatcher = proxyInfo.agent;
      }
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`DuckDuckGo request failed (${response.status})`);
      }
      const html = await response.text();
      return {
        html,
        proxy: proxyInfo?.proxy || null,
      };
    } catch (error) {
      lastError = error;
      if (!config.proxyScrapeEnabled) {
        break;
      }
      if (proxyInfo?.proxy) {
        removeProxyFromPool(proxyInfo.proxy);
      }
    }
  }

  if (config.proxyScrapeEnabled) {
    throw createProxyUnavailableError(lastError?.message || 'All proxies failed');
  }
  throw lastError || new Error('DuckDuckGo fetch failed');
}

export async function searchWeb(query, limit = 3) {
  if (!query?.trim()) {
    return { results: [], proxy: null, fromCache: false };
  }
  const blockedTerm = await findBlockedTerm(query);
  if (blockedTerm) {
    throw createBlockedError(blockedTerm);
  }
  const cached = getCache(query);
  if (cached) {
    return { results: cached, proxy: 'cache', fromCache: true };
  }

  const params = new URLSearchParams({ q: query, kl: 'us-en' });
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    Accept: 'text/html',
  };

  let html;
  let proxyLabel = null;
  try {
    const { html: fetchedHtml, proxy } = await fetchDuckDuckGoHtml(`https://duckduckgo.com/html/?${params.toString()}`, headers);
    html = fetchedHtml;
    proxyLabel = config.proxyScrapeEnabled ? proxy || 'proxy-unknown' : 'direct';
  } catch (error) {
    if (error?.code === 'SEARCH_PROXY_UNAVAILABLE') {
      throw error;
    }
    console.warn('[search] DuckDuckGo request failed:', error);
    return { results: [], proxy: null, fromCache: false };
  }
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
  return { results, proxy: proxyLabel || (config.proxyScrapeEnabled ? 'proxy-unknown' : 'direct'), fromCache: false };
}

export async function appendSearchLog({ userId, query, results, proxy }) {
  try {
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    const timestamp = new Date().toISOString();
    const proxyTag = proxy || 'direct';
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
