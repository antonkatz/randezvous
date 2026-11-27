import {
  fingerprintFromSdp,
  humanHandshakeTranscript,
  signText,
  verifyText,
} from './crypto';
import type { RtcSignalPayload } from './protocol';

const AUDIO_AUTH_DOMAIN = 'rendezvous/rtc-auth/v1';
const AUDIO_WINDOW_MS = 60_000;
const AUTH_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 25_000;

interface AudioAuthMessage {
  kind: 'auth';
  sessionId: string;
  from: string;
  to: string;
  localFingerprint: string;
  remoteFingerprint: string;
  signature: string;
}

export interface AudioSessionOptions {
  sessionId: string;
  localPeerId: string;
  remotePeerId: string;
  localPrivateKey: CryptoKey;
  remotePublicKey: string;
  iceServers: RTCIceServer[];
  stream: MediaStream;
  /** Present for the answering side. */
  offerSdp?: string;
  offerer: boolean;
  sendSignal: (payload: RtcSignalPayload) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onBegan: (startedAt: number) => void;
  onRemoteMute: (muted: boolean) => void;
  onEnded: (reason: string, wasLive: boolean) => void;
  onError: (message: string) => void;
}

function parse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAuth(value: unknown, sessionId: string): value is AudioAuthMessage {
  return (
    isObject(value) &&
    value.kind === 'auth' &&
    value.sessionId === sessionId &&
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    typeof value.localFingerprint === 'string' &&
    typeof value.remoteFingerprint === 'string' &&
    typeof value.signature === 'string'
  );
}

export class AudioSession {
  private readonly options: AudioSessionOptions;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private localFingerprint: string | null = null;
  private remoteFingerprint: string | null = null;
  private authSent = false;
  private peerAuthenticated = false;
  private beganAt: number | null = null;
  private beganMonotonic: number | null = null;
  private remaining = AUDIO_WINDOW_MS;
  private timer: number | null = null;
  private authTimer: number | null = null;
  private connectTimer: number | null = null;
  private finished = false;
  private endedReported = false;
  private readonly pendingIce: RTCIceCandidateInit[] = [];
  private readonly localTrack: MediaStreamTrack | null;

  constructor(options: AudioSessionOptions) {
    this.options = options;
    this.localTrack = options.stream.getAudioTracks()[0] ?? null;
    if (this.localTrack) this.localTrack.enabled = false;
  }

  get wasLive(): boolean {
    return this.beganAt !== null;
  }

  get remainingMs(): number {
    return Math.max(0, this.remaining);
  }

  get live(): boolean {
    return this.beganAt !== null && !this.finished;
  }

  async start(): Promise<void> {
    const pc = new RTCPeerConnection({
      iceServers: this.options.iceServers,
      bundlePolicy: 'max-bundle',
    });
    this.pc = pc;
    pc.ontrack = (event) => {
      const [stream] = event.streams;
      this.options.onRemoteStream(stream ?? new MediaStream([event.track]));
    };
    pc.onicecandidate = (event) => {
      this.options.sendSignal({
        kind: 'ice',
        candidate: event.candidate ? event.candidate.toJSON() : null,
      });
    };
    pc.onconnectionstatechange = () => {
      if (this.finished) return;
      if (pc.connectionState === 'failed') {
        this.finish('The live voice connection failed.', this.wasLive);
      } else if (pc.connectionState === 'disconnected') {
        window.setTimeout(() => {
          if (!this.finished && pc.connectionState !== 'connected') {
            this.finish('The live voice connection ended.', this.wasLive);
          }
        }, 5_000);
      }
    };
    this.connectTimer = window.setTimeout(() => {
      if (!this.finished) this.finish('The live voice connection did not open.', false);
    }, CONNECT_TIMEOUT_MS);

    if (this.options.offerer) {
      const channel = pc.createDataChannel(`audio-${this.options.sessionId}`, {
        ordered: true,
      });
      this.attachChannel(channel);
      if (this.localTrack) pc.addTrack(this.localTrack, this.options.stream);
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.options.sendSignal({
          kind: 'offer',
          sdp: pc.localDescription?.sdp ?? offer.sdp ?? '',
        });
      } catch {
        this.finish('The live voice request could not start.', false);
      }
      return;
    }

