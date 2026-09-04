import { AgentServiceError, SITE_SCOPE_INSTRUCTIONS, type Locale } from '@buddy/shared';

export type RealtimeVoiceState =
  | 'IDLE'
  | 'VOICE_CONNECTING'
  | 'MIC_ACQUIRED'
  | 'PEER_CONNECTING'
  | 'PEER_CONNECTED'
  | 'DATA_CHANNEL_OPEN'
  | 'LISTENING'
  | 'SPEECH_STARTED'
  | 'SPEECH_STOPPED'
  | 'USER_TRANSCRIPT'
  | 'MODEL_PROCESSING'
  | 'ASSISTANT_AUDIO_STARTED'
  | 'ASSISTANT_AUDIO_FINISHED'
  | 'WAITING_FOR_APPROVAL'
  | 'RECONNECTING'
  | 'ERROR'
  | 'STOPPING';

export interface RealtimeBootstrapResult {
  requestId: string;
  sdp: string;
  model: string;
  voice: string;
  vadMode: 'semantic_vad';
  maxSessionSeconds: number;
}

export interface RealtimeSessionProvider {
  supported: boolean;
  createSession(sdp: string, locale: Locale): Promise<RealtimeBootstrapResult>;
}

export interface RealtimeDiagnostics {
  model?: string;
  voice?: string;
  voiceMode: 'realtime' | 'browser-fallback';
  connectionState: RealtimeVoiceState;
  peerConnectionState?: RTCPeerConnectionState;
  iceState?: RTCIceConnectionState;
  dataChannelState?: RTCDataChannelState;
  microphoneState: 'inactive' | 'active';
  vadMode?: 'semantic_vad';
  sessionRequestId?: string;
  sessionHttpStatus?: number;
  reconnectAttempt: number;
  fallbackReason?: string;
  lastSafeErrorCode?: string;
  microphoneTrackState?: MediaStreamTrackState;
  sessionRequestSucceeded?: boolean;
  remoteTrackReceived?: boolean;
  speechStarted?: boolean;
  speechStopped?: boolean;
  userTranscriptCompleted?: boolean;
  responseCreated?: boolean;
  responseDone?: boolean;
  outputAudioTranscriptReceived?: boolean;
  audioPlaySucceeded?: boolean;
  lastEvent?: string;
}

export interface VoiceTranscriptUpdate {
  key: string;
  role: 'user' | 'assistant';
  text: string;
  final: boolean;
}

export interface VoiceToolResult {
  status: 'completed' | 'canceled' | 'blocked' | 'failed';
  message: string;
}

export interface VoiceToolControls {
  announceApprovalRequired(): void;
}

export interface RealtimeVoiceClientOptions {
  provider: RealtimeSessionProvider;
  onState(state: RealtimeVoiceState): void;
  onTranscript(update: VoiceTranscriptUpdate): void;
  onToolRequest(request: string, controls: VoiceToolControls): Promise<VoiceToolResult>;
  onDiagnostics(diagnostics: RealtimeDiagnostics): void;
  onMicrophoneLevel?(level: number): void;
  onError?(message: string, code: string): void;
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
  createPeerConnection?: () => RTCPeerConnection;
  createAudioElement?: () => HTMLAudioElement;
  timeouts?: Partial<{ microphoneMs: number; peerMs: number; dataChannelMs: number; noSpeechMs: number; postSpeechResponseMs: number }>;
}

const MAX_RECONNECTS = 2;
const RECONNECT_DELAYS = [500, 1_500] as const;
const IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUTS = { microphoneMs: 10_000, peerMs: 15_000, dataChannelMs: 15_000, noSpeechMs: 30_000, postSpeechResponseMs: 20_000 } as const;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const safeConnectionErrors = new Set(['WEBRTC_UNSUPPORTED', 'REALTIME_UNAVAILABLE', 'MICROPHONE_TIMEOUT', 'DATA_CHANNEL_CLOSED', 'PEER_CONNECTION_FAILED', 'SDP_OFFER_FAILED', 'PEER_CONNECTION_TIMEOUT', 'DATA_CHANNEL_TIMEOUT']);

