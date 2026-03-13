const fs = require('fs');
const path = require('path');
const http = require('http');

require('dotenv').config();

const express = require('express');
const cheerio = require('cheerio');
const WebSocket = require('ws');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

const redisSession = require('./redis-session');
const { hiddenStyles, lockProfileScript } = require('./html');

chromium.use(stealth);

const TARGET = 'https://www.perplexity.ai';
const SUGGEST_WS_TARGET = 'wss://suggest.perplexity.ai';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const PORT = Number(process.env.PORT || 3004);
const DOMAIN = (process.env.DOMAIN || 'localhost').split(':')[0];
const PROTOCOL = process.env.PROTOCOL || 'http';
const LISTEN_HOST = process.env.LISTEN_HOST || '0.0.0.0';
const IS_HEADLESS = !process.argv.includes('--openwindow') && process.env.HEADLESS !== 'false';
const REDIS_URL = process.env.REDIS_URL;
const SESSION_ID = process.env.SESSION_ID || 'perplexity01';
const SYNC_INTERVAL = Number(process.env.REDIS_SYNC_INTERVAL || 300000);

if (!REDIS_URL) {
  console.error('[CONFIG] Missing REDIS_URL in .env');
  process.exit(1);
}

const LOG_DIR = path.join(__dirname, 'logs');
const today = new Date().toISOString().split('T')[0];
const LOG_FILE = path.join(LOG_DIR, `system-${today}.log`);

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function writeLog(level, args) {
  const line = `[${new Date().toISOString()}] ${level} ${args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}\n`;
  fs.appendFile(LOG_FILE, line, () => {});
}

const logger = {
  log: (...args) => {
    console.log(...args);
    writeLog('INFO', args);
  },
  warn: (...args) => {
    console.warn(...args);
    writeLog('WARN', args);
  },
  error: (...args) => {
    console.error(...args);
    writeLog('ERROR', args);
  }
};

function resolveMaybeRelativePath(inputPath) {
  if (!inputPath) return '';
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(__dirname, inputPath);
}

function getDefaultChromeUserDataDir() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Google', 'Chrome', 'User Data');
  }

  if (process.platform === 'linux') {
    const homeDir = require('os').homedir();
    const linuxCandidates = [
      path.join(homeDir, '.config', 'google-chrome'),
      path.join(homeDir, '.config', 'google-chrome-stable'),
      path.join(homeDir, '.config', 'chromium')
    ];

    return linuxCandidates.find((candidate) => fs.existsSync(candidate)) || linuxCandidates[0];
  }

  return '';
}

function getDefaultChromeExecutablePath() {
  if (process.platform === 'linux') {
    const linuxCandidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser'
    ];

    return linuxCandidates.find((candidate) => fs.existsSync(candidate)) || '';
  }

  return '';
}

function shouldSkipChromeCopy(sourcePath) {
  const normalized = sourcePath.replace(/\//g, '\\');
  const blockedFragments = [
    '\\Singleton',
    '\\Crashpad',
    '\\BrowserMetrics',
    '\\ShaderCache',
    '\\GrShaderCache',
    '\\DawnCache',
    '\\Safe Browsing',
    '\\OptimizationHints',
    '\\Subresource Filter',
    '\\OnDeviceHeadSuggestModel',
    '\\PKIMetadata',
    '\\CertificateRevocation',
    '\\hyphen-data',
    '\\ZxcvbnData'
  ];
  const blockedNames = ['LOCK', 'LOCKFILE', '.lock', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  const baseName = path.basename(normalized);

  if (blockedNames.includes(baseName)) {
    return true;
  }

  return blockedFragments.some((fragment) => normalized.includes(fragment));
}

function copyDirectoryIfPresent(sourceDir, targetDir) {
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    return false;
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
    filter: (currentSource) => !shouldSkipChromeCopy(currentSource)
  });
  return true;
}