    if (!this.options.offerSdp) {
      this.finish('The live voice request was missing.', false);
      return;
    }
    pc.ondatachannel = (event) => this.attachChannel(event.channel);
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: this.options.offerSdp });
      await this.flushIce();
      const transceiver = pc
        .getTransceivers()
        .find((entry) => entry.receiver.track.kind === 'audio');
      if (this.localTrack) {
        if (transceiver) {
          await transceiver.sender.replaceTrack(this.localTrack);
          transceiver.direction = 'sendrecv';
        } else {
          pc.addTrack(this.localTrack, this.options.stream);
        }
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.options.sendSignal({
        kind: 'answer',
        sdp: pc.localDescription?.sdp ?? answer.sdp ?? '',
      });
    } catch {
      this.finish('The live voice request could not be accepted.', false);
    }
  }

  async handleSignal(payload: RtcSignalPayload): Promise<void> {
    if (this.finished) return;
    const pc = this.pc;
    if (!pc) return;
    if (payload.kind === 'answer') {
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        await this.flushIce();
      } catch {
        this.finish('The live voice connection could not be completed.', false);
      }
      return;
    }
    if (payload.kind !== 'ice') return;
    if (!payload.candidate) return;
    if (!pc.remoteDescription) {
      this.pendingIce.push(payload.candidate);
      return;
    }
    try {
      await pc.addIceCandidate(payload.candidate);
    } catch {
      // Stale ICE candidates do not break a working connection.
    }
  }

  private async flushIce(): Promise<void> {
    for (const candidate of this.pendingIce.splice(0)) {
      await this.pc?.addIceCandidate(candidate).catch(() => {});
    }
  }

  private attachChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.onopen = () => {
      if (this.finished) return;
      this.clearConnectTimer();
      this.captureFingerprints();
      void this.signAuth();
      this.authTimer = window.setTimeout(() => {
        if (!this.finished && !this.peerAuthenticated) {
          this.finish('The other browser could not prove its identity.', false);
        }
      }, AUTH_TIMEOUT_MS);
    };
    channel.onclose = () => {
      if (!this.finished && this.beganAt !== null) {
        this.finish('The live voice connection ended.', true);
      }
    };
    channel.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const message = parse(event.data);
      if (isAuth(message, this.options.sessionId)) {
        void this.verifyAuth(message);
        return;
      }
      if (!isObject(message)) return;
      if (message.kind === 'auth-ready') {
        this.maybeBegin();
      } else if (message.kind === 'remote-mute') {
        this.options.onRemoteMute(message.muted === true);
      } else if (message.kind === 'end') {
        this.finish('The other person ended the minute.', this.wasLive);
      }
    };
  }

  private captureFingerprints(): void {
    this.localFingerprint = fingerprintFromSdp(this.pc?.localDescription?.sdp);
    this.remoteFingerprint = fingerprintFromSdp(this.pc?.remoteDescription?.sdp);
  }

  private async signAuth(): Promise<void> {
    const channel = this.channel;
    if (
      !channel ||
      channel.readyState !== 'open' ||
      !this.localFingerprint ||
      !this.remoteFingerprint
    ) {
      this.finish('The live voice session could not be identified.', false);
      return;
    }
    const transcript = humanHandshakeTranscript({
      transferId: this.options.sessionId,
      from: this.options.localPeerId,
      to: this.options.remotePeerId,
      localFingerprint: this.localFingerprint,
      remoteFingerprint: this.remoteFingerprint,
    });
    try {
      const signature = await signText(
        this.options.localPrivateKey,
        AUDIO_AUTH_DOMAIN,
        transcript,
      );
      if (this.finished || channel.readyState !== 'open') return;
      channel.send(
        JSON.stringify({
          kind: 'auth',
          sessionId: this.options.sessionId,
          from: this.options.localPeerId,
          to: this.options.remotePeerId,
          localFingerprint: this.localFingerprint,
          remoteFingerprint: this.remoteFingerprint,
          signature,
        } satisfies AudioAuthMessage),
      );
      this.authSent = true;
      this.maybeBegin();
    } catch {
      this.finish('The live voice session could not be authenticated.', false);
    }
  }

  private async verifyAuth(message: AudioAuthMessage): Promise<void> {
    if (
      message.from !== this.options.remotePeerId ||
      message.to !== this.options.localPeerId ||
      message.localFingerprint !== this.remoteFingerprint ||
      message.remoteFingerprint !== this.localFingerprint
    ) {
      this.finish('The other browser could not prove its identity.', false);
      return;
    }
    const transcript = humanHandshakeTranscript({
      transferId: this.options.sessionId,
      from: message.from,
      to: message.to,
      localFingerprint: message.localFingerprint,
      remoteFingerprint: message.remoteFingerprint,
    });
    const valid = await verifyText(
      this.options.remotePublicKey,
      AUDIO_AUTH_DOMAIN,
      transcript,
      message.signature,
    );
    if (this.finished) return;
    if (!valid) {
      this.finish('The other browser could not prove its identity.', false);
      return;
    }
    this.peerAuthenticated = true;
    if (this.authTimer !== null) {
      window.clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    this.send({ kind: 'auth-ready' });
    this.maybeBegin();
  }

  private maybeBegin(): void {
    if (
      this.finished ||
      this.beganAt !== null ||
      !this.authSent ||
      !this.peerAuthenticated
    ) {
      return;
    }
    this.beganAt = Date.now();
    this.beganMonotonic = performance.now();
    this.remaining = AUDIO_WINDOW_MS;
    this.clearConnectTimer();
    if (this.localTrack) this.localTrack.enabled = true;
    this.options.onBegan(this.beganAt);
    this.timer = window.setInterval(() => {
      if (this.beganMonotonic === null) return;
      this.remaining = Math.max(
        0,
        AUDIO_WINDOW_MS - (performance.now() - this.beganMonotonic),
      );
      if (this.remaining <= 0) {
        this.finish('The minute is over.', true);
      }
    }, 250);
  }

  setMuted(muted: boolean): void {
    if (this.localTrack) this.localTrack.enabled = !muted;
    this.send({ kind: 'remote-mute', muted });
  }

  end(): void {
    this.finish('You ended the minute.', this.wasLive);
  }

  close(): void {
    this.finish('The live voice session closed.', this.wasLive, false);
  }

  private send(message: unknown): void {
    if (this.channel?.readyState !== 'open' || this.finished) return;
    try {
      this.channel.send(JSON.stringify(message));
    } catch {
      // The close handler reports the actual failure.
    }
  }

  private captureAuthTimer(): void {
    if (this.authTimer !== null) {
      window.clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private finish(reason: string, wasLive: boolean, notifyPeer = true): void {
    if (this.finished) return;
    if (notifyPeer && wasLive) this.send({ kind: 'end' });
    this.finished = true;
    this.captureAuthTimer();
    this.clearConnectTimer();
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.localTrack) {
      this.localTrack.enabled = false;
      this.localTrack.stop();
      this.options.stream.getTracks().forEach((track) => track.stop());
    }
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.onclose = null;
      try {
        this.channel.close();
      } catch {
        // Best effort.
      }
      this.channel = null;
    }
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      try {
        this.pc.close();
      } catch {
        // Best effort.
      }
      this.pc = null;
    }
    if (this.endedReported) return;
    this.endedReported = true;
    if (wasLive) this.options.onEnded(reason, true);
    else this.options.onError(reason);
  }
}