export function supportsOpenAIRealtime(): boolean {
  return typeof RTCPeerConnection !== 'undefined' && typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

export function microphoneConstraints(): MediaTrackConstraints {
  return { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
}

export function parseBuddyToolRequest(value: unknown): string | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.request !== 'string') return undefined;
  const request = value.request.trim();
  return request && request.length <= 2_000 ? request : undefined;
}

export class RealtimeVoiceClient {
  private state: RealtimeVoiceState = 'IDLE';
  private diagnostics: RealtimeDiagnostics = { voiceMode: 'realtime', connectionState: 'IDLE', microphoneState: 'inactive', reconnectAttempt: 0 };
  private stream: MediaStream | undefined;
  private peer: RTCPeerConnection | undefined;
  private channel: RTCDataChannel | undefined;
  private audio: HTMLAudioElement | undefined;
  private audioContext: AudioContext | undefined;
  private analyserFrame: number | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private noSpeechTimer: ReturnType<typeof setTimeout> | undefined;
  private responseTimer: ReturnType<typeof setTimeout> | undefined;
  private startPromise: Promise<void> | undefined;
  private stopped = true;
  private connecting = false;
  private reconnectAttempt = 0;
  private currentResponseId: string | undefined;
  private readonly handledCalls = new Set<string>();
  private readonly trackEndedHandlers = new Map<MediaStreamTrack, () => void>();

  constructor(private readonly options: RealtimeVoiceClientOptions) {}

  get currentState(): RealtimeVoiceState { return this.state; }
  get currentDiagnostics(): RealtimeDiagnostics { return { ...this.diagnostics }; }

  start(locale: Locale): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (!this.stopped) return Promise.resolve();
    if (!this.options.provider.supported || !supportsOpenAIRealtime()) return Promise.reject(new Error('WEBRTC_UNSUPPORTED'));
    this.stopped = false;
    this.setState('VOICE_CONNECTING');
    this.startPromise = this.startInternal(locale).finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  private async startInternal(locale: Locale): Promise<void> {
    try {
      const mediaDevices = this.options.mediaDevices ?? navigator.mediaDevices;
      const mediaRequest = mediaDevices.getUserMedia({ audio: microphoneConstraints(), video: false });
      try { this.stream = await this.withTimeout(mediaRequest, this.timeouts.microphoneMs, 'MICROPHONE_TIMEOUT'); }
      catch (error) { void mediaRequest.then((lateStream) => lateStream.getTracks().forEach((track) => track.stop())).catch(() => undefined); throw error; }
      for (const track of this.stream.getAudioTracks()) {
        const onEnded = () => {
          if (this.stopped) return;
          this.options.onError?.('The microphone disconnected, so Buddy ended Voice Mode.', 'MICROPHONE_DEVICE_LOST');
          this.updateDiagnostics({ lastSafeErrorCode: 'MICROPHONE_DEVICE_LOST' });
          this.stop();
        };
        track.addEventListener?.('ended', onEnded);
        this.trackEndedHandlers.set(track, onEnded);
      }
      const microphoneTrackState = this.stream.getAudioTracks()[0]?.readyState;
      this.updateDiagnostics({ microphoneState: 'active', ...(microphoneTrackState ? { microphoneTrackState } : {}) });
      this.setState('MIC_ACQUIRED');
      this.startLevelMeter(this.stream);
      await this.connect(locale, false);
    } catch (error) {
      const code = error instanceof AgentServiceError ? error.details.code : error instanceof DOMException && error.name === 'NotAllowedError' ? 'MICROPHONE_PERMISSION_DENIED' : error instanceof Error && safeConnectionErrors.has(error.message) ? error.message : 'REALTIME_UNAVAILABLE';
      const message = code === 'MICROPHONE_PERMISSION_DENIED' ? 'Buddy needs microphone access to start Voice Mode.' : 'Voice Mode is temporarily unavailable. You can keep using text.';
      this.options.onError?.(message, code);
      this.updateDiagnostics({ lastSafeErrorCode: code });
      if (error instanceof AgentServiceError) this.updateDiagnostics({ sessionRequestId: error.requestId, ...(error.details.status ? { sessionHttpStatus: error.details.status } : {}) });
      this.setState('ERROR');
      this.cleanupAll();
      throw error;
    }
  }

