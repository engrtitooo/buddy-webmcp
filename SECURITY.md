# Security and privacy

## Assets

- User intent and personal agent rules
- Authority to invoke website actions
- Structured tool arguments and results
- Server-side model credentials
- Integrity of approval decisions

## Trust boundaries

The webpage, tool names, descriptions, schemas, and results are untrusted. The extension UI and approval policy are trusted extension code. The optional API proxy is a separate server trust boundary.

## Controls

- Isolated Manifest V3 content script and closed Shadow DOM
- No page-visible bridge, `window.postMessage` RPC, or privileged extension API exposure
- Explicit WebMCP feature detection and allowed methods
- Native `RegisteredTool` objects never serialized to page code
- Execution only when the reviewed tool-set revision is still current
- Tool descriptions are treated as data; the remote planner is instructed to ignore embedded instructions
- Server and client validate every planned tool name and recompute risk from the current tool definition
- Consequential risk classes require approval by default; deletion is blocked by default
- Cancel never invokes the gated tool
- No API key in browser code; loopback-only default, exact CORS allowlist, originless-request denial, bounded inputs, and per-client rate limiting on the proxy
- No full-page capture, browsing history, cookies, or hidden DOM automation
- Developer diagnostics are opt-in and not persisted

## Residual risks

WebMCP annotations are hints supplied by an untrusted site, so Buddy does not let `readOnlyHint` override obviously consequential names. A malicious site can still lie in its implementation or return adversarial text; users should judge the current site identity shown in Buddy's header. Model prompt-injection defenses reduce but cannot eliminate probabilistic model risk, so provider output is runtime-validated and approval remains a deterministic layer outside the model.

The optional model proxy is safe for local development by default. Do not expose it directly to the public internet: place public deployments behind authenticated infrastructure with durable distributed rate limits and provider-usage monitoring.

## Reporting

Please report vulnerabilities privately to the repository maintainers before public disclosure. Include affected version, reproduction steps, expected impact, and whether a malicious site is required.
