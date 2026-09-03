# Buddy production deployment

Buddy has three independently deployed pieces. The existing [Buddy Market](https://buddy-webmcp-market.engrtitooo.chatgpt.site/) URL hosts only the static WebMCP playground; it cannot safely hold an OpenAI key and it is not the Chrome extension.

## 1. Deploy the API

Use the existing Railway **Buddy WebMCP → buddy-mcp → production** service at **https://buddy-mcp-production.up.railway.app**. Keep the GitHub source `engrtitooo/buddy-webmcp`, branch `main`, repository root, build command `npm ci && npm run build -w @buddy/api`, and start command `npm start -w @buddy/api`. Do not create a replacement service or change the public URLs.

Required environment:

- `OPENAI_API_KEY`: server secret; never put this in GitHub, the website, or the extension.
- `ALLOWED_ORIGINS`: comma-separated exact permitted HTTPS web origins (retain the existing trusted entries). Explicit Chrome extension origins may also be listed.
- `BUDDY_EXTENSION_ORIGIN_POLICY=chrome-extensions`: permits valid Chrome extension origins for judges' independently loaded installations. No per-judge ID registration is required. Omission defaults to `allowlist` for local/private services.

When `NODE_ENV=production`, the API fails before listening if the key or origin allowlist is absent, originless requests are enabled, an origin is malformed or insecure, or a localhost origin is configured. Invalid extension-policy values also fail; omission preserves the private allowlist default.

Recommended environment:

- `OPENAI_MODEL=gpt-5.6-luna`
- `OPENAI_REALTIME_MODEL=gpt-realtime-2.1`
- `OPENAI_REALTIME_VOICE=marin`
- `HOST=0.0.0.0` and the platform-provided `PORT`
- `BUDDY_PROVIDER_TIMEOUT_MS=20000`
- `BUDDY_RATE_LIMIT_MAX=30` and `BUDDY_RATE_LIMIT_WINDOW_MS=60000`
- `BUDDY_REALTIME_MAX_SESSION_SECONDS=900`
- `BUDDY_REALTIME_SESSION_RATE_LIMIT=10`
- `BUDDY_API_AUTH_TOKEN` only for controlled/private clients. A public store extension should use a real gateway-issued identity rather than an embedded shared secret.

For Railway, keep the existing `OPENAI_API_KEY`, `ALLOWED_ORIGINS`, `NODE_ENV=production`, `HOST=0.0.0.0`, and Railway-provided `PORT`. Add these optional values exactly:

```text
OPENAI_REALTIME_MODEL=gpt-realtime-2.1
OPENAI_REALTIME_VOICE=marin
BUDDY_REALTIME_MAX_SESSION_SECONDS=900
BUDDY_REALTIME_SESSION_RATE_LIMIT=10
```

The service exposes `GET /health`, `POST /agent/next`, and `POST /realtime/session`. The Realtime endpoint accepts only bounded `application/sdp`, checks the same origin/auth boundary, applies a dedicated session-creation limiter, and forwards a server-owned session through OpenAI's unified WebRTC interface. `GET /health` returns the agent contract version and Railway's `RAILWAY_GIT_COMMIT_SHA` (plus its branch when available), so the running source can be compared with `main`. Put a public deployment behind TLS, authentication/attestation appropriate to the product, a durable distributed rate limiter, provider spend limits, and monitoring. The included in-memory limiters are a development baseline, not multi-instance infrastructure.

No new secret is required for Voice Mode. `OPENAI_API_KEY` remains server-side and is reused for both Responses and Realtime. The optional Realtime values above default safely when absent. The browser receives only an SDP answer and bounded non-secret diagnostics; it never receives the key, an authorization header, or arbitrary provider configuration.

Voice Mode incurs paid Realtime audio and transcription usage for the duration of each connection. It is opt-in and client-cleaned after 30 seconds without initial speech, 20 seconds after speech without a response, two minutes of general inactivity, or the configured session cap. Treat provider project budgets, usage alerts, gateway authentication/attestation, and a durable distributed session limiter as the authoritative production cost controls. Chrome prompts for microphone access only after the waveform button is pressed; no `microphone` manifest permission is added.

The model-facing Structured Output is a fixed root object with no root union and no additional properties. Tool arguments cross that boundary only as `argsJson`; the API parses the string, requires a plain object, validates it against the current tool schema, computes risk locally, and creates a local call ID before returning an internal decision.

To verify the real provider accepts the schema, optionally run:

```powershell
$env:OPENAI_API_KEY = 'your-server-side-key'
npm run smoke:openai -w @buddy/api
```

The smoke test uses a synthetic tool and the same request builder as the API, prints no key or authorization header, and fails clearly if OpenAI rejects the schema or the result cannot be normalized. It is intentionally excluded from public CI because it requires a paid secret.

### Railway redeploy and commit verification

1. Merge or push the tested commit to the connected `main` branch.
2. In Railway, open the Buddy API service and confirm **Settings → Source** points to `engrtitooo/buddy-webmcp`, branch `main`, with the repository root as the service root.
3. Keep the build command `npm ci && npm run build -w @buddy/api` and start command `npm start -w @buddy/api`. Confirm the required variables above are present; do not print secret values.
4. Choose **Deploy Latest Commit**. A plain **Redeploy** can rebuild the previous deployment, so use the latest-commit action when source changed.
5. Wait for the deployment to become Active and confirm the startup log says the Buddy API is listening.
6. Read `https://buddy-mcp-production.up.railway.app/health`. Compare its full `commit` value with the commit shown on GitHub for `main` (or local `git rev-parse origin/main`). Confirm `contractVersion` is `2`.
7. Send the Cloverbase test request and locate its `requestId` in Railway logs. Correlate the safe `buddy_agent_turn`, `buddy_agent_decision`, `buddy_tool_validation_failed`, `buddy_agent_final`, and `buddy_realtime_session_created` events; goals, result bodies, credentials, and secret argument values are not logged.

Keep `/health` configured as Railway's deployment health check. It is public, does not call a paid provider, and discloses only status and source-version metadata. A healthy response confirms service availability; verify both provider routes separately.

## 2. Build and publish the extension

From the repository root, build the production bundle with the existing Railway default:

```powershell
npm ci
npm run build:production
```

No environment variable is required. The root production command builds the workspace, rebuilds the extension in production mode, and verifies it. `BUDDY_API_BASE_URL` may override the default with another explicitly configured HTTPS service; empty/whitespace values use the mode default. Localhost (including subdomains and trailing dots), IPv4 loopback aliases, IPv6 loopback, credentials, query strings, fragments, and non-HTTPS production URLs fail before an existing bundle is replaced. Invalid build-mode names also fail.

The default generated manifest contains exactly:

```json
"host_permissions": ["https://buddy-mcp-production.up.railway.app/*"]
```

Both `/agent/next` and `/realtime/session` use the service worker's compiled `API_BASE_URL`. Page content, tool definitions, message fields, and redirects cannot select a backend. Sender validation and all local approval rules remain active.

CI runs the same root production command with no placeholder API URL. Build tests also exercise development, overrides, invalid destinations, generated permissions, and bundle contents. `verify:production-manifest` checks the expected compiled URL and rejects any localhost/127.0.0.1 reference in either script or the manifest.

For local development, `npm run build -w @buddy/extension` uses `http://127.0.0.1:8787`. Load `apps/extension/dist` as an unpacked extension. After Chrome assigns its extension ID, add that exact origin to the API allowlist and restart the API.

For Chrome Web Store release, create the listing, privacy disclosure, screenshots, support contact, and zipped `apps/extension/dist` bundle. No database is required for this MVP because settings remain in `chrome.storage.local` and sessions are intentionally ephemeral.

### Rebuild and reload the unpacked extension

```powershell
git pull --ff-only origin main
npm ci
npm run build:production
```

Then open `chrome://extensions`, find Buddy version `0.1.2`, choose **Reload**, and refresh every open test tab. If loading it for the first time, choose **Load unpacked** and select `apps/extension/dist`. Judges need no server key, source edits, localhost replacement, or extension-ID registration. A previously loaded extension must be reloaded to pick up a new bundle; a server deployment cannot update files already loaded in Chrome.

### Extension origin security

The judging service opts into `chrome-extensions`, which accepts only the entire serialized origin matching `^chrome-extension://[a-p]{32}$`. Paths, ports, credentials, queries, malformed IDs, `null`, and originless requests are rejected. HTTPS web callers still need an exact `ALLOWED_ORIGINS` match; there is no wildcard web CORS. Accepted responses and preflights echo only the validated caller origin and include `Vary: Origin`.

Chrome service-worker requests run under the extension origin with explicit host permission. An ordinary website cannot choose that browser-generated Origin header. Keeping destinations fixed in the service worker prevents a page from using it as an arbitrary network proxy; this follows [Chrome's cross-origin request guidance](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests).

This policy permits other installed Chrome extensions too; it is an explicit public-demo access policy, not proof of Buddy identity. Non-browser clients can forge Origin even under a fixed-ID allowlist. Authentication verification, payload limits, provider deadlines, and separate text/voice limiters remain in force. Extension quota buckets share the socket-address scope across IDs so rotating an ID does not reset them. Forwarded IP headers are not trusted; behind a reverse proxy, callers may conservatively share a bucket. In-memory quotas are per process and reset on restart. For broader public operation, use gateway-issued identities/attestation, durable distributed quotas, and provider budgets; never embed a shared secret in the extension. Operators can return to `allowlist` for a private deployment.

### Safe connectivity diagnostics

Normal users receive a short message and no action executes on a failed agent request. Opt-in Developer Mode distinguishes `NETWORK_ERROR` (fetch/transport failure), `TIMEOUT` (the 30-second client deadline or a server timeout), `HTTP_ERROR` (an unstructured HTTP failure), `ORIGIN_NOT_ALLOWED` (an explicit server origin rejection), `UNAUTHORIZED`, `RATE_LIMITED`, and `PROVIDER_ERROR`. Structured validation errors remain available. Voice bootstrap diagnostics preserve the same safe code, request ID, and HTTP status.

The client allows the default 20-second server provider timeout to finish before aborting. CORS failures that the browser hides are reported honestly as `NETWORK_ERROR`; a blocked web page cannot read a 403 body. Diagnostics discard raw exception/server messages and arbitrary request-ID headers. They exclude authorization headers, keys, tokens, SDP/ICE credentials, audio, goals, and user content. Share only the safe code/status and UUID to correlate with Railway logs.

### Production regression checklist

1. On `https://www.rarebeauty.com`, confirm the page and Buddy content script remain healthy. In Developer Mode, an incompatible individual tool may report `incompatible-definition-or-schema`, but other compatible tools must remain available and no generated AJV function error may appear.
2. On the catalog test site, inspect the advertised `search_catalog` schema in Developer Mode. Ask for **skincare products under $100** and confirm the executed arguments match that exact schema: flat `{ "query": "..." }` stays flat, while a genuinely nested schema stays nested. Invalid arguments must not execute and receive at most one repair turn.
3. For a typed read request, confirm one successful action creates a clear observation and Buddy returns a final answer. Repeat an equivalent search and confirm Buddy stops before the ten-turn ceiling.
4. For voice, confirm the UI moves through microphone, peer, channel, listening, speech, processing, playback, and idle states; transcripts appear; a read request travels through the normal Activity/approval pipeline; and the result is spoken.
5. Deny microphone access, block the data channel, and block autoplay in separate trials. Confirm Browser Speech fallback is offered for connection failures, every track/peer/channel/audio object is cleaned up, and playback failure reports `AUDIO_PLAYBACK_BLOCKED` in Developer Mode.

### Cloverbase production check

1. Open `https://cloverbase.com`, refresh it after reloading Buddy, and open the Buddy panel.
2. Confirm Buddy reports four site actions: `get_site_info`, `list_posts`, `search_posts`, and `subscribe_newsletter` (tool names are visible in Developer Mode).
3. Send **Show what you can do**. It must return a conversational response, and Railway must show that the request passed validation and reached the provider rather than returning the former immediate 400.
4. Send **What can you do here?**, **Explain what this site lets you do.**, and **Help me choose.** Confirm Buddy can answer or ask a follow-up without invoking a site action.
5. Ask to list posts, then search for a specific phrase. Confirm read-only calls execute and appear in Activity.
6. Ask to subscribe an email address. Confirm Buddy shows an approval card and does not invoke `subscribe_newsletter` until **Approve once** is selected. Cancel once as a negative check and confirm nothing is submitted.
7. In Developer Mode, if any request fails, record only its request ID, HTTP status, safe error code, validation stage, and tool name for correlation with Railway logs.
8. Press the blue waveform button. Grant microphone permission and confirm the status moves from **Connecting…** to **Listening…**.
9. Say **What can you do on this website?** and confirm Buddy answers with the OpenAI voice while both transcripts appear once in Chat.
10. Continue speaking without pressing the button again, then interrupt Buddy mid-response. The remote response must stop without overlapping speech.
11. Say **Show me the latest articles.** Confirm the read action passes through Activity and its result is spoken.
12. Ask to subscribe to the newsletter. Confirm the visual approval card appears, spoken assent does nothing, **Cancel** executes nothing, and **Approve once** executes exactly once in a second trial.
13. End Voice Mode and confirm Chrome's microphone indicator disappears. Send another text message and confirm `/agent/next` still returns HTTP 200.
14. Open a normal non-WebMCP site. Buddy must remain hidden and must not invent actions or inspect the DOM.

## 3. Keep Buddy Market online

Buddy Market is already an independent static site. Its job is to register safe demo WebMCP tools. A current Chrome build still needs WebMCP enabled by its supported flag/origin-trial mechanism. The site does not authenticate users and does not proxy model traffic.

## Release gate

Run all of the following from the repository root:

```bash
npm ci
npm run typecheck
npm test
npm run lint
npm run build:production
```

After all checks pass, commit and push to the existing GitHub `main`, enable the judging origin policy on the existing Railway service, and deploy the latest commit. Verify `/health` reports that exact commit, `/agent/next` returns a valid decision for a synthetic goal, and `/realtime/session` returns a valid SDP answer for a generated WebRTC offer. Never log SDP or credentials. Re-run `npm run build:production` last, then load/reload `apps/extension/dist`. Keep generated `dist` untracked and do not create a GitHub Release. Interactive microphone, playback, and approval checks remain the browser checklist above.

The opt-in `npm run smoke:production -- --expected-commit=<full-commit-sha>` performs those live checks, including preflights from two random valid extension IDs and rejection of arbitrary web/null/originless callers. It uses one paid synthetic text turn and one synthetic SDP bootstrap, with no tool execution, microphone, or media stream, and prints only safe status/UUID/commit metadata. It verifies bootstrap negotiation, not actual audio playback. It is excluded from unit tests and CI.