  private async connect(locale: Locale, reconnecting: boolean): Promise<void> {
    if (!this.stream || this.stopped || this.connecting) return;
    this.connecting = true;
    this.cleanupTransport();
    try {
      this.setState(reconnecting ? 'RECONNECTING' : 'PEER_CONNECTING');
      const peer = this.options.createPeerConnection?.() ?? new RTCPeerConnection();
      const audio = this.options.createAudioElement?.() ?? document.createElement('audio');
      audio.autoplay = true;
      audio.setAttribute('playsinline', '');
      const channel = peer.createDataChannel('oai-events');
      this.peer = peer; this.audio = audio; this.channel = channel;
      this.updateDiagnostics({ peerConnectionState: peer.connectionState, iceState: peer.iceConnectionState, dataChannelState: channel.readyState });
      peer.ontrack = (event) => {
        this.updateDiagnostics({ remoteTrackReceived: true, lastEvent: 'remote_track_received' });
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio.play().then(() => this.updateDiagnostics({ audioPlaySucceeded: true })).catch(() => {
          this.updateDiagnostics({ audioPlaySucceeded: false, lastSafeErrorCode: 'AUDIO_PLAYBACK_BLOCKED' });
          this.options.onError?.('Buddy received the voice response, but Chrome blocked audio playback. Press the waveform again to retry.', 'AUDIO_PLAYBACK_BLOCKED');
        });
      };
      for (const track of this.stream.getAudioTracks()) peer.addTrack(track, this.stream);
      let resolveChannel!: () => void; let rejectChannel!: (error: Error) => void;
      const channelOpened = new Promise<void>((resolve, reject) => { resolveChannel = resolve; rejectChannel = reject; });
      let resolvePeer!: () => void; let rejectPeer!: (error: Error) => void;
      const peerConnected = new Promise<void>((resolve, reject) => { resolvePeer = resolve; rejectPeer = reject; });
      channel.onopen = () => {
        this.reconnectAttempt = 0;
        this.updateDiagnostics({ dataChannelState: channel.readyState, reconnectAttempt: 0 });
        this.setState('DATA_CHANNEL_OPEN');
        this.setState('LISTENING');
        this.armIdleTimer();
        this.armNoSpeechTimer();
        resolveChannel();
      };
      channel.onclose = () => {
        this.updateDiagnostics({ dataChannelState: channel.readyState }); rejectChannel(new Error('DATA_CHANNEL_CLOSED'));
        if (!this.connecting && !this.stopped) this.scheduleReconnect(locale);
      };
      channel.onmessage = (event) => this.handleServerEvent(event.data);
      peer.oniceconnectionstatechange = () => this.updateDiagnostics({ iceState: peer.iceConnectionState });
      peer.onconnectionstatechange = () => {
        this.updateDiagnostics({ peerConnectionState: peer.connectionState });
        if (peer.connectionState === 'connected') { this.setState('PEER_CONNECTED'); resolvePeer(); }
        if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
          rejectPeer(new Error('PEER_CONNECTION_FAILED'));
          if (!this.connecting && !this.stopped) this.scheduleReconnect(locale);
        }
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const sdp = peer.localDescription?.sdp ?? offer.sdp;
      if (!sdp) throw new Error('SDP_OFFER_FAILED');
      this.updateDiagnostics({ sessionRequestSucceeded: false });
      const session = await this.options.provider.createSession(sdp, locale);
      if (this.stopped || peer !== this.peer) return;
      this.updateDiagnostics({ model: session.model, voice: session.voice, vadMode: session.vadMode, sessionRequestId: session.requestId, sessionRequestSucceeded: true });
      if (!this.expiryTimer) {
        this.expiryTimer = setTimeout(() => {
          this.options.onError?.('Voice Mode ended after the session time limit.', 'SESSION_LIMIT_REACHED');
          this.updateDiagnostics({ lastSafeErrorCode: 'SESSION_LIMIT_REACHED' });
          this.stop();
        }, session.maxSessionSeconds * 1_000);
      }
      await peer.setRemoteDescription({ type: 'answer', sdp: session.sdp });
      if (peer.connectionState === 'connected') { this.setState('PEER_CONNECTED'); resolvePeer(); }
      await Promise.all([
        this.withTimeout(peerConnected, this.timeouts.peerMs, 'PEER_CONNECTION_TIMEOUT'),
        this.withTimeout(channelOpened, this.timeouts.dataChannelMs, 'DATA_CHANNEL_TIMEOUT'),
      ]);
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(locale: Locale): void {
    if (this.reconnectTimer || this.connecting || this.stopped) return;
    if (this.reconnectAttempt >= MAX_RECONNECTS) {
      this.options.onError?.('Voice Mode is temporarily unavailable. You can keep using text.', 'RECONNECT_LIMIT_REACHED');
      this.updateDiagnostics({ lastSafeErrorCode: 'RECONNECT_LIMIT_REACHED' });
      this.setState('ERROR');
      this.cleanupAll();
      return;
    }
    const attempt = ++this.reconnectAttempt;
    clearTimeout(this.noSpeechTimer); clearTimeout(this.responseTimer); this.noSpeechTimer = undefined; this.responseTimer = undefined;
    this.setState('RECONNECTING');
    this.updateDiagnostics({ reconnectAttempt: attempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect(locale, true).catch(() => this.scheduleReconnect(locale));
    }, RECONNECT_DELAYS[attempt - 1] ?? 1_500);
  }

  private handleServerEvent(raw: unknown): void {
    let event: Record<string, unknown>;
    try { event = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return; }
    const type = typeof event.type === 'string' ? event.type : '';
    if (type) this.updateDiagnostics({ lastEvent: type });
    if (type === 'input_audio_buffer.speech_started' || type === 'input_audio_buffer.speech_stopped' || type === 'response.created' || type.startsWith('output_audio_buffer.')) this.armIdleTimer();
    if (type === 'input_audio_buffer.speech_started') {
      clearTimeout(this.noSpeechTimer); this.noSpeechTimer = undefined;
      clearTimeout(this.responseTimer); this.responseTimer = undefined;
      this.updateDiagnostics({ speechStarted: true });
      if (this.currentResponseId) {
        this.send({ type: 'response.cancel', response_id: this.currentResponseId });
        this.send({ type: 'output_audio_buffer.clear' });
      }
      this.setState('SPEECH_STARTED');
    } else if (type === 'input_audio_buffer.speech_stopped') {
      this.updateDiagnostics({ speechStopped: true }); this.setState('SPEECH_STOPPED'); this.setState('MODEL_PROCESSING'); this.armResponseTimer();
    }
    else if (type === 'response.created') {
      this.updateDiagnostics({ responseCreated: true });
      const response = isRecord(event.response) ? event.response : undefined;
      this.currentResponseId = response && typeof response.id === 'string' ? response.id : undefined;
      this.setState('MODEL_PROCESSING');
    } else if (type === 'output_audio_buffer.started') { this.responseArrived(); this.setState('ASSISTANT_AUDIO_STARTED'); }
    else if (type === 'output_audio_buffer.stopped' || type === 'output_audio_buffer.cleared') { this.currentResponseId = undefined; this.setState('ASSISTANT_AUDIO_FINISHED'); this.setState('LISTENING'); this.armNoSpeechTimer(); }
    else if (type === 'conversation.item.input_audio_transcription.delta') this.transcript(event, 'user', false, 'delta');
    else if (type === 'conversation.item.input_audio_transcription.completed') { this.updateDiagnostics({ userTranscriptCompleted: true }); this.setState('USER_TRANSCRIPT'); this.transcript(event, 'user', true, 'transcript'); }
    else if (type === 'response.output_audio_transcript.delta') this.transcript(event, 'assistant', false, 'delta');
    else if (type === 'response.output_audio_transcript.done') { this.updateDiagnostics({ outputAudioTranscriptReceived: true }); this.transcript(event, 'assistant', true, 'transcript'); }
    else if (type === 'response.output_item.done' && isRecord(event.item)) { this.responseArrived(); void this.handleFunctionCall(event.item); }
    else if (type === 'response.done') {
      this.responseArrived(); this.updateDiagnostics({ responseDone: true });
      const response = isRecord(event.response) ? event.response : undefined;
      const output = response && Array.isArray(response.output) ? response.output : [];
      output.forEach((item) => { if (isRecord(item)) void this.handleFunctionCall(item); });
      if (!output.some((item) => isRecord(item) && item.type === 'function_call')) {
        this.currentResponseId = undefined;
        if (this.state === 'MODEL_PROCESSING' || this.state === 'USER_TRANSCRIPT' || this.state === 'SPEECH_STOPPED') { this.setState('ASSISTANT_AUDIO_FINISHED'); this.setState('LISTENING'); this.armNoSpeechTimer(); }
      }
    } else if (type === 'error') {
      const error = isRecord(event.error) ? event.error : undefined;
      const rawCode = error && typeof error.code === 'string' ? error.code : '';
      const code = /^[A-Za-z0-9_.-]{1,128}$/.test(rawCode) ? rawCode : 'REALTIME_EVENT_ERROR';
      this.updateDiagnostics({ lastSafeErrorCode: code });
      this.options.onError?.('Voice Mode could not complete that response. You can try again or continue by typing.', code);
    }
  }

  private transcript(event: Record<string, unknown>, role: VoiceTranscriptUpdate['role'], final: boolean, field: 'delta' | 'transcript'): void {
    const text = typeof event[field] === 'string' ? event[field] : '';
    if (!text) return;
    const key = typeof event.item_id === 'string' ? event.item_id : typeof event.response_id === 'string' ? event.response_id : `${role}-current`;
    this.options.onTranscript({ key, role, text, final });
  }

  private async handleFunctionCall(item: Record<string, unknown>): Promise<void> {
    if (item.type !== 'function_call' || item.name !== 'buddy_webmcp_request' || typeof item.call_id !== 'string' || this.handledCalls.has(item.call_id)) return;
    this.handledCalls.add(item.call_id);
    let parsed: unknown;
    try { parsed = JSON.parse(typeof item.arguments === 'string' ? item.arguments : ''); } catch { parsed = undefined; }
    const request = parseBuddyToolRequest(parsed);
    let result: VoiceToolResult;
    if (!request) result = { status: 'failed', message: 'Buddy rejected malformed or oversized action details.' };
    else {
      try {
        result = await this.options.onToolRequest(request, {
          announceApprovalRequired: () => {
            this.setState('WAITING_FOR_APPROVAL');
            this.send({ type: 'response.create', response: { output_modalities: ['audio'], instructions: `${SITE_SCOPE_INSTRUCTIONS} Briefly say that you can do this, but the user must confirm with the visible Approve or Cancel buttons. Do not treat spoken approval as authorization.` } });
          },
        });
      } catch { result = { status: 'failed', message: 'Buddy stopped safely before the site action completed.' }; }
    }
    this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(result).slice(0, 4_000) } });
    this.send({ type: 'response.create' });
    this.setState('MODEL_PROCESSING');
    this.armResponseTimer();
  }

  private send(event: Record<string, unknown>): void {
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(event));
  }

  stop(): void {
    if (this.state !== 'IDLE') this.setState('STOPPING');
    this.stopped = true;
    this.cleanupAll();
    this.setState('IDLE');
  }

  private startLevelMeter(stream: MediaStream): void {
    if (typeof AudioContext === 'undefined') return;
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser(); analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const values = new Uint8Array(analyser.frequencyBinCount);
      const sample = () => {
        analyser.getByteFrequencyData(values);
        const level = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length) / 255;
        this.options.onMicrophoneLevel?.(Math.min(1, level * 2.4));
        this.analyserFrame = requestAnimationFrame(sample);
      };
      this.audioContext = context; this.analyserFrame = requestAnimationFrame(sample);
    } catch { /* Audio level animation is optional. */ }
  }

  private cleanupTransport(): void {
    if (this.channel) { this.channel.onopen = null; this.channel.onclose = null; this.channel.onmessage = null; if (this.channel.readyState !== 'closed') this.channel.close(); }
    if (this.peer) { this.peer.ontrack = null; this.peer.onconnectionstatechange = null; this.peer.oniceconnectionstatechange = null; this.peer.close(); }
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; this.audio.remove(); }
    this.channel = undefined; this.peer = undefined; this.audio = undefined;
    this.updateDiagnostics({ dataChannelState: 'closed', peerConnectionState: 'closed' });
  }

  private cleanupAll(): void {
    clearTimeout(this.expiryTimer); clearTimeout(this.idleTimer); clearTimeout(this.reconnectTimer); clearTimeout(this.noSpeechTimer); clearTimeout(this.responseTimer);
    this.expiryTimer = undefined; this.idleTimer = undefined; this.reconnectTimer = undefined; this.noSpeechTimer = undefined; this.responseTimer = undefined;
    this.cleanupTransport();
    this.stream?.getTracks().forEach((track) => {
      const handler = this.trackEndedHandlers.get(track);
      if (handler) track.removeEventListener?.('ended', handler);
      track.stop();
    });
    this.trackEndedHandlers.clear(); this.stream = undefined;
    if (this.analyserFrame !== undefined) cancelAnimationFrame(this.analyserFrame); this.analyserFrame = undefined;
    void this.audioContext?.close().catch(() => undefined); this.audioContext = undefined;
    this.options.onMicrophoneLevel?.(0);
    this.updateDiagnostics({ microphoneState: 'inactive' });
    this.handledCalls.clear(); this.currentResponseId = undefined; this.reconnectAttempt = 0;
  }

  private armIdleTimer(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.stopped) return;
      this.options.onError?.('Voice Mode ended after two minutes without speech.', 'VOICE_IDLE_TIMEOUT');
      this.updateDiagnostics({ lastSafeErrorCode: 'VOICE_IDLE_TIMEOUT' });
      this.stop();
    }, IDLE_TIMEOUT_MS);
  }

  private get timeouts() { return { ...DEFAULT_TIMEOUTS, ...this.options.timeouts }; }

  private withTimeout<T>(promise: Promise<T>, milliseconds: number, code: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(code)), milliseconds);
      promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }

  private armNoSpeechTimer(): void {
    clearTimeout(this.noSpeechTimer);
    this.noSpeechTimer = setTimeout(() => {
      if (this.stopped) return;
      this.options.onError?.("I didn't hear any speech, so Voice Mode returned to idle. You can try again or continue by typing.", 'NO_SPEECH_TIMEOUT');
      this.updateDiagnostics({ lastSafeErrorCode: 'NO_SPEECH_TIMEOUT' }); this.stop();
    }, this.timeouts.noSpeechMs);
  }

  private armResponseTimer(): void {
    clearTimeout(this.responseTimer);
    this.responseTimer = setTimeout(() => {
      if (this.stopped) return;
      this.options.onError?.("I heard you, but Voice Mode couldn't complete the request. You can try again or continue by typing.", 'POST_SPEECH_RESPONSE_TIMEOUT');
      this.updateDiagnostics({ lastSafeErrorCode: 'POST_SPEECH_RESPONSE_TIMEOUT' }); this.stop();
    }, this.timeouts.postSpeechResponseMs);
  }

  private responseArrived(): void { clearTimeout(this.responseTimer); this.responseTimer = undefined; }

  private setState(state: RealtimeVoiceState): void {
    this.state = state;
    this.updateDiagnostics({ connectionState: state });
    this.options.onState(state);
  }

  private updateDiagnostics(patch: Partial<RealtimeDiagnostics>): void {
    this.diagnostics = { ...this.diagnostics, ...patch };
    this.options.onDiagnostics({ ...this.diagnostics });
  }
}