function syncChromeProfile({ sourceUserDataDir, targetUserDataDir, profileDirectory }) {
  if (!sourceUserDataDir || !targetUserDataDir) {
    return;
  }

  const normalizedSource = path.resolve(sourceUserDataDir);
  const normalizedTarget = path.resolve(targetUserDataDir);

  if (!fs.existsSync(normalizedSource)) {
    throw new Error(`Chrome source user data dir not found: ${normalizedSource}`);
  }

  if (normalizedSource === normalizedTarget) {
    logger.log('[PLAYWRIGHT] Using Chrome profile in-place without cloning');
    return;
  }

  fs.mkdirSync(normalizedTarget, { recursive: true });

  const rootFiles = ['Local State', 'First Run', 'Last Version', 'Variations'];
  for (const fileName of rootFiles) {
    const sourceFile = path.join(normalizedSource, fileName);
    const targetFile = path.join(normalizedTarget, fileName);
    if (fs.existsSync(sourceFile) && fs.statSync(sourceFile).isFile()) {
      fs.copyFileSync(sourceFile, targetFile);
    }
  }

  const sourceProfileDir = path.join(normalizedSource, profileDirectory);
  const targetProfileDir = path.join(normalizedTarget, profileDirectory);
  const copied = copyDirectoryIfPresent(sourceProfileDir, targetProfileDir);

  if (!copied) {
    throw new Error(`Chrome profile directory not found: ${sourceProfileDir}`);
  }

  logger.log('[PLAYWRIGHT] Chrome profile cloned', {
    sourceUserDataDir: normalizedSource,
    targetUserDataDir: normalizedTarget,
    profileDirectory
  });
}

const portSuffix = process.env.LOCAL === 'true' ? `:${PORT}` : '';
const SERVER_URL = `${PROTOCOL}://${DOMAIN}${portSuffix}`;
const WS_URL = `${PROTOCOL === 'https' ? 'wss' : 'ws'}://${DOMAIN}${portSuffix}`;

logger.log('[INIT] Perplexity proxy starting');
logger.log('[INIT] Config', {
  PORT,
  DOMAIN,
  SERVER_URL,
  WS_URL,
  SESSION_ID,
  HEADLESS: IS_HEADLESS
});

function sanitizeResponseHeaders(headers, removeSetCookie = true) {
  const out = {};
  for (const key of Object.keys(headers || {})) {
    const lower = key.toLowerCase();
    if (['content-length', 'transfer-encoding', 'content-encoding'].includes(lower)) continue;
    if (removeSetCookie && lower === 'set-cookie') continue;
    out[lower] = headers[key];
  }
  return out;
}

function stripHopByHopHeaders(headersObj) {
  const headers = { ...(headersObj || {}) };
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if ([
      'host',
      'connection',
      'content-length',
      'content-encoding',
      'transfer-encoding',
      'upgrade',
      'sec-websocket-key',
      'sec-websocket-version',
      'sec-websocket-extensions'
    ].includes(lower)) {
      delete headers[key];
    }
  }
  return headers;
}

function resolveHttpTarget(originalUrl) {
  const url = new URL(originalUrl, 'http://localhost');
  const pathname = url.pathname;
  const suffix = pathname + (url.search || '');

  if (pathname.startsWith('/_spa/') || pathname.startsWith('/fonts/')) {
    return `https://pplx-next-static-public.perplexity.ai${suffix}`;
  }

  if (pathname.startsWith('/image')) {
    return `https://edge.perplexity.ai${suffix}`;
  }

  if (pathname === '/bs' || pathname.startsWith('/api/v1/bs')) {
    return `https://count.perplexity.ai${suffix}`;
  }

  return `${TARGET}${suffix}`;
}

function isStaticPath(pathname) {
  return /\.(js|css|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|webp|map|json)$/i.test(pathname);
}

