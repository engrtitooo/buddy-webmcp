# Buddy production deployment

Buddy has three independently deployed pieces. The existing [Buddy Market](https://buddy-webmcp-market.engrtitooo.chatgpt.site/) URL hosts only the static WebMCP playground; it cannot safely hold an OpenAI key and it is not the Chrome extension.

## 1. Deploy the API

Deploy `apps/api` to a Node.js 22+ HTTPS service (for example Cloud Run, Render, Fly.io, Railway, or an equivalent container/runtime). Build with `npm ci` and `npm run build -w @buddy/api`, then start with `npm start -w @buddy/api`.

Required environment:

- `OPENAI_API_KEY`: server secret; never put this in GitHub, the website, or the extension.
- `ALLOWED_ORIGINS`: comma-separated exact callers. Include the final `chrome-extension://<extension-id>` origin. CORS is not authentication.

Recommended environment:

- `OPENAI_MODEL=gpt-5.6-luna`
- `HOST=0.0.0.0` and the platform-provided `PORT`
- `BUDDY_PROVIDER_TIMEOUT_MS=20000`
- `BUDDY_RATE_LIMIT_MAX=30` and `BUDDY_RATE_LIMIT_WINDOW_MS=60000`
- `BUDDY_API_AUTH_TOKEN` only for controlled/private clients. A public store extension should use a real gateway-issued identity rather than an embedded shared secret.

The service exposes `GET /health` and `POST /agent/next`. Put a public deployment behind TLS, authentication/attestation appropriate to the product, a durable distributed rate limiter, provider spend limits, and monitoring. The included in-memory limiter is a development baseline, not multi-instance infrastructure.

## 2. Build and publish the extension

Create a production bundle with an explicit HTTPS API endpoint:

```powershell
$env:BUDDY_API_BASE_URL = 'https://your-api.example.com'
npm run build:production -w @buddy/extension
```

The build fails if that variable is missing or not HTTPS. It writes the one API origin into `host_permissions`; the service worker never accepts a destination URL from page or content-script data.

For local development, `npm run build -w @buddy/extension` uses `http://127.0.0.1:8787`. Load `apps/extension/dist` as an unpacked extension. After Chrome assigns its extension ID, add that exact origin to the API allowlist and restart the API.

For Chrome Web Store release, create the listing, privacy disclosure, screenshots, support contact, and zipped `apps/extension/dist` bundle. No database is required for this MVP because settings remain in `chrome.storage.local` and sessions are intentionally ephemeral.

## 3. Keep Buddy Market online

Buddy Market is already an independent static site. Its job is to register safe demo WebMCP tools. A current Chrome build still needs WebMCP enabled by its supported flag/origin-trial mechanism. The site does not authenticate users and does not proxy model traffic.

## Release gate

Run all of the following from the repository root:

```bash
npm ci
npm run typecheck
npm test
npm run lint
npm run build
```

Then build the extension once more in production mode with the real API URL, inspect `apps/extension/dist/manifest.json`, load it in Chrome, and verify: hidden on a normal site; visible on a WebMCP site; cancel performs no call; approval resumes once; tool removal cancels an in-flight run; voice defaults to transcript review.
