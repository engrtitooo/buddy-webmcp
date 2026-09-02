import type { RealtimeBootstrapResult, RealtimeSessionProvider } from '@buddy/buddy-ui';
import { REALTIME_SESSION_MESSAGE, type Locale, type RealtimeSessionRuntimeMessage, type RealtimeSessionRuntimeResponse } from '@buddy/shared';

export class ExtensionRealtimeSessionProvider implements RealtimeSessionProvider {
  supported = typeof RTCPeerConnection !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

  async createSession(sdp: string, locale: Locale): Promise<RealtimeBootstrapResult> {
    const message: RealtimeSessionRuntimeMessage = { type: REALTIME_SESSION_MESSAGE, payload: { sdp, locale } };
    const response = await chrome.runtime.sendMessage(message) as RealtimeSessionRuntimeResponse;
    if (!response?.ok) throw new Error(response?.error.code ?? 'REALTIME_UNAVAILABLE');
    return response;
  }
}
