import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeVoiceClient, microphoneConstraints, parseBuddyToolRequest, type RealtimeSessionProvider, type RealtimeVoiceState, type VoiceTranscriptUpdate } from './realtime';

class FakeTrack {
  stop = vi.fn();
  private ended: (() => void) | undefined;
  addEventListener(type: string, handler: () => void) { if (type === 'ended') this.ended = handler; }
  removeEventListener(type: string, handler: () => void) { if (type === 'ended' && this.ended === handler) this.ended = undefined; }
  end() { this.ended?.(); }
}
class FakeStream {
  track = new FakeTrack();
  getAudioTracks() { return [this.track] as unknown as MediaStreamTrack[]; }
  getTracks() { return [this.track] as unknown as MediaStreamTrack[]; }
}
class FakeChannel {
  readyState: RTCDataChannelState = 'connecting';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 'closed'; this.onclose?.(); }
  open() { this.readyState = 'open'; this.onopen?.(); }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent); }
}
class FakePeer {
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  localDescription: RTCSessionDescription | null = null;
  channel = new FakeChannel();
  closed = false;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  createDataChannel() { return this.channel as unknown as RTCDataChannel; }
  addTrack = vi.fn();
  async createOffer() { return { type: 'offer' as RTCSdpType, sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }; }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description as RTCSessionDescription; }
  async setRemoteDescription() { this.connectionState = 'connected'; }
  close() { this.closed = true; this.connectionState = 'closed'; }
}

const answer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

function harness(overrides: { getUserMedia?: ReturnType<typeof vi.fn>; onToolRequest?: ReturnType<typeof vi.fn> } = {}) {
  const stream = new FakeStream();
  const getUserMedia = overrides.getUserMedia ?? vi.fn(async () => stream as unknown as MediaStream);
  const peers: FakePeer[] = [];
  const provider: RealtimeSessionProvider = { supported: true, createSession: vi.fn(async () => ({ requestId: 'req-safe', sdp: answer, model: 'gpt-realtime-2.1', voice: 'marin', vadMode: 'semantic_vad' as const, maxSessionSeconds: 900 })) };
  const states: RealtimeVoiceState[] = []; const transcripts: VoiceTranscriptUpdate[] = [];
  const audio = { autoplay: false, srcObject: null, setAttribute: vi.fn(), play: vi.fn(async () => undefined), pause: vi.fn(), remove: vi.fn() } as unknown as HTMLAudioElement;
  const onToolRequest = overrides.onToolRequest ?? vi.fn(async () => ({ status: 'completed' as const, message: 'Safe result' }));
  const client = new RealtimeVoiceClient({
    provider,
    mediaDevices: { getUserMedia: getUserMedia as unknown as MediaDevices['getUserMedia'] },
    createPeerConnection: () => { const peer = new FakePeer(); peers.push(peer); return peer as unknown as RTCPeerConnection; },
    createAudioElement: () => audio,
    onState: (state) => states.push(state),
    onTranscript: (update) => transcripts.push(update),
    onToolRequest,
    onDiagnostics: vi.fn(),
  });
  return { client, stream, getUserMedia, peers, provider, states, transcripts, audio, onToolRequest };
}

