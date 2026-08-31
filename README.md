# Buddy

**Buddy is the friendly interface for the agentic web.**

Buddy is a consumer-facing Chrome companion that wakes up when a website exposes [WebMCP](https://developer.chrome.com/docs/ai/webmcp) tools, translates those tools into everyday capabilities, and helps a person complete goals through text or voice—with explicit approval before consequential actions.

> WebMCP gives websites capabilities. Buddy gives those capabilities a face, a voice, and your rules.

## The problem

WebMCP gives agents reliable, structured website actions, but raw tool names and schemas are not a consumer interface. People need to understand what a site allows, state an outcome rather than choose a function, and remain in control when an action sends, buys, submits, shares, or deletes.

## The solution

Buddy lives unobtrusively at the bottom-right of webpages. On ordinary sites it rests. On compatible sites it wakes up, summarizes capabilities in human language, accepts a goal, plans only over advertised WebMCP tools, executes safe work, and pauses at a visible approval card when the user's rules require it.

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
  → AgentProvider (mock or remote)
  → Plan using current WebMCP tools only
  → PermissionEngine (tool risk + annotations + local rules)
  → ALLOW / ASK / BLOCK
  → WebMCPAdapter.executeTool()
  → structured result
  → human activity trail + visible site update
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
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select `apps/extension/dist`.
6. Enable the WebMCP testing flag described above and open Buddy Market.

The extension uses one Chrome permission:

- `storage`: saves language, theme, voice preference, developer mode, and personal approval rules locally.

Its static content script runs on HTTP(S) pages so Buddy can rest on ordinary sites and wake on compatible sites. It requests no tabs, scripting, cookies, identity, browsing history, clipboard, or network interception permission.

## AI providers

`MockAgentProvider` is the deterministic default and works without a network or key. It makes the recorded demo repeatable.

`RemoteAgentProvider` calls the optional `apps/api` proxy. The proxy uses the OpenAI Responses API with Structured Outputs, validates and bounds inputs, recomputes every planned risk locally from the current tool definition, and sets `store: false`. Put `OPENAI_API_KEY` only in the server environment; never in a `VITE_*` variable or extension bundle.

```bash
cp .env.example .env
npm run build -w @buddy/api
npm start -w @buddy/api
```

The proxy binds to `127.0.0.1` by default, accepts only exact origins in `ALLOWED_ORIGINS`, rejects originless requests, and rate-limits clients. Add the exact Chrome extension origin when using a packaged extension. A public deployment must sit behind an authenticated, rate-limited gateway; CORS is not authentication.

## Approval and personal rules

Tools are mapped locally to `READ`, `LOW_RISK_WRITE`, `EXTERNAL_COMMUNICATION`, `FINANCIAL`, `DESTRUCTIVE`, or `SENSITIVE`. Remote risk labels are never authoritative, consequential names override `readOnlyHint`, and the Permission Engine combines the normalized risk with locally stored user rules.

- `ALLOW`: execute and record the step.
- `ASK`: pause the plan and show what will happen, why approval is needed, and the relevant values. **Approve once** resumes the same plan; **Cancel** executes nothing.
- `BLOCK`: stop and explain which personal rule prevented the action.

The default rules ask before submissions, messages, purchases/reservations, and sensitive sharing, and block deletion. Financial and destructive actions never run silently.

Plans are bound to the current WebMCP tool-set revision. If a site adds, removes, or replaces a tool while planning or while approval is pending, Buddy stops and asks the user to review a fresh plan.

## Voice and localization

Voice is provider-based. The MVP uses browser `SpeechRecognition`/`webkitSpeechRecognition` and `speechSynthesis`, exposes an editable transcript, never auto-speaks unless enabled, and falls back to text when unavailable or denied.

Browser language is detected automatically. English, Arabic, and Spanish are implemented; Arabic switches the panel and conversation direction to RTL. Users can override language in Settings.

## Privacy

Buddy sends no full webpage content. Planning receives only the user's goal and minimal, structured tool definitions. Execution sends arguments only to the selected website tool. Settings remain in Chrome local storage. Sensitive arguments are omitted from normal activity copy; technical request/response data appears only in opt-in Developer Mode and is not persisted.

## Demo walkthrough

1. Visit an ordinary site: Buddy is asleep.
2. Open Buddy Market: Buddy wakes and announces available capabilities.
3. Enter: “Find me a gift under $50 that arrives before Thursday. Compare the best options, but don't buy anything without asking me.”
4. Watch Buddy search, filter, and compare while the product grid updates.
5. Buddy pauses before `add_to_cart`; inspect the clear approval card.
6. Cancel to prove no action occurs, or approve once to resume and update the cart.
7. Open Activity to show the human-readable trail; optionally enable Developer Mode to reveal underlying tool names.

## Deployment

The Playground is a static Vite app. After `npm run build -w @buddy/playground`, deploy `apps/playground/dist` to any HTTPS static host. For Chrome's origin trial, add the issued origin-trial token as directed by Chrome's program documentation.

## Known limitations

- WebMCP remains an experimental Community Group draft; Chrome 149+ flag or origin trial is currently required.
- The deterministic planner intentionally handles the strongest hackathon shopping flows, not arbitrary domain reasoning. The remote provider is the extensibility path.
- Native speech recognition availability and language quality vary by Chrome platform.
- Cross-site workflows, encrypted sync, spending limits, site trust scores, and temporary grants are deliberately future work.
- Automated browser E2E against native WebMCP requires a Chrome 149 test binary with the experimental flag; unit/integration coverage validates the adapter and approval primitives today.

## Screenshots

- `docs/screenshots/playground.png` — add after final hosted capture
- `docs/screenshots/approval.png` — add after final hosted capture
- `docs/screenshots/arabic-rtl.png` — add after final hosted capture

## Hackathon

Built for the [WebMCP Hackathon](https://webmcp.devpost.com/). Buddy is not a chatbot with eyes and not a protocol inspector. It is a portable human interface for capabilities that websites intentionally expose.
