# Buddy

**The friendly interface for the agentic web.**

Buddy is a Chrome companion that wakes up when a website exposes [WebMCP](https://developer.chrome.com/docs/ai/webmcp) tools, translates those structured capabilities into human language, and helps people complete goals through text or voice—while applying deterministic approval rules before consequential actions.

> WebMCP gives websites capabilities. Buddy gives those capabilities a face, a voice, and your rules.

**[Open the live Buddy Market WebMCP Playground](https://buddy-webmcp-market.engrtitooo.chatgpt.site/)**

## What is Buddy?

Buddy is the actual product: a portable, consumer-facing Chrome companion for the WebMCP web. It renders nothing on ordinary websites. When a compatible site intentionally advertises tools, Buddy wakes up, explains the available capabilities in everyday language, and lets the person describe an outcome instead of selecting individual functions.

Buddy plans and carries out safe work one structured action at a time, provides a readable activity trail, and pauses at a visible approval card whenever local deterministic rules require a decision. The same interface supports text, voice, English, Arabic/RTL, and Spanish.

## What is Buddy Market?

**Buddy Market is not the product. It is the included WebMCP Playground used to demonstrate Buddy safely.**

It is a fictional marketplace with 20 products, 10 real registered WebMCP tools, and simulated transactions. Search, filters, comparisons, cart state, delivery preferences, and checkout visibly respond to WebMCP execution; no payment is collected and no real purchase occurs.

## Why WebMCP?

Without a structured capability contract, browser agents often have to interpret visual pages and interact indirectly. WebMCP lets a website intentionally expose typed actions with descriptions, JSON Schema inputs, and execution semantics.

Buddy builds on that contract to provide discoverability, more reliable and explainable actions, an auditable activity trail, and clear approval boundaries. It uses only the tools a compatible site advertises; it does not scrape the page or invent capabilities.

## Why Buddy?

WebMCP defines how websites expose capabilities. Buddy addresses the human experience around those capabilities. **Buddy is a consumer interface layer for the WebMCP web.**

- Natural goals instead of manual tool selection
- Human-readable capabilities instead of raw names and schemas
- Portable preferences and deterministic approval rules
- Visible execution, approval cards, and activity history
- Text and voice interaction
- English, Arabic/RTL, and Spanish interface support

## Current WebMCP implementation

This code targets the current Community Group draft and Chrome 149 origin trial surface:

- `document.modelContext.registerTool()` for Playground tools
- `document.modelContext.getTools()` for discovery
- `document.modelContext.executeTool()` for execution
- `toolchange` for additions, removals, and replacements
- `annotations.readOnlyHint` and `annotations.untrustedContentHint`
- `AbortController` signals for tool lifetime
- JSON Schema input definitions and JSON-serializable structured results
- compatibility normalization for Chrome `RegisteredTool.inputSchema` values exposed as either parsed objects or serialized JSON
- feature detection and graceful unsupported-browser behavior

Chrome's official security guidance states that extension content scripts can query and execute WebMCP tools. Buddy therefore reads the API directly from its isolated content-script world and does **not** expose a MAIN-world bridge or privileged message API to page JavaScript.

For local development, use Chrome 149+ and enable `chrome://flags/#enable-webmcp-testing`, then relaunch Chrome. A production Playground can instead participate in the WebMCP origin trial.

## Architecture

```text
User goal
  → extension service worker → POST /agent/next
  → one validated next action using current WebMCP tools only
  → bounded MV3-safe JSON Schema interpretation (no runtime code generation)
  → PermissionEngine (recomputed risk + local rules)
  → ALLOW / ASK / BLOCK
  → execute at most one WebMCP tool
  → bounded observation → repeat or final answer
```

```text
apps/
  extension/     Manifest V3 content-script companion
  playground/    Buddy Market and 10 real WebMCP tools
  api/           Optional server-only OpenAI Responses API proxy
packages/
  agent-core/    capability mapping, planning, risk, approval
  buddy-ui/      mascot state machine, panel, voice, settings
  localization/  English, Arabic/RTL, Spanish
  shared/        strict domain types and default rules
  webmcp-bridge/ current WebMCP browser adapter and registration
```

Full decisions are documented in [ARCHITECTURE.md](./ARCHITECTURE.md), the threat model in [SECURITY.md](./SECURITY.md), and the submission story in [HACKATHON.md](./HACKATHON.md).

## Judge Quick Start

This is the shortest fully supported local-extension path. It uses the real OpenAI-backed agent, so an API key is required and remains server-side.

1. Clone the repository and install dependencies:

   ```bash
   git clone https://github.com/engrtitooo/buddy-webmcp.git
   cd buddy-webmcp
   npm install
   ```

2. Build the workspace. The development extension is configured for the local API at `http://127.0.0.1:8787`:

   ```bash
   npm run build
   ```

3. In Chrome 149+, open `chrome://flags/#enable-webmcp-testing`, enable WebMCP testing support if required, and relaunch Chrome.

4. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `apps/extension/dist`. Copy the generated extension ID shown by Chrome.

5. Start the local API from PowerShell with the provider key and exact extension origin. Replace both placeholders; do not put the key in a browser bundle or commit it:

   ```powershell
   $env:OPENAI_API_KEY = 'your-server-side-key'
   $env:ALLOWED_ORIGINS = 'chrome-extension://YOUR_EXTENSION_ID'
   npm start -w @buddy/api
   ```

6. Open the [live Buddy Market Playground](https://buddy-webmcp-market.engrtitooo.chatgpt.site/). Buddy should wake up and describe the available capabilities.

7. Enter this exact prompt in Buddy:

   > Find me a gift under $50 that arrives before Thursday. Compare the best options, but don't buy anything without asking me.

8. Expected result: Buddy uses structured search/filter/compare actions, the marketplace UI visibly updates, Activity records readable steps, and Buddy pauses at an approval card before a consequential cart or checkout action. Cancel once to prove nothing executes, then repeat and approve once.

The project owner can instead build against the deployed Railway API by setting `BUDDY_API_BASE_URL` and running the production extension build documented in [PRODUCTION.md](./PRODUCTION.md). That API must allow the exact generated `chrome-extension://` origin; a production API URL alone is not zero-setup access.

## Run locally

Prerequisites: Node.js 22+ and Chrome 149+ for native WebMCP testing.

```bash
npm install
npm run dev
```

Open `http://localhost:5173` for Buddy Market.

Build and validate everything:

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

CI also builds the extension in production mode against `https://api.example.com` and verifies that this is the only generated `host_permissions` entry. The validation artifact is not published.

## Load the Chrome extension

1. Run `npm run build`.
2. Start the local API with `OPENAI_API_KEY` set, or build against a deployed API as described in [PRODUCTION.md](./PRODUCTION.md).
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Choose **Load unpacked**.
6. Select `apps/extension/dist`.
7. Enable the WebMCP testing flag described above and open Buddy Market.

The extension uses one Chrome API permission:

- `storage`: saves language, theme, voice preference, developer mode, and personal approval rules locally.

Its static content script runs on HTTP(S) pages but renders nothing until tools exist. A service worker can contact only the build-time API origin in `host_permissions`. It requests no tabs, scripting, cookies, identity, browsing history, clipboard, microphone manifest permission, or network-interception permission. Chrome requests website microphone access through `getUserMedia` only after the user presses the waveform button.

## AI providers

`MockAgentProvider` is deterministic and reserved for tests or explicitly wired demos. The production extension never silently falls back to it.

The extension's `ExtensionAgentProvider` sends typed messages to its service worker, which calls `apps/api`. The browser adapter first converts native `RegisteredTool` handles into a strict JSON-only contract: `window`, functions, prototypes, cycles, unknown properties, and browser objects never cross the boundary. The proxy uses the OpenAI Responses API with strict Structured Outputs, defaults to `gpt-5.6-luna`, adds timeouts/request IDs, and sets `store: false`. Its model-facing response is one fixed closed object with `kind`, `toolName`, `argsJson`, `label`, `reason`, and `message`. The model may return a conversational `final` or `needs_input` response without calling a tool. It never supplies executable argument objects, risk, or call IDs. The server parses `argsJson`, requires a plain object, validates it against the exact current WebMCP schema with a bounded interpreter that does not use `eval`/`new Function`, recomputes risk, and generates the call ID locally. Invalid proposals receive one bounded repair opportunity and are never executed. An incompatible site schema disables only its own tool.

Set the server environment in the shell (or use your process manager's environment support), then build and start the API:

```powershell
$env:OPENAI_API_KEY = 'your-server-side-key'
$env:ALLOWED_ORIGINS = 'http://localhost:5173,chrome-extension://YOUR_EXTENSION_ID'
npm run build -w @buddy/api
npm start -w @buddy/api
```

The proxy binds to `127.0.0.1` by default, accepts only exact origins in `ALLOWED_ORIGINS`, rejects originless requests, and rate-limits clients. Add the exact Chrome extension origin when using a packaged extension. See [PRODUCTION.md](./PRODUCTION.md) for deployment and Chrome Web Store release steps. A public deployment must sit behind an authenticated, durably rate-limited gateway; CORS is not authentication.

## Approval and personal rules

Tools are mapped locally to `READ`, `LOW_RISK_WRITE`, `EXTERNAL_COMMUNICATION`, `FINANCIAL`, `DESTRUCTIVE`, or `SENSITIVE`. Remote risk labels are never authoritative, consequential names override `readOnlyHint`, and the Permission Engine combines the normalized risk with locally stored user rules.

- `ALLOW`: execute and record the step.
- `ASK`: pause the plan and show what will happen, why approval is needed, the site, risk, and complete human-readable argument values. **Approve once** resumes the same plan; **Cancel** executes nothing. Raw argument JSON and raw WebMCP tool names are available only in Developer Mode.
- `BLOCK`: stop and explain which personal rule prevented the action.

The default rules ask before submissions, messages, purchases/reservations, and sensitive sharing, and block deletion. Financial and destructive actions never run silently.

Agent runs are bound to the current WebMCP tool-set revision. If a site adds, removes, or replaces a tool while reasoning or while approval is pending, Buddy cancels the run. The loop keeps ten decisions as a hard ceiling, allows only one schema-repair turn per tool, normalizes semantically equivalent calls, and stops early when the same read tool returns the same result again.

WebMCP discovery uses adaptive fallback polling at 2, 5, 10, then 30 seconds while the API is absent. Once detected, `toolchange` remains immediate and a conservative 30-second compatibility refresh detects replaced or disappearing experimental implementations.

## Voice and localization

The primary Voice Mode is OpenAI Realtime speech-to-speech over WebRTC. Pressing the 48 px blue waveform button explicitly requests the microphone, starts one continuous session, uses semantic VAD, streams live user and assistant transcripts into Chat, plays the remote OpenAI voice track, and supports barge-in. English, Arabic, and Spanish follow the selected Buddy language; Arabic retains the existing RTL layout.

The Railway API owns the Realtime model, `marin` voice, language and trust instructions, VAD, session cap, and the only internal voice function. A voice action request re-enters the same `/agent/next` safety loop used by text. Unknown, malformed, stale, blocked, or unapproved WebMCP actions cannot execute. `SpeechRecognition`/`webkitSpeechRecognition` and `speechSynthesis` are retained only as a visible browser fallback when WebRTC or Realtime is unavailable.

Voice Mode exposes separate connecting, microphone, peer, data-channel, speech, transcript, model-processing, playback, and idle phases. It stops its microphone tracks, peer connection, data channel, remote audio, analyser, listeners, and timers when ended, after the no-speech or post-speech-response timeout, if the microphone disappears, on page exit, or when Buddy closes. Developer Mode reports bounded connection diagnostics and playback failures without SDP, raw audio, credentials, or sensitive content.

Realtime input, output, and transcription consume paid OpenAI usage while Voice Mode is connected, even when no WebMCP action runs. Text-only use does not open a Realtime session. The explicit start, 30-second initial no-speech timeout, 20-second post-speech response timeout, two-minute general idle timeout, 15-minute default cap, two reconnect attempts, and server bootstrap limiter bound accidental use; production should also use provider spend alerts and limits.

Browser language is detected automatically. English, Arabic, and Spanish are implemented; Arabic switches the panel and conversation direction to RTL. Users can override language in Settings.

## Privacy

Buddy sends no full webpage content. The agent receives only a bounded goal, minimal structured tool definitions, and bounded action observations. Execution sends only JSON-Schema-validated arguments to the selected website tool. Settings remain in Chrome local storage. Technical request/response data appears only in opt-in Developer Mode and is not persisted.

## Demo walkthrough

1. Open an ordinary website—Buddy remains invisible.
2. Open Buddy Market—Buddy detects WebMCP and wakes up.
3. Enter: “Find me a gift under $50 that arrives before Thursday. Compare the best options, but don't buy anything without asking me.”
4. Watch Buddy use structured search, filter, and comparison actions.
5. Observe the marketplace UI change as those WebMCP actions execute.
6. Open Activity to inspect the human-readable execution history.
7. Continue to a consequential action and inspect the approval card.
8. Cancel once to demonstrate that nothing executes.
9. Repeat the action and choose **Approve once**.
10. Confirm the updated cart or result; optionally demonstrate Voice Mode and Developer Mode.

## Deployment

The Playground is a static Vite app. After `npm run build -w @buddy/playground`, deploy `apps/playground/dist` to any HTTPS static host. For Chrome's origin trial, add the issued origin-trial token as directed by Chrome's program documentation. The production API and extension are separate deployments; follow [PRODUCTION.md](./PRODUCTION.md).

## Known limitations

- WebMCP remains an experimental Community Group draft; Chrome 149+ flag or origin trial is currently required.
- The deterministic provider is intentionally limited to repeatable tests and demos; the extension requires the remote API.
- Native speech recognition availability and language quality vary by Chrome platform.
- Cross-site workflows, encrypted sync, spending limits, site trust scores, and temporary grants are deliberately future work.
- Automated native-WebMCP E2E still requires a compatible Chrome binary with WebMCP enabled. Deterministic React integration tests cover detection, tool changes, execution, approval, cancellation, repair, voice, RTL, dragging, malicious text, and reduced motion without depending on that external browser setup.

## Screenshots

- `docs/screenshots/playground.png` — add after final hosted capture
- `docs/screenshots/approval.png` — add after final hosted capture
- `docs/screenshots/arabic-rtl.png` — add after final hosted capture

## Hackathon

Built for the [WebMCP Hackathon](https://webmcp.devpost.com/). Buddy is not a chatbot with eyes and not a protocol inspector. It is a portable human interface for capabilities that websites intentionally expose.
