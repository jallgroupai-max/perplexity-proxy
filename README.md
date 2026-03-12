# Perplexity Proxy

Mirror proxy for `www.perplexity.ai` with:

- Service worker websocket tunnel (`/ws-tunnel`)
- Native websocket bridge for suggest endpoint (`/pplx-ws`)
- Redis session persistence (`cookies`, `localStorage`, `sessionStorage`)

## Quick start

1. Copy `.env.example` to `.env` and set `REDIS_URL`.
2. Install dependencies:
   - `npm install`
3. Import provided storage/cookies to Redis:
   - `npm run cookies`
4. Start proxy:
   - `npm start`

Default session key:

- `session:perplexity:perplexity01`