(async () => {
  let browser = null;
  let context = null;
  let page = null;
  let loggedFetchFallback = false;
  let isHandlingPage = false;
  const pageCache = new Map();
  const PAGE_CACHE_TTL = 5000;

  const app = express();

  async function attemptCloudflareTurnstile(pageInstance, reason = 'startup') {
    if (!pageInstance || pageInstance.isClosed()) {
      return false;
    }

    try {
      logger.log(`[CLOUDFLARE] Checking Turnstile challenge during ${reason}...`);
      await pageInstance.waitForTimeout(3000);

      const frames = pageInstance.frames();
      const challengeFrame = frames.find((frame) => {
        const frameUrl = frame.url();
        return frameUrl.includes('cloudflare') || frameUrl.includes('turnstile');
      });

      if (!challengeFrame) {
        logger.log('[CLOUDFLARE] No Turnstile iframe detected.');
        return false;
      }

      logger.log('[CLOUDFLARE] Turnstile iframe detected. Simulating human click...');
      const frameElement = await challengeFrame.frameElement();
      const box = await frameElement.boundingBox();

      if (!box) {
        logger.warn('[CLOUDFLARE] Turnstile iframe has no bounding box.');
        return false;
      }

      const x = box.x + (box.width / 4) + (Math.random() * 10);
      const y = box.y + (box.height / 2) + (Math.random() * 5);

      await pageInstance.mouse.move(x, y, { steps: 15 });
      await pageInstance.waitForTimeout(100 + Math.random() * 200);
      await pageInstance.mouse.down();
      await pageInstance.waitForTimeout(50 + Math.random() * 80);
      await pageInstance.mouse.up();

      logger.log('[CLOUDFLARE] Simulated click completed. Waiting for challenge resolution...');
      await pageInstance.waitForTimeout(5000);
      return true;
    } catch (error) {
      logger.error('[CLOUDFLARE] Error while trying to solve Turnstile:', error.message);
      return false;
    }
  }

  async function ensureCloudflareClearance(pageInstance, reason = 'startup') {
    if (!pageInstance || pageInstance.isClosed()) {
      return;
    }

    try {
      const pageTitle = (await pageInstance.title()).toLowerCase();
      const needsClearance =
        pageTitle.includes('just a moment') ||
        pageTitle.includes('attention required') ||
        pageTitle.includes('security verification');

      if (!needsClearance) {
        await attemptCloudflareTurnstile(pageInstance, reason);
        return;
      }

      logger.warn(`[CLOUDFLARE] Challenge detected during ${reason}. Trying interactive clearance...`);
      await attemptCloudflareTurnstile(pageInstance, reason);
      await pageInstance.waitForTimeout(5000);
    } catch (error) {
      logger.warn('[CLOUDFLARE] Could not inspect current challenge state:', error.message);
    }
  }

  async function getCookieHeaderForUrl(targetUrl) {
    if (!context) return '';
    try {
      const urlObj = new URL(targetUrl);
      const cookies = await context.cookies(urlObj.origin);
      return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch {
      return '';
    }
  }

  async function readStorageFromPage() {
    if (!page || page.isClosed()) return { localStorage: {}, sessionStorage: {} };
    if (!page.url().includes('perplexity.ai')) return { localStorage: {}, sessionStorage: {} };

    try {
      return await page.evaluate(() => {
        const local = {};
        const session = {};

        for (let i = 0; i < window.localStorage.length; i += 1) {
          const key = window.localStorage.key(i);
          local[key] = window.localStorage.getItem(key);
        }
        for (let i = 0; i < window.sessionStorage.length; i += 1) {
          const key = window.sessionStorage.key(i);
          session[key] = window.sessionStorage.getItem(key);
        }

        return { localStorage: local, sessionStorage: session };
      });
    } catch {
      return { localStorage: {}, sessionStorage: {} };
    }
  }

  async function syncSessionToRedis() {
    if (!context) return;
    try {
      const cookies = await context.cookies();
      const storage = await readStorageFromPage();
      await redisSession.saveCookiesToRedis(
        SESSION_ID,
        cookies,
        storage.localStorage,
        storage.sessionStorage
      );
      logger.log(`[REDIS] Session synced (${cookies.length} cookies)`);
    } catch (error) {
      logger.error('[REDIS] Failed to sync session:', error.message);
    }
  }

  async function installStorageInitScript(storageData) {
    if (!context) return;
    const payload = {
      localStorage: storageData.localStorage || {},
      sessionStorage: storageData.sessionStorage || {}
    };
    await context.addInitScript((storage) => {
      if (!window.location.hostname.includes('perplexity.ai')) return;
      for (const [key, value] of Object.entries(storage.localStorage || {})) {
        window.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
      for (const [key, value] of Object.entries(storage.sessionStorage || {})) {
        window.sessionStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
    }, payload);
  }

  async function applyStorageToCurrentPage(storageData) {
    if (!page || page.isClosed()) return;
    if (!page.url().includes('perplexity.ai')) return;

    const payload = {
      localStorage: storageData.localStorage || {},
      sessionStorage: storageData.sessionStorage || {}
    };

    try {
      await page.evaluate((storage) => {
        for (const [key, value] of Object.entries(storage.localStorage || {})) {
          window.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
        }
        for (const [key, value] of Object.entries(storage.sessionStorage || {})) {
          window.sessionStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
        }
      }, payload);
    } catch (error) {
      logger.warn('[PAGE] Failed to apply storage to current page:', error.message);
    }
  }

  async function readRequestBodyAsBase64(req) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return null;
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        if (chunks.length === 0) {
          resolve(null);
          return;
        }
        resolve(Buffer.concat(chunks).toString('base64'));
      });
      req.on('error', reject);
    });
  }

  async function fetchViaContextRequest(targetUrl, method, headers, bodyBase64) {
    if (!context) {
      throw new Error('Browser context not ready');
    }

    const finalHeaders = stripHopByHopHeaders(headers || {});
    delete finalHeaders.cookie;
    finalHeaders.origin = TARGET;
    finalHeaders.referer = `${TARGET}/`;
    finalHeaders['user-agent'] = finalHeaders['user-agent'] || DEFAULT_UA;

    const cookieHeader = await getCookieHeaderForUrl(targetUrl);
    if (cookieHeader) {
      finalHeaders.cookie = cookieHeader;
    }

    const options = {
      method,
      headers: finalHeaders,
      failOnStatusCode: false
    };

    if (bodyBase64 && method !== 'GET' && method !== 'HEAD') {
      options.data = Buffer.from(bodyBase64, 'base64');
    }

    const response = await context.request.fetch(targetUrl, options);
    const responseHeaders = {};
    response.headersArray().forEach(({ name, value }) => {
      responseHeaders[name.toLowerCase()] = value;
    });

    return {
      status: response.status(),
      statusText: '',
      headers: responseHeaders,
      bodyBase64: (await response.body()).toString('base64')
    };
  }

  async function fetchViaBrowser(targetUrl, method, headers, bodyBase64) {
    if (!context || !page || page.isClosed()) {
      throw new Error('Browser not ready');
    }

    const targetHost = new URL(targetUrl).hostname;
    let pageHost = '';
    try {
      pageHost = new URL(page.url()).hostname;
    } catch {
      pageHost = '';
    }

    if (!pageHost || targetHost !== pageHost) {
      return fetchViaContextRequest(targetUrl, method, headers, bodyBase64);
    }

    const finalHeaders = stripHopByHopHeaders(headers || {});
    delete finalHeaders.cookie;
    finalHeaders.origin = TARGET;
    finalHeaders.referer = `${TARGET}/`;
    finalHeaders['user-agent'] = finalHeaders['user-agent'] || DEFAULT_UA;

    const cookieHeader = await getCookieHeaderForUrl(targetUrl);
    if (cookieHeader) {
      finalHeaders.cookie = cookieHeader;
    }

    try {
      return await page.evaluate(async ({ url, requestMethod, requestHeaders, requestBodyBase64 }) => {
        const init = {
          method: requestMethod,
          headers: requestHeaders,
          credentials: 'include'
        };

        if (requestBodyBase64 && requestMethod !== 'GET' && requestMethod !== 'HEAD') {
          const binary = atob(requestBodyBase64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
          }
          init.body = bytes;
        }

        const resp = await fetch(url, init);
        const headersOut = {};
        resp.headers.forEach((value, key) => {
          headersOut[key] = value;
        });

        const buffer = new Uint8Array(await resp.arrayBuffer());
        const chunkSize = 0x8000;
        let binaryOut = '';
        for (let i = 0; i < buffer.length; i += chunkSize) {
          binaryOut += String.fromCharCode(...buffer.subarray(i, i + chunkSize));
        }

        return {
          status: resp.status,
          statusText: resp.statusText,
          headers: headersOut,
          bodyBase64: btoa(binaryOut)
        };
      }, {
        url: targetUrl,
        requestMethod: method,
        requestHeaders: finalHeaders,
        requestBodyBase64: bodyBase64
      });
    } catch (pageError) {
      if (!loggedFetchFallback) {
        logger.warn('[BROWSER-FETCH] page.evaluate failed, using context.request fallback:', pageError.message);
        loggedFetchFallback = true;
      }
      return fetchViaContextRequest(targetUrl, method, headers, bodyBase64);
    }
  }

  async function proxyExpressRequest(req, res, targetUrl) {
    const requestBodyBase64 = await readRequestBodyAsBase64(req);
    const result = await fetchViaBrowser(
      targetUrl,
      req.method,
      req.headers,
      requestBodyBase64
    );

    const responseHeaders = sanitizeResponseHeaders(result.headers || {}, true);
    res.writeHead(result.status || 500, result.statusText || '', responseHeaders);
    res.end(result.bodyBase64 ? Buffer.from(result.bodyBase64, 'base64') : Buffer.alloc(0));
  }

  async function handlePage(req, res) {
    const targetPath = req.originalUrl || req.path;
    const targetUrl = resolveHttpTarget(targetPath);
    const now = Date.now();

    if (pageCache.has(targetPath)) {
      const cached = pageCache.get(targetPath);
      if (now - cached.time < PAGE_CACHE_TTL) {
        res.send(cached.html);
        return;
      }
    }

    if (isHandlingPage) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (isHandlingPage) {
        res.status(503).send('Browser is busy. Retry in a few seconds.');
        return;
      }
    }

    if (!page || page.isClosed()) {
      res.status(503).send('Browser not ready');
      return;
    }

    isHandlingPage = true;

    try {
      logger.log('[PAGE] Loading', targetUrl);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(300);
      await ensureCloudflareClearance(page, 'page-render');

      let html = await page.content();
      html = html.replace(/nonce="[^"]*"/g, '');

      const $ = cheerio.load(html);
      $('meta[http-equiv="Content-Security-Policy"]').remove();

      $('script').each((_, element) => {
        const content = $(element).html() || '';
        if (content.includes('serviceWorker')) {
          $(element).remove();
        }
      });

      const swScript = `
<script>
(function(){
  const proxyOrigin = window.location.origin;
  const wsOrigin = proxyOrigin.replace(/^http/, 'ws');

  function rewriteHttpUrl(url) {
    if (typeof url !== 'string') return url;
    return url
      .replace(/^https?:\\/\\/www\\.perplexity\\.ai/i, proxyOrigin)
      .replace(/^https?:\\/\\/edge\\.perplexity\\.ai/i, proxyOrigin);
  }

  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      if (typeof input === 'string') {
        input = rewriteHttpUrl(input);
      } else if (input && input.url) {
        input = new Request(rewriteHttpUrl(input.url), input);
      }
    } catch (error) {}
    return originalFetch.call(this, input, init);
  };

  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string') {
      url = rewriteHttpUrl(url);
    }
    return originalXHROpen.apply(this, arguments);
  };

  function rewriteWsUrl(url) {
    const raw = typeof url === 'string' ? url : String(url);
    if (/^wss?:\\/\\/suggest\\.perplexity\\.ai/i.test(raw)) {
      const parsed = new URL(raw);
      return wsOrigin + '/pplx-ws' + parsed.pathname + parsed.search;
    }
    return raw;
  }

  const OriginalWebSocket = window.WebSocket;
  function PatchedWebSocket(url, protocols) {
    const targetUrl = rewriteWsUrl(url);
    return protocols !== undefined
      ? new OriginalWebSocket(targetUrl, protocols)
      : new OriginalWebSocket(targetUrl);
  }
  PatchedWebSocket.prototype = OriginalWebSocket.prototype;
  PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  PatchedWebSocket.OPEN = OriginalWebSocket.OPEN;
  PatchedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
  window.WebSocket = PatchedWebSocket;
  if (typeof globalThis !== 'undefined') {
    globalThis.WebSocket = PatchedWebSocket;
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw-proxy.js', { scope: '/' }).catch(function(){});
  }

  document.addEventListener('click', function(event) {
    const anchor = event.target.closest('a[href]');
    if (!anchor) return;
    if (!anchor.href.startsWith('https://www.perplexity.ai')) return;
    event.preventDefault();
    window.location.href = anchor.href.replace(/^https?:\\/\\/www\\.perplexity\\.ai/i, proxyOrigin);
  }, true);
})();
</script>`;

      $('base').remove();
      $('head').prepend(`<base href="${SERVER_URL}/">`);
      $('head').append(hiddenStyles);
      $('head').append(lockProfileScript);
      $('head').append(swScript);

      $('script[src], link[href], img[src], a[href]').each((_, element) => {
        const attr = $(element).attr('src') ? 'src' : 'href';
        const current = $(element).attr(attr);
        if (!current) return;
        const rewritten = current
          .replace(/^https?:\/\/www\.perplexity\.ai/i, '')
          .replace(/^https?:\/\/edge\.perplexity\.ai/i, '');
        $(element).attr(attr, rewritten);
      });

      const output = $.html();
      pageCache.set(targetPath, { time: now, html: output });
      res.send(output);
    } catch (error) {
      logger.error('[PAGE] Error:', error.message);
      res.status(500).send(`Error rendering page: ${error.message}`);
    } finally {
      isHandlingPage = false;
    }
  }

  app.get('/sw-proxy.js', (req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, 'sw-proxy.js'));
  });

  app.post('/api/browser-log', express.json({ limit: '10mb' }), (req, res) => {
    const { level = 'log', message = '', url = '' } = req.body || {};
    writeLog(`BROWSER-${String(level).toUpperCase()}`, [message, url]);
    res.json({ success: true });
  });

  app.post('/api/session/export', async (req, res) => {
    try {
      await syncSessionToRedis();
      res.json({ success: true, sessionId: SESSION_ID });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/session/import', express.json({ limit: '10mb' }), async (req, res) => {
    try {
      const targetSessionId = req.body?.sessionId || SESSION_ID;
      const redisData = await redisSession.loadCookiesFromRedis(targetSessionId);
      if (!redisData) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }

      if (context && redisData.cookies?.length) {
        await context.addCookies(redisData.cookies);
      }
      await installStorageInitScript(redisData);
      await applyStorageToCurrentPage(redisData);

      res.json({
        success: true,
        sessionId: targetSessionId,
        cookies: (redisData.cookies || []).length
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/session/list', async (req, res) => {
    try {
      const sessions = await redisSession.listSessions();
      res.json({ success: true, sessions });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/session/export-full', async (req, res) => {
    try {
      const targetSessionId = req.query.sessionId || SESSION_ID;
      const data = await redisSession.exportSession(targetSessionId);
      if (!data) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }
      res.json({ success: true, session: data });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/session/import-full', express.json({ limit: '25mb' }), async (req, res) => {
    try {
      if (!req.body?.session) {
        res.status(400).json({ success: false, error: 'Missing session payload' });
        return;
      }

      await redisSession.importSession(req.body.session);
      if (context && req.body.session.cookies?.length) {
        await context.addCookies(req.body.session.cookies);
      }
      await installStorageInitScript(req.body.session);
      await applyStorageToCurrentPage(req.body.session);

      res.json({ success: true, sessionId: req.body.session.sessionId || SESSION_ID });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get(/^\/.*/, async (req, res, next) => {
    const accept = String(req.headers.accept || '');
    const pathname = req.path || '/';

    if (pathname.startsWith('/api/') || pathname.startsWith('/ws-tunnel') || pathname.startsWith('/pplx-ws')) {
      next();
      return;
    }

    if (isStaticPath(pathname)) {
      next();
      return;
    }

    if (accept.includes('text/html') || pathname === '/' || pathname.startsWith('/search/')) {
      await handlePage(req, res);
      return;
    }

    next();
  });

  app.use(async (req, res) => {
    try {
      const targetUrl = resolveHttpTarget(req.originalUrl || req.url || '/');
      await proxyExpressRequest(req, res, targetUrl);
    } catch (error) {
      logger.error('[HTTP] Proxy error:', error.message);
      if (!res.headersSent) {
        res.status(502).json({ error: error.message });
      }
    }
  });

  try {
    await redisSession.connectRedis(REDIS_URL);
    logger.log('[REDIS] Connected');
  } catch (error) {
    logger.error('[REDIS] Connection error:', error.message);
    process.exit(1);
  }

  try {
    const browserArgs = [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests',
      '--disable-site-isolation-trials',
      '--window-size=1920,1080'
    ];
    if (!IS_HEADLESS) browserArgs.push('--start-maximized');

    const configuredUserDataDir = (process.env.CHROME_USER_DATA_DIR || './chrome-profile').trim();
    const configuredSourceUserDataDir = (process.env.CHROME_SOURCE_USER_DATA_DIR || '').trim();
    const chromeProfileDirectory = (process.env.CHROME_PROFILE_DIRECTORY || 'Default').trim() || 'Default';
    const defaultChromeUserDataDir = getDefaultChromeUserDataDir();
    const sourceUserDataDir = resolveMaybeRelativePath(configuredSourceUserDataDir || defaultChromeUserDataDir);
    const userDataDir = resolveMaybeRelativePath(configuredUserDataDir);

    if (chromeProfileDirectory) {
      browserArgs.push(`--profile-directory=${chromeProfileDirectory}`);
    }

    const launchOptions = {
      headless: IS_HEADLESS,
      args: browserArgs,
      viewport: IS_HEADLESS ? { width: 1920, height: 1080 } : null,
      ignoreHTTPSErrors: true,
      ignoreDefaultArgs: ['--enable-automation']
    };
    logger.log('[PLAYWRIGHT] Chrome profile config', {
      sourceUserDataDir: sourceUserDataDir || 'not configured',
      userDataDir,
      profileDirectory: chromeProfileDirectory
    });

    try {
      syncChromeProfile({
        sourceUserDataDir,
        targetUserDataDir: userDataDir,
        profileDirectory: chromeProfileDirectory
      });
    } catch (profileSyncError) {
      logger.warn('[PLAYWRIGHT] Chrome profile sync skipped:', profileSyncError.message);
    }

    try {
      const configuredChromeBin = (process.env.CHROME_BIN || '').trim();
      const defaultChromeBin = getDefaultChromeExecutablePath();

      if (configuredChromeBin) {
        launchOptions.executablePath = configuredChromeBin;
      } else if (defaultChromeBin) {
        launchOptions.executablePath = defaultChromeBin;
      } else {
        launchOptions.channel = 'chrome';
      }

      context = await chromium.launchPersistentContext(userDataDir, launchOptions);
      browser = context.browser();
      logger.log('[PLAYWRIGHT] Using persistent context');
    } catch (persistentError) {
      logger.warn('[PLAYWRIGHT] Persistent context failed, falling back to regular context:', persistentError.message);

      delete launchOptions.channel;
      delete launchOptions.executablePath;
      delete launchOptions.viewport;
      delete launchOptions.ignoreDefaultArgs;

      browser = await chromium.launch({
        headless: IS_HEADLESS,
        args: browserArgs
      });

      context = await browser.newContext({
        viewport: IS_HEADLESS ? { width: 1920, height: 1080 } : null,
        ignoreHTTPSErrors: true
      });
    }

    const redisData = await redisSession.loadCookiesFromRedis(SESSION_ID);
    if (redisData?.cookies?.length) {
      await context.addCookies(redisData.cookies);
      logger.log(`[REDIS] Loaded ${redisData.cookies.length} cookies from Redis`);
    } else {
      logger.warn('[REDIS] No stored cookies for this SESSION_ID');
    }

    if (redisData && (Object.keys(redisData.localStorage || {}).length > 0 || Object.keys(redisData.sessionStorage || {}).length > 0)) {
      await installStorageInitScript(redisData);
      logger.log('[REDIS] Loaded localStorage/sessionStorage from Redis');
    }

    const existingPages = context.pages();
    page = existingPages.length > 0 ? existingPages[0] : await context.newPage();

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
    });
    await page.goto(TARGET, { waitUntil: IS_HEADLESS ? 'domcontentloaded' : 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2500);
    await ensureCloudflareClearance(page, 'startup');

    logger.log('[PLAYWRIGHT] Browser context ready');
  } catch (error) {
    logger.error('[PLAYWRIGHT] Initialization error:', error.message);
  }

  const syncInterval = setInterval(syncSessionToRedis, SYNC_INTERVAL);

  const server = http.createServer(app);
  const wsTunnelServer = new WebSocket.Server({ noServer: true });
  const peoplexityWsServer = new WebSocket.Server({ noServer: true });

  const MAX_WS_CONCURRENT = 12;
  let activeWsRequests = 0;
  const pendingWsJobs = [];

  function runWsQueue() {
    while (pendingWsJobs.length > 0 && activeWsRequests < MAX_WS_CONCURRENT) {
      const job = pendingWsJobs.shift();
      activeWsRequests += 1;
      Promise.resolve()
        .then(job)
        .catch(() => {})
        .finally(() => {
          activeWsRequests -= 1;
          runWsQueue();
        });
    }
  }

  function enqueueWsJob(job) {
    pendingWsJobs.push(job);
    runWsQueue();
  }

  wsTunnelServer.on('connection', (ws) => {
    ws.on('message', (raw) => {
      enqueueWsJob(async () => {
        let payload;
        try {
          payload = JSON.parse(raw.toString());
        } catch {
          return;
        }

        const requestId = payload.id;
        const targetUrl = payload.url;
        if (!targetUrl) {
          ws.send(JSON.stringify({ id: requestId, error: 'Missing target URL', status: 400 }));
          return;
        }

        let urlObj;
        try {
          urlObj = new URL(targetUrl);
        } catch {
          ws.send(JSON.stringify({ id: requestId, error: 'Invalid target URL', status: 400 }));
          return;
        }

        try {
          const method = payload.method || 'GET';
          const result = await fetchViaBrowser(
            targetUrl,
            method,
            payload.headers || {},
            payload.body || null
          );

          const contentType = String(result.headers?.['content-type'] || result.headers?.['Content-Type'] || '');
          const requestedAccept = String(payload.headers?.accept || payload.headers?.Accept || '');
          const isStreaming = contentType.includes('text/event-stream') ||
            requestedAccept.includes('text/event-stream') ||
            urlObj.pathname.includes('/rest/sse/');

          const headers = sanitizeResponseHeaders(result.headers || {}, true);

          if (isStreaming) {
            ws.send(JSON.stringify({
              id: requestId,
              status: result.status || 200,
              statusText: result.statusText || 'OK',
              headers,
              streaming: true
            }));

            const payloadBuffer = result.bodyBase64 ? Buffer.from(result.bodyBase64, 'base64') : Buffer.alloc(0);
            const chunkSize = 8192;
            for (let offset = 0; offset < payloadBuffer.length; offset += chunkSize) {
              const chunk = payloadBuffer.subarray(offset, offset + chunkSize);
              ws.send(JSON.stringify({
                id: requestId,
                chunk: chunk.toString('base64'),
                streaming: true
              }));
            }

            ws.send(JSON.stringify({ id: requestId, streaming: true, done: true }));
          } else {
            ws.send(JSON.stringify({
              id: requestId,
              status: result.status || 200,
              statusText: result.statusText || 'OK',
              headers,
              body: result.bodyBase64 || ''
            }));
          }
        } catch (error) {
          ws.send(JSON.stringify({
            id: requestId,
            status: 500,
            error: error.message
          }));
        }
      });
    });
  });

  peoplexityWsServer.on('connection', (clientWs, req) => {
    (async () => {
      const urlObj = new URL(req.url, 'http://localhost');
      const upstreamPath = urlObj.pathname.replace(/^\/pplx-ws/, '') || '/suggest/ws';
      const upstreamUrl = `${SUGGEST_WS_TARGET}${upstreamPath}${urlObj.search || ''}`;
      const protocols = req.headers['sec-websocket-protocol']
        ? req.headers['sec-websocket-protocol'].split(',').map((p) => p.trim()).filter(Boolean)
        : undefined;

      const headers = {
        Origin: TARGET,
        'User-Agent': DEFAULT_UA
      };

      const cookieHeader = await getCookieHeaderForUrl('https://suggest.perplexity.ai');
      if (cookieHeader) headers.Cookie = cookieHeader;

      const upstreamWs = protocols && protocols.length > 0
        ? new WebSocket(upstreamUrl, protocols, { headers })
        : new WebSocket(upstreamUrl, { headers });

      upstreamWs.on('open', () => {
        clientWs.on('message', (data, isBinary) => {
          if (upstreamWs.readyState === WebSocket.OPEN) {
            upstreamWs.send(data, { binary: isBinary });
          }
        });

        upstreamWs.on('message', (data, isBinary) => {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data, { binary: isBinary });
          }
        });
      });

      upstreamWs.on('close', () => clientWs.close());
      clientWs.on('close', () => upstreamWs.close());

      upstreamWs.on('error', () => clientWs.close());
      clientWs.on('error', () => upstreamWs.close());
    })().catch((error) => {
      logger.error('[WS] Upstream suggest socket error:', error.message);
      clientWs.close();
    });
  });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;

    if (pathname === '/ws-tunnel') {
      wsTunnelServer.handleUpgrade(request, socket, head, (ws) => {
        wsTunnelServer.emit('connection', ws, request);
      });
      return;
    }

    if (pathname.startsWith('/pplx-ws')) {
      peoplexityWsServer.handleUpgrade(request, socket, head, (ws) => {
        peoplexityWsServer.emit('connection', ws, request);
      });
      return;
    }

    socket.destroy();
  });

  server.listen(PORT, LISTEN_HOST, () => {
    logger.log(`[SERVER] Running at ${SERVER_URL}`);
    logger.log(`[SERVER] SESSION_ID=${SESSION_ID}`);
  });

  async function shutdown() {
    logger.log('[SHUTDOWN] Flushing session and closing');
    clearInterval(syncInterval);
    try {
      await syncSessionToRedis();
    } catch {}
    try {
      if (context) await context.close();
    } catch {}
    try {
      if (browser) await browser.close();
    } catch {}
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})();
