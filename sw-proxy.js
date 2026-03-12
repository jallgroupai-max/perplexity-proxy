let wsTunnel = null;
let wsTunnelReady = false;
let connectionPromise = null;
let requestIdCounter = 0;
let reconnectAttempts = 0;
const maxReconnectAttempts = 8;
const pendingRequests = new Map();

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function buildWsUrl() {
  const origin = self.location.origin;
  const protocol = origin.startsWith('https') ? 'wss' : 'ws';
  const urlObj = new URL(origin);
  const inferredPort = urlObj.port || (origin.startsWith('https') ? '443' : '80');
  const includePort = inferredPort !== '80' && inferredPort !== '443';
  return `${protocol}://${urlObj.hostname}${includePort ? `:${inferredPort}` : ''}/ws-tunnel`;
}

function connectTunnel() {
  if (wsTunnel && wsTunnel.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = new Promise((resolve, reject) => {
    const ws = new WebSocket(buildWsUrl());

    const timeoutId = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        ws.close();
        connectionPromise = null;
        reject(new Error('WebSocket tunnel timeout'));
      }
    }, 10000);

    ws.onopen = () => {
      clearTimeout(timeoutId);
      wsTunnel = ws;
      wsTunnelReady = true;
      reconnectAttempts = 0;
      connectionPromise = null;
      resolve();
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const reqState = pendingRequests.get(payload.id);
        if (!reqState) return;

        if (payload.error) {
          if (reqState.timeout) clearTimeout(reqState.timeout);
          pendingRequests.delete(payload.id);
          reqState.reject(new Error(payload.error));
          return;
        }

        if (payload.streaming) {
          if (!reqState.streamController) {
            const responseHeaders = new Headers(payload.headers || {});
            responseHeaders.set('Access-Control-Allow-Origin', self.location.origin);
            responseHeaders.set('Access-Control-Allow-Credentials', 'true');

            const responseStream = new ReadableStream({
              start(controller) {
                reqState.streamController = controller;
                if (payload.chunk) {
                  controller.enqueue(base64ToUint8Array(payload.chunk));
                }
              },
              cancel() {
                pendingRequests.delete(payload.id);
              }
            });

            if (reqState.timeout) clearTimeout(reqState.timeout);
            reqState.resolve(new Response(responseStream, {
              status: payload.status,
              statusText: payload.statusText || 'OK',
              headers: responseHeaders
            }));
            return;
          }

          if (payload.chunk && reqState.streamController) {
            reqState.streamController.enqueue(base64ToUint8Array(payload.chunk));
          }

          if (payload.done) {
            if (reqState.streamController) reqState.streamController.close();
            pendingRequests.delete(payload.id);
          }
          return;
        }

        if (reqState.timeout) clearTimeout(reqState.timeout);
        pendingRequests.delete(payload.id);

        const responseHeaders = new Headers(payload.headers || {});
        responseHeaders.set('Access-Control-Allow-Origin', self.location.origin);
        responseHeaders.set('Access-Control-Allow-Credentials', 'true');
        responseHeaders.delete('set-cookie');

        reqState.resolve(new Response(payload.body ? base64ToUint8Array(payload.body) : null, {
          status: payload.status,
          statusText: payload.statusText || 'OK',
          headers: responseHeaders
        }));
      } catch (error) {
        // ignore malformed tunnel packets
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeoutId);
      wsTunnelReady = false;
      connectionPromise = null;
      if (reconnectAttempts >= maxReconnectAttempts) {
        reject(err);
      }
    };

    ws.onclose = () => {
      clearTimeout(timeoutId);
      wsTunnelReady = false;
      wsTunnel = null;
      connectionPromise = null;
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts += 1;
        const delay = Math.min(1000 * reconnectAttempts, 10000);
        setTimeout(() => {
          connectTunnel().catch(() => {});
        }, delay);
      }
    };
  });

  return connectionPromise;
}

function isLocalRoute(pathname) {
  return pathname === '/' ||
    pathname === '/sw-proxy.js' ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/ws-tunnel') ||
    pathname.startsWith('/pplx-ws');
}

function shouldProxyRequest(url) {
  const hostname = url.hostname;
  if (hostname.includes('perplexity.ai')) return true;
  if (hostname !== self.location.hostname) return false;
  return !isLocalRoute(url.pathname);
}

function resolveTargetUrl(url) {
  if (url.hostname !== self.location.hostname) return url.toString();

  const pathname = url.pathname;
  const search = url.search || '';

  if (pathname.startsWith('/_spa/') || pathname.startsWith('/fonts/')) {
    return `https://pplx-next-static-public.perplexity.ai${pathname}${search}`;
  }

  if (pathname.startsWith('/image')) {
    return `https://edge.perplexity.ai${pathname}${search}`;
  }

  if (pathname === '/bs' || pathname.startsWith('/api/v1/bs')) {
    return `https://count.perplexity.ai${pathname}${search}`;
  }

  return `https://www.perplexity.ai${pathname}${search}`;
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    clients.claim(),
    caches.keys().then((cacheNames) => Promise.all(cacheNames.map((name) => caches.delete(name)))),
    connectTunnel().catch(() => {})
  ]));
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (!shouldProxyRequest(requestUrl)) return;

  event.respondWith((async () => {
    try {
      if (!wsTunnelReady || !wsTunnel || wsTunnel.readyState !== WebSocket.OPEN) {
        await connectTunnel();
      }

      const targetUrl = resolveTargetUrl(requestUrl);
      let bodyBase64 = null;

      if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
        const clone = event.request.clone();
        const body = await clone.arrayBuffer();
        if (body.byteLength > 0) {
          bodyBase64 = arrayBufferToBase64(body);
        }
      }

      const headers = {};
      event.request.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (!['host', 'origin', 'referer', 'content-length', 'connection', 'upgrade'].includes(lower)) {
          headers[key] = value;
        }
      });

      const tunnelRequest = {
        id: ++requestIdCounter,
        url: targetUrl,
        method: event.request.method,
        headers,
        body: bodyBase64
      };

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingRequests.delete(tunnelRequest.id);
          reject(new Error('Tunnel timeout'));
        }, 120000);

        pendingRequests.set(tunnelRequest.id, {
          resolve,
          reject,
          timeout,
          url: targetUrl
        });

        wsTunnel.send(JSON.stringify(tunnelRequest));
      });
    } catch (error) {
      return new Response(JSON.stringify({
        error: 'tunnel_error',
        message: error.message
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': self.location.origin,
          'Access-Control-Allow-Credentials': 'true'
        }
      });
    }
  })());
});