beforeEach(() => {
  vi.stubGlobal('RTCPeerConnection', FakePeer);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } });
  vi.stubGlobal('AudioContext', undefined);
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('RealtimeVoiceClient', () => {
  it('requests the microphone only after explicit start and uses production audio constraints', async () => {
    const subject = harness(); expect(subject.getUserMedia).not.toHaveBeenCalled();
    await subject.client.start('en');
    expect(subject.getUserMedia).toHaveBeenCalledWith({ audio: microphoneConstraints(), video: false });
    expect(subject.provider.createSession).toHaveBeenCalledWith(expect.stringContaining('m=audio'), 'en');
    expect(subject.states[0]).toBe('CONNECTING');
  });

  it('deduplicates concurrent starts into one microphone and one Realtime session', async () => {
    const subject = harness();
    await Promise.all([subject.client.start('en'), subject.client.start('en')]);
    expect(subject.getUserMedia).toHaveBeenCalledOnce(); expect(subject.provider.createSession).toHaveBeenCalledOnce(); expect(subject.peers).toHaveLength(1);
    subject.client.stop();
  });

  it('surfaces permission denial and releases a partially-created session', async () => {
    const denied = new DOMException('denied', 'NotAllowedError'); const subject = harness({ getUserMedia: vi.fn(async () => { throw denied; }) });
    await expect(subject.client.start('en')).rejects.toBe(denied); expect(subject.states).toContain('ERROR'); expect(subject.client.currentDiagnostics.microphoneState).toBe('inactive');
  });

  it('maps VAD, transcript, speaking, and interruption events without executing page APIs', async () => {
    const subject = harness(); await subject.client.start('ar'); const channel = subject.peers[0]?.channel; expect(channel).toBeTruthy(); channel?.open();
    channel?.message({ type: 'response.created', response: { id: 'resp-1' } }); channel?.message({ type: 'output_audio_buffer.started' });
    channel?.message({ type: 'response.output_audio_transcript.delta', response_id: 'resp-1', delta: 'مر' });
    channel?.message({ type: 'response.output_audio_transcript.done', response_id: 'resp-1', transcript: 'مرحبا' });
    channel?.message({ type: 'input_audio_buffer.speech_started' });
    expect(subject.states).toEqual(expect.arrayContaining(['LISTENING', 'THINKING', 'BUDDY_SPEAKING', 'USER_SPEAKING']));
    expect(subject.transcripts).toEqual([{ key: 'resp-1', role: 'assistant', text: 'مر', final: false }, { key: 'resp-1', role: 'assistant', text: 'مرحبا', final: true }]);
    expect(channel?.sent.map((value) => JSON.parse(value).type)).toEqual(expect.arrayContaining(['response.cancel', 'output_audio_buffer.clear']));
  });

  it('accepts only the internal Buddy request and returns bounded function output', async () => {
    const subject = harness(); await subject.client.start('es'); const channel = subject.peers[0]?.channel; channel?.open();
    channel?.message({ type: 'response.output_item.done', item: { type: 'function_call', name: 'buddy_webmcp_request', call_id: 'call-1', arguments: '{"request":"Show the latest articles"}' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(subject.onToolRequest).toHaveBeenCalledWith('Show the latest articles', expect.any(Object));
    const sent = channel?.sent.map((value) => JSON.parse(value)) ?? [];
    expect(sent).toContainEqual(expect.objectContaining({ type: 'conversation.item.create', item: expect.objectContaining({ type: 'function_call_output', call_id: 'call-1' }) }));
    channel?.message({ type: 'response.output_item.done', item: { type: 'function_call', name: 'executeTool', call_id: 'call-2', arguments: '{}' } });
    expect(subject.onToolRequest).toHaveBeenCalledTimes(1);
  });

  it('closes the channel, peer, remote audio, and every microphone track', async () => {
    const subject = harness(); await subject.client.start('en'); const peer = subject.peers[0]; const channel = peer?.channel; channel?.open();
    subject.client.stop();
    expect(subject.stream.track.stop).toHaveBeenCalledOnce(); expect(peer?.closed).toBe(true); expect(channel?.readyState).toBe('closed'); expect(subject.audio.pause).toHaveBeenCalled(); expect(subject.audio.remove).toHaveBeenCalled(); expect(subject.client.currentState).toBe('IDLE');
  });

  it('ends Voice Mode and releases transport when the microphone device disappears', async () => {
    const subject = harness(); await subject.client.start('en'); const peer = subject.peers[0]; peer?.channel.open();
    subject.stream.track.end();
    expect(subject.stream.track.stop).toHaveBeenCalledOnce(); expect(peer?.closed).toBe(true); expect(subject.client.currentState).toBe('IDLE'); expect(subject.client.currentDiagnostics.lastSafeErrorCode).toBe('MICROPHONE_DEVICE_LOST');
  });

  it('ends an open session after two minutes without speech', async () => {
    vi.useFakeTimers();
    const subject = harness(); await subject.client.start('en'); const peer = subject.peers[0]; peer?.channel.open();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(subject.stream.track.stop).toHaveBeenCalledOnce(); expect(peer?.closed).toBe(true); expect(subject.client.currentState).toBe('IDLE'); expect(subject.client.currentDiagnostics.lastSafeErrorCode).toBe('VOICE_IDLE_TIMEOUT');
    vi.useRealTimers();
  });

  it('bounds reconnect attempts and then releases the microphone', async () => {
    vi.useFakeTimers();
    const subject = harness(); await subject.client.start('en'); subject.peers[0]?.channel.open();
    vi.mocked(subject.provider.createSession).mockRejectedValue(new Error('provider down'));
    const first = subject.peers[0]; if (!first) throw new Error('Missing peer.'); first.connectionState = 'failed'; first.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(subject.peers).toHaveLength(3); expect(subject.states).toContain('RECONNECTING'); expect(subject.states).toContain('ERROR'); expect(subject.stream.track.stop).toHaveBeenCalledOnce(); expect(subject.client.currentDiagnostics.reconnectAttempt).toBe(2);
    vi.useRealTimers();
  });
});

describe('Realtime tool request validation', () => {
  it('rejects unknown fields, malformed values, and oversized requests', () => {
    expect(parseBuddyToolRequest({ request: 'Search safely' })).toBe('Search safely');
    expect(parseBuddyToolRequest({ request: 'Search', toolName: 'native-tool' })).toBeUndefined();
    expect(parseBuddyToolRequest({ request: 'x'.repeat(2_001) })).toBeUndefined();
    expect(parseBuddyToolRequest(['Search'])).toBeUndefined();
  });
});
