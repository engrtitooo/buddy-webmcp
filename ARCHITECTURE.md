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

Preferences use `chrome.storage.local`, with `localStorage` only for non-extension previews. Realtime voice is opt-in and begins only from the waveform button. The content script acquires an audio-only `MediaStream`, connects an `RTCPeerConnection`, and receives OpenAI audio as a remote WebRTC track. Its SDP offer crosses the typed extension message boundary to the service worker, then `POST /realtime/session`; no provider credential or arbitrary session configuration enters the browser bundle.

The API uses OpenAI's unified WebRTC interface. It combines bounded SDP with a server-owned `gpt-realtime-2.1` session using the `marin` voice, `gpt-live-transcribe`, semantic VAD (`eagerness: auto`, automatic response creation, interruption enabled), and one internal `buddy_webmcp_request` function. The model never receives native `RegisteredTool` handles. A function call contains only natural-language intent and re-enters the canonical agent loop, so live inventory validation, schema validation, revision binding, local risk, `PermissionEngine`, and the visual approval card remain authoritative.

`RealtimeVoiceClient` owns the explicit voice state machine, transcript upserts, WebRTC interruption events, two bounded reconnect attempts, a two-minute speech-idle timeout, the configured session lifetime, microphone-device-loss handling, safe diagnostics, and cleanup of peer/data channel/media/audio/analyser/timers. Browser `SpeechRecognition` and `speechSynthesis` remain a visibly disclosed fallback only.

## Voice threat model

- Exact origin checks, optional API authentication, a dedicated bootstrap limiter, `application/sdp` enforcement, a 64 KB cap, and structural SDP validation constrain session creation.
- Model, voice, instructions, VAD, transcription, and available Realtime function definitions are controlled only by the API environment and source code.
- `OpenAI-Safety-Identifier` is a server-generated HMAC pseudonym derived from bounded connection context; raw names, emails, API keys, authorization headers, SDP, audio, and transcript content are not logged.
- Tool descriptions, schemas, transcripts, page content, and results are explicitly untrusted. Realtime cannot name or execute a native page tool; its intent is replanned against the current canonical inventory.
- Approval remains visual. Spoken assent never resumes a pending call. Revision checks and the single pending-call slot prevent stale or duplicate execution.
- Closing Buddy, ending Voice Mode, losing all Realtime reconnect attempts, microphone device loss, speech inactivity, tool removal, page exit, and component unload release the microphone and terminate transport resources.

## Data minimization

The agent sees a bounded goal, current tool definitions, and bounded structured observations. It does not see the page DOM, cookies, history, or page text. Each site tool receives only its validated structured arguments. Results are truncated before the next iteration, not persisted, and treated as untrusted observations rather than instructions.

## Future-compatible seams

- Additional model and speech providers
- Cross-site coordinators above the per-site agent
- Encrypted sync replacing local settings storage
- Temporary, time-limited, or budget-scoped approvals
- Site trust and tool reputation signals added before Permission Engine evaluation
