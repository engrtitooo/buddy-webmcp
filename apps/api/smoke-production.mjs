import { randomBytes, randomUUID } from 'node:crypto';
import { resolveApiUrl } from '../extension/build.mjs';

// An opt-in live check: five synthetic text turns and one SDP bootstrap. No tools,
// microphone, audio, provider key, or browser credentials are used by this script.
const base = resolveApiUrl(true).href.replace(/\/$/, '');
const expectedCommit = process.argv.find((argument) => argument.startsWith('--expected-commit='))?.split('=')[1];
const extensionOrigin = () => `chrome-extension://${randomBytes(16).toString('hex').replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)))}`;
const origin = extensionOrigin();
const secondOrigin = extensionOrigin();
const safeId = (value) => /^[0-9a-f-]{36}$/i.test(value ?? '') ? value : undefined;

async function request(path, init = {}) {
  try { return await fetch(`${base}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
  catch (error) { throw new Error(`${path}: ${error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR'}`); }
}

function report(path, response, extra = {}) {
  console.log(JSON.stringify({ path, status: response.status, requestId: safeId(response.headers.get('x-request-id')), ...extra }));
}

function requireStatus(response, status, path) {
  if (response.status !== status) throw new Error(`${path}: expected HTTP ${status}, received ${response.status}; request ${safeId(response.headers.get('x-request-id')) ?? 'unknown'}`);
}

async function checkSiteScope() {
  const tool = {
    name: 'search_catalog', description: 'Search a synthetic product catalog.', origin: 'https://smoke.invalid',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  };
  const refusal = 'I can only help with this website and its available WebMCP capabilities.';
  async function decide(goal, check, context = {}) {
    const response = await request('/agent/next', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: randomUUID(), turn: 0, goal, tools: [tool], observations: [], ...context }),
    });
    requireStatus(response, 200, '/agent/next');
    const decision = await response.json();
    report('/agent/next', response, { check, decisionKind: decision.kind });
    return decision;
  }

  const action = await decide('Search the catalog for headphones using search_catalog.', 'valid-site-request');
  if (action.kind !== 'tool_call' || action.toolName !== tool.name || !/headphones/i.test(action.args?.query ?? '')) throw new Error('/agent/next: valid site request did not select the advertised search.');
  // Inspect the proposed action only; never execute a site tool.

  const capabilities = await decide('What can you do on this website? Answer from the available capabilities.', 'capability-question');
  if (capabilities.kind !== 'final' || typeof capabilities.message !== 'string' || !/search/i.test(capabilities.message) || !/catalog|products/i.test(capabilities.message)) throw new Error('/agent/next: capability question did not receive a direct site-related answer.');

  const observations = [{ callId: 'search-result', toolName: tool.name, args: action.args, outcome: 'success', result: { items: [{ name: 'Studio Headphones', price: 49, currency: 'USD' }] } }];
  const followUp = await decide('How much does that result cost?', 'tool-result-follow-up', { turn: 1, observations });
  if (followUp.kind !== 'final' || typeof followUp.message !== 'string' || !/49|forty[- ]nine/i.test(followUp.message)) throw new Error('/agent/next: tool-result follow-up was not answered directly from the supplied result.');

  for (const context of [{}, { turn: 1, observations }]) {
    const unrelated = await decide('What is the capital of France?', context.turn ? 'refusal-after-site-result' : 'unrelated-question-refusal', context);
    if (unrelated.kind !== 'final' || unrelated.message !== refusal) throw new Error('/agent/next: unrelated question did not receive only the scope refusal.');
  }
  console.log('Website scope checks passed: site action, capabilities, result follow-up, and unrelated-question refusals.');
}

async function main() {
  const health = await request('/health');
  requireStatus(health, 200, '/health');
  const info = await health.json();
  if (info.status !== 'ok' || info.contractVersion !== 2 || (expectedCommit && info.commit !== expectedCommit)) throw new Error('Health or deployed commit does not match expectations.');
  report('/health', health, { commit: /^[0-9a-f]{40}$/i.test(info.commit) ? info.commit : 'unknown', contractVersion: info.contractVersion });

  for (const path of ['/agent/next', '/realtime/session']) {
    for (const caller of [origin, secondOrigin]) {
      const preflight = await request(path, { method: 'OPTIONS', headers: { origin: caller, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-buddy-locale' } });
      requireStatus(preflight, 204, path);
      if (preflight.headers.get('access-control-allow-origin') !== caller) throw new Error(`${path}: extension origin not permitted.`);
    }
    for (const caller of ['https://arbitrary-web-origin.invalid', 'null', undefined]) {
      const blocked = await request(path, { method: 'POST', headers: { ...(caller ? { origin: caller } : {}), 'content-type': 'application/json' }, body: '{}' });
      requireStatus(blocked, 403, path);
      if (blocked.headers.has('access-control-allow-origin')) throw new Error(`${path}: disallowed origin received CORS permission.`);
    }
  }
  console.log('Both routes accept independent Chrome IDs and reject arbitrary web, null, and originless callers.');

  await checkSiteScope();

  // A standards-shaped synthetic offer verifies server/provider negotiation only.
  // There is no peer or media stream; this does not test microphone or playback.
  const fingerprint = randomBytes(32).toString('hex').match(/../g).join(':').toUpperCase();
  const ice = [`a=ice-ufrag:${randomBytes(6).toString('hex')}`, `a=ice-pwd:${randomBytes(18).toString('hex')}`, 'a=ice-options:trickle', `a=fingerprint:sha-256 ${fingerprint}`, 'a=setup:actpass'];
  const offer = [
    'v=0', 'o=- 123456789 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1', 'a=extmap-allow-mixed', 'a=msid-semantic: WMS',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=rtcp:9 IN IP4 0.0.0.0', ...ice,
    'a=mid:0', 'a=sendrecv', 'a=rtcp-mux', 'a=rtcp-rsize', 'a=rtpmap:111 opus/48000/2', 'a=rtcp-fb:111 transport-cc', 'a=fmtp:111 minptime=10;useinbandfec=1',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', ...ice, 'a=mid:1', 'a=sctp-port:5000', 'a=max-message-size:262144', '',
  ].join('\r\n');
  const realtime = await request('/realtime/session', { method: 'POST', headers: { origin: secondOrigin, 'content-type': 'application/sdp', 'x-buddy-locale': 'en' }, body: offer });
  requireStatus(realtime, 201, '/realtime/session');
  const answer = await realtime.text();
  if (!answer.startsWith('v=0') || !answer.includes('m=audio') || answer.length > 64_000) throw new Error('/realtime/session: invalid SDP answer.');
  report('/realtime/session', realtime, { validSdpAnswer: true });
}

try { await main(); }
catch (error) {
  // Only our controlled validation messages are logged; parsing/transport internals are discarded.
  const message = error instanceof Error && /^(\/|Health|Both)/.test(error.message) ? error.message : 'Production smoke check failed.';
  console.error(message); process.exitCode = 1;
}
