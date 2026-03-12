const fs = require('fs');
const path = require('path');
require('dotenv').config();

const redisSession = require('./redis-session');

const REDIS_URL = process.env.REDIS_URL;
const SESSION_ID = process.env.SESSION_ID || 'perplexity01';

if (!REDIS_URL) {
  console.error('Missing REDIS_URL in .env');
  process.exit(1);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

function normalizeSameSite(value) {
  const raw = String(value || '').toLowerCase();
  if (raw === 'strict') return 'Strict';
  if (raw === 'none' || raw === 'no_restriction') return 'None';
  return 'Lax';
}

function normalizeExpires(cookie) {
  if (typeof cookie.expires === 'number') {
    return cookie.expires > 0 ? cookie.expires : -1;
  }

  if (typeof cookie.expires === 'string') {
    const parsed = Date.parse(cookie.expires);
    if (!Number.isNaN(parsed)) {
      return Math.floor(parsed / 1000);
    }
  }

  if (typeof cookie.expiresAt === 'string') {
    const parsed = Date.parse(cookie.expiresAt);
    if (!Number.isNaN(parsed)) {
      return Math.floor(parsed / 1000);
    }
  }

  return -1;
}

function objectToCookies(cookieObj, domain) {
  if (!cookieObj || typeof cookieObj !== 'object' || Array.isArray(cookieObj)) return [];

  return Object.entries(cookieObj).map(([name, value]) => ({
    name,
    value: String(value),
    domain,
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: true,
    sameSite: 'None'
  }));
}

function normalizeCookieArray(cookies, defaultDomain) {
  if (!Array.isArray(cookies)) return [];

  return cookies
    .filter((cookie) => cookie && cookie.name)
    .map((cookie) => ({
      name: cookie.name,
      value: String(cookie.value || ''),
      domain: cookie.domain || defaultDomain,
      path: cookie.path || '/',
      expires: normalizeExpires(cookie),
      httpOnly: !!cookie.httpOnly,
      secure: cookie.secure !== false,
      sameSite: normalizeSameSite(cookie.sameSite)
    }));
}

function uniqueCookies(cookies) {
  const byKey = new Map();
  for (const cookie of cookies) {
    const key = `${cookie.name}|${cookie.domain}|${cookie.path || '/'}`;
    byKey.set(key, cookie);
  }
  return [...byKey.values()];
}

async function main() {
  const baseDir = __dirname;
  const localStorageData = readJsonIfExists(path.join(baseDir, 'localStorage.json')) || {};
  const sessionStorageData = readJsonIfExists(path.join(baseDir, 'sessionStorage.json')) || {};

  const cookiesPrimaryRaw = readJsonIfExists(path.join(baseDir, 'cookies-primary.json'));
  const cookiesCountRaw = readJsonIfExists(path.join(baseDir, 'cookies-count.json'));
  const cookiesFallbackRaw = readJsonIfExists(path.join(baseDir, 'cookies.json'));

  let cookies = [];

  if (Array.isArray(cookiesPrimaryRaw)) {
    cookies = cookies.concat(normalizeCookieArray(cookiesPrimaryRaw, '.perplexity.ai'));
  } else if (cookiesPrimaryRaw && typeof cookiesPrimaryRaw === 'object') {
    cookies = cookies.concat(objectToCookies(cookiesPrimaryRaw, '.perplexity.ai'));
  }

  if (Array.isArray(cookiesCountRaw)) {
    cookies = cookies.concat(normalizeCookieArray(cookiesCountRaw, 'count.perplexity.ai'));
  } else if (cookiesCountRaw && typeof cookiesCountRaw === 'object') {
    cookies = cookies.concat(objectToCookies(cookiesCountRaw, 'count.perplexity.ai'));
  }

  if (cookies.length === 0 && cookiesFallbackRaw) {
    if (Array.isArray(cookiesFallbackRaw)) {
      cookies = cookies.concat(normalizeCookieArray(cookiesFallbackRaw, '.perplexity.ai'));
    } else if (typeof cookiesFallbackRaw === 'object') {
      cookies = cookies.concat(objectToCookies(cookiesFallbackRaw, '.perplexity.ai'));
    }
  }

  cookies = uniqueCookies(cookies);

  if (cookies.length === 0) {
    console.error('No cookies found. Add cookies-primary.json / cookies-count.json / cookies.json');
    process.exit(1);
  }

  try {
    await redisSession.connectRedis(REDIS_URL);
    await redisSession.importSession({
      sessionId: SESSION_ID,
      cookies,
      localStorage: localStorageData,
      sessionStorage: sessionStorageData
    });

    console.log(`Session imported to Redis as session:perplexity:${SESSION_ID}`);
    console.log(`Cookies: ${cookies.length}`);
    console.log(`localStorage keys: ${Object.keys(localStorageData).length}`);
    console.log(`sessionStorage keys: ${Object.keys(sessionStorageData).length}`);
  } finally {
    await redisSession.disconnectRedis();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
