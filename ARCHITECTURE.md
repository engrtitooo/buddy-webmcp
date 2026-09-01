# Buddy architecture

## Boundaries

### WebMCP layer

`WebMCPAdapter` is the only component that discovers or invokes page tools. It keeps native `RegisteredTool` objects private, exposes bounded plain metadata to the application, refreshes on `toolchange`, polls defensively for SPA/API lifecycle changes, and rejects execution when the reviewed inventory revision changed. The Playground uses `registerTools` to register narrowly scoped tools with individual abort signals.

No generic DOM click, type, or scrape primitives exist.

### Agent layer

`AgentProvider` selects one next action at a time. The loop is `next decision → validate → permission → execute one tool → observe → repeat/final`. It is capped at ten turns, rejects repeated identical calls, propagates cancellation, and binds every call to one WebMCP inventory revision. `MockAgentProvider` is deterministic for tests and demos. The production extension always uses `ExtensionAgentProvider`, which can reach the configured API only through the Manifest V3 service worker.

### Safety layer

`CapabilityMapper` turns names and descriptions into grouped consumer capabilities. Ajv validates arguments against the selected tool's JSON Schema before permission or execution. `PermissionEngine` combines locally recomputed risk with local rules and returns `ALLOW`, `ASK`, or `BLOCK`; consequential names override malicious `readOnlyHint` values. The UI owns a single paused call, so cancel invokes nothing and approval resumes only after a fresh revision check.

### Presentation layer

`BuddyApp` runs in a closed Shadow DOM with its stylesheet injected inside that same root. It renders nothing when no tools are available. The mascot state machine covers detected, idle, listening, thinking, executing, waiting for approval, success, and error; supports pointer gaze, keyboard-accessible drag placement, viewport clamping, reduced motion, RTL, and persisted position. Conversation, Activity, Capabilities, and Settings are separate views.

### Persistence and voice

Preferences use `chrome.storage.local`, with `localStorage` only for non-extension previews. Speech is abstracted behind `SpeechToTextProvider` and `TextToSpeechProvider` contracts.

## Data minimization

The agent sees a bounded goal, current tool definitions, and bounded structured observations. It does not see the page DOM, cookies, history, or page text. Each site tool receives only its validated structured arguments. Results are truncated before the next iteration, not persisted, and treated as untrusted observations rather than instructions.

## Future-compatible seams

- Additional model and speech providers
- Cross-site coordinators above the per-site agent
- Encrypted sync replacing local settings storage
- Temporary, time-limited, or budget-scoped approvals
- Site trust and tool reputation signals added before Permission Engine evaluation
