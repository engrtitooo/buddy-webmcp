# Buddy architecture

## Boundaries

### WebMCP layer

`WebMCPAdapter` is the only component that discovers or invokes page tools. It keeps native `RegisteredTool` objects private, exposes plain metadata to the application, refreshes on `toolchange`, and rejects execution when a tool disappeared. The Playground uses `registerTools` to register narrowly scoped tools with individual abort signals.

No generic DOM click, type, or scrape primitives exist.

### Agent layer

`AgentProvider` separates intent interpretation from execution. `MockAgentProvider` is deterministic and local. `RemoteAgentProvider` talks only to the server proxy. Plans contain explicit tool names, arguments, labels, and risk categories; the executor refuses tools that are no longer available.

### Safety layer

`CapabilityMapper` turns names and descriptions into grouped consumer capabilities. `PermissionEngine` combines classified risk with local rules and returns `ALLOW`, `ASK`, or `BLOCK`. The UI owns the paused plan cursor, so approval resumes precisely after the gated step.

### Presentation layer

`BuddyApp` runs in a closed Shadow DOM. The mascot state machine covers sleeping, detected, idle, listening, thinking, executing, waiting for approval, success, and error. Conversation, Activity, Capabilities, and Settings are separate views; schemas stay hidden unless Developer Mode is enabled.

### Persistence and voice

Preferences use `chrome.storage.local`, with `localStorage` only for non-extension previews. Speech is abstracted behind `SpeechToTextProvider` and `TextToSpeechProvider` contracts.

## Data minimization

The planner sees a goal and tool definitions. It does not see the page DOM. Each site tool receives only its planned structured arguments. Results are truncated for display, not persisted, and treated as untrusted observations rather than new instructions.

## Future-compatible seams

- Additional model and speech providers
- Cross-site coordinators above the per-site agent
- Encrypted sync replacing local settings storage
- Temporary, time-limited, or budget-scoped approvals
- Site trust and tool reputation signals added before Permission Engine evaluation
