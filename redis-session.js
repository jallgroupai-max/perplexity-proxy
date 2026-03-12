const { createClient } = require('redis');

let redisClient = null;
let isConnected = false;

function normalizeSameSite(value) {
  const raw = String(value || '').toLowerCase();
  if (raw === 'strict') return 'Strict';
  if (raw === 'none' || raw === 'no_restriction') return 'None';
  return 'Lax';
}

function normalizeCookie(cookie) {
  const normalized = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain || '.perplexity.ai',
    path: cookie.path || '/',
    expires: cookie.expires > 0 ? cookie.expires : -1,
    httpOnly: !!cookie.httpOnly,
    secure: cookie.secure !== false,
    sameSite: normalizeSameSite(cookie.sameSite)
  };

  if (!normalized.domain && cookie.url) {
    try {
      normalized.domain = new URL(cookie.url).hostname;
    } catch {
      normalized.domain = '.perplexity.ai';
    }
  }

  return normalized;
}

async function connectRedis(connectionString) {
  if (isConnected && redisClient) return true;

  redisClient = createClient({ url: connectionString });
  redisClient.on('error', (err) => {
    console.error('[REDIS-SESSION] Redis error:', err);
  });

  await redisClient.connect();
  isConnected = true;
  return true;
}

async function saveCookiesToRedis(sessionId, cookies, localStorageData = {}, sessionStorageData = {}) {
  if (!isConnected || !redisClient) throw new Error('Not connected to Redis');

  const cookiesData = (cookies || []).map(normalizeCookie);
  const sessionData = {
    sessionId,
    cookies: cookiesData,
    localStorage: localStorageData || {},
    sessionStorage: sessionStorageData || {},
    lastUpdated: new Date().toISOString()
  };

  await redisClient.set(`session:perplexity:${sessionId}`, JSON.stringify(sessionData));
  return true;
}

async function loadCookiesFromRedis(sessionId) {
  if (!isConnected || !redisClient) return null;

  const dataStr = await redisClient.get(`session:perplexity:${sessionId}`);
  if (!dataStr) return null;

  const session = JSON.parse(dataStr);
  const cookies = (session.cookies || []).map(normalizeCookie);

  return {
    cookies,
    localStorage: session.localStorage || {},
    sessionStorage: session.sessionStorage || {}
  };
}

async function exportSession(sessionId) {
  if (!isConnected || !redisClient) return null;

  const dataStr = await redisClient.get(`session:perplexity:${sessionId}`);
  if (!dataStr) return null;

  const session = JSON.parse(dataStr);
  return {
    sessionId: session.sessionId,
    cookies: session.cookies || [],
    localStorage: session.localStorage || {},
    sessionStorage: session.sessionStorage || {},
    lastUpdated: session.lastUpdated
  };
}

async function importSession(sessionData) {
  if (!isConnected || !redisClient) throw new Error('Not connected to Redis');

  const targetSessionId = sessionData.sessionId || 'perplexity01';
  const cookies = (sessionData.cookies || []).map(normalizeCookie);

  const dataToSave = {
    sessionId: targetSessionId,
    cookies,
    localStorage: sessionData.localStorage || {},
    sessionStorage: sessionData.sessionStorage || {},
    lastUpdated: new Date().toISOString()
  };

  await redisClient.set(`session:perplexity:${targetSessionId}`, JSON.stringify(dataToSave));
  return true;
}

async function listSessions() {
  if (!isConnected || !redisClient) return [];

  const keys = await redisClient.keys('session:perplexity:*');
  const sessions = [];

  for (const key of keys) {
    const dataStr = await redisClient.get(key);
    if (!dataStr) continue;

    try {
      const session = JSON.parse(dataStr);
      sessions.push({
        sessionId: session.sessionId,
        lastUpdated: session.lastUpdated
      });
    } catch {
      // ignore malformed records
    }
  }

  return sessions.sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated));
}

async function deleteSession(sessionId) {
  if (!isConnected || !redisClient) return false;
  await redisClient.del(`session:perplexity:${sessionId}`);
  return true;
}

async function disconnectRedis() {
  if (redisClient && isConnected) {
    await redisClient.disconnect();
    redisClient = null;
    isConnected = false;
  }
}

module.exports = {
  connectRedis,
  saveCookiesToRedis,
  loadCookiesFromRedis,
  exportSession,
  importSession,
  listSessions,
  deleteSession,
  disconnectRedis
};
