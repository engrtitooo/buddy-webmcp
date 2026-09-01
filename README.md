# Buddy

**Buddy is the friendly interface for the agentic web.**

Buddy is a consumer-facing Chrome companion that wakes up when a website exposes [WebMCP](https://developer.chrome.com/docs/ai/webmcp) tools, translates those tools into everyday capabilities, and helps a person complete goals through text or voice—with explicit approval before consequential actions.

> WebMCP gives websites capabilities. Buddy gives those capabilities a face, a voice, and your rules.

## The problem

WebMCP gives agents reliable, structured website actions, but raw tool names and schemas are not a consumer interface. People need to understand what a site allows, state an outcome rather than choose a function, and remain in control when an action sends, buys, submits, shares, or deletes.

## The solution

Buddy is completely absent on ordinary sites. On compatible sites it wakes up, summarizes capabilities in human language, accepts a goal, selects and validates one advertised WebMCP action at a time, executes safe work, and pauses at a visible approval card when the user's rules require it.

Buddy Market is the included WebMCP Playground: a polished fictional marketplace with 20 products and no real transactions. Search, filters, comparisons, cart state, delivery preferences, and the simulated checkout visibly respond to WebMCP execution.

## Current WebMCP implementation

This code targets the current Community Group draft and Chrome 149 origin trial surface:

- `document.modelContext.registerTool()` for Playground tools
- `document.modelContext.getTools()` for discovery
- `document.modelContext.executeTool()` for execution
- `toolchange` for additions, removals, and replacements
- `annotations.readOnlyHint` and `annotations.untrustedContentHint`
- `AbortController` signals for tool lifetime
- JSON Schema input definitions and JSON-serializable structured results
- feature detection and graceful unsupported-browser behavior

Chrome's official security guidance states that extension content scripts can query and execute WebMCP tools. Buddy therefore reads the API directly from its isolated content-script world and does **not** expose a MAIN-world bridge or privileged message API to page JavaScript.

For local development, use Chrome 149+ and enable `chrome://flags/#enable-webmcp-testing`, then relaunch Chrome. A production Playground can instead participate in the WebMCP origin trial.

## Architecture

```text
User goal
  → extension service worker → POST /agent/next
  → one validated next action using current WebMCP tools only
  → Ajv JSON Schema validation
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

Its static content script runs on HTTP(S) pages but renders nothing until tools exist. A service worker can contact only the build-time API origin in `host_permissions`. It requests no tabs, scripting, cookies, identity, browsing history, clipboard, microphone, or network-interception permission.

## AI providers

`MockAgentProvider` is deterministic and reserved for tests or explicitly wired demos. The production extension never silently falls back to it.

The extension's `ExtensionAgentProvider` sends typed messages to its service worker, which calls `apps/api`. The proxy uses the OpenAI Responses API with strict Structured Outputs, defaults to `gpt-5.6-luna`, validates and bounds inputs, recomputes every risk locally, adds timeouts/request IDs, and sets `store: false`. Invalid model-proposed arguments become bounded rejected observations so the next turn can repair them; they are never executed. Put `OPENAI_API_KEY` only in the server environment; never in a `VITE_*` variable or extension bundle.

```bash
cp .env.example .env
npm run build -w @buddy/api
npm start -w @buddy/api
```

The proxy binds to `127.0.0.1` by default, accepts only exact origins in `ALLOWED_ORIGINS`, rejects originless requests, and rate-limits clients. Add the exact Chrome extension origin when using a packaged extension. See [PRODUCTION.md](./PRODUCTION.md) for deployment and Chrome Web Store release steps. A public deployment must sit behind an authenticated, durably rate-limited gateway; CORS is not authentication.

## Approval and personal rules

Tools are mapped locally to `READ`, `LOW_RISK_WRITE`, `EXTERNAL_COMMUNICATION`, `FINANCIAL`, `DESTRUCTIVE`, or `SENSITIVE`. Remote risk labels are never authoritative, consequential names override `readOnlyHint`, and the Permission Engine combines the normalized risk with locally stored user rules.

- `ALLOW`: execute and record the step.
- `ASK`: pause the plan and show what will happen, why approval is needed, the site, risk, and complete human-readable argument values. **Approve once** resumes the same plan; **Cancel** executes nothing. Raw argument JSON is available only in Developer Mode.
- `BLOCK`: stop and explain which personal rule prevented the action.

The default rules ask before submissions, messages, purchases/reservations, and sensitive sharing, and block deletion. Financial and destructive actions never run silently.

Agent runs are bound to the current WebMCP tool-set revision. If a site adds, removes, or replaces a tool while reasoning or while approval is pending, Buddy cancels the run. The loop is capped at ten decisions and rejects an identical repeated tool call.

## Voice and localization

Voice is provider-based. The MVP uses browser `SpeechRecognition`/`webkitSpeechRecognition` and `speechSynthesis`, defaults to an editable transcript review, offers an explicit auto-send setting, never auto-speaks unless enabled, and falls back to text when unavailable or denied.

Browser language is detected automatically. English, Arabic, and Spanish are implemented; Arabic switches the panel and conversation direction to RTL. Users can override language in Settings.

## Privacy

Buddy sends no full webpage content. The agent receives only a bounded goal, minimal structured tool definitions, and bounded action observations. Execution sends only JSON-Schema-validated arguments to the selected website tool. Settings remain in Chrome local storage. Technical request/response data appears only in opt-in Developer Mode and is not persisted.

## Demo walkthrough

1. Visit an ordinary site: Buddy is not rendered.
2. Open Buddy Market: Buddy wakes and announces available capabilities.
3. Enter: “Find me a gift under $50 that arrives before Thursday. Compare the best options, but don't buy anything without asking me.”
4. Watch Buddy search, filter, and compare while the product grid updates.
5. Buddy pauses before `add_to_cart`; inspect the clear approval card.
6. Cancel to prove no action occurs, or approve once to resume and update the cart.
7. Open Activity to show the human-readable trail; optionally enable Developer Mode to reveal underlying tool names.

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
