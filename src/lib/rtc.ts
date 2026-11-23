import {
  fingerprintFromSdp,
  humanHandshakeTranscript,
  signText,
  verifyText,
} from './crypto';
import type { RtcSignalPayload } from './protocol';
import type {
  IceFamilyCounts,
  IpFamily,
  TransferDiagnostics,
} from './types';

export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;
const HIGH_WATER_MARK = 4 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;
const AUTH_TIMEOUT_MS = 15_000;
const TRANSFER_INACTIVITY_MS = 45_000;
const ACK_TIMEOUT_MS = 20_000;
const RTC_AUTH_DOMAIN = 'randevouz/rtc-auth/v1';

export type TransferPhase = 'connecting' | 'progress' | 'complete' | 'error';

export interface TransferCallbacks {
  onPhase: (phase: TransferPhase, transferred: number, total: number) => void;
  onError: (message: string) => void;
  onSenderComplete: () => void;
  onReceiverComplete: (photo: Blob, meta: PhotoMeta) => void;
  onDiagnostics?: (diagnostics: TransferDiagnostics) => void;
}

export interface PhotoMeta {
  name: string;
  type: string;
  size: number;
}

interface CommonOptions {
  transferId: string;
  localPeerId: string;
  remotePeerId: string;
  localPrivateKey: CryptoKey;
  remotePublicKey: string;
  iceServers: RTCIceServer[];
  sendSignal: (payload: RtcSignalPayload) => void;
  callbacks: TransferCallbacks;
}

interface AuthMessage {
  kind: 'auth';
  transferId: string;
  from: string;
  to: string;
  localFingerprint: string;
  remoteFingerprint: string;
  signature: string;
}

interface SenderOptions extends CommonOptions {
  photo: Blob;
  meta: PhotoMeta;
}

interface ReceiverOptions extends CommonOptions {
  offerSdp: string;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function parseMessage(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isAuthMessage(value: unknown, transferId: string): value is AuthMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<AuthMessage>;
  return (
    message.kind === 'auth' &&
    message.transferId === transferId &&
    typeof message.from === 'string' &&
    typeof message.to === 'string' &&
    typeof message.localFingerprint === 'string' &&
    typeof message.remoteFingerprint === 'string' &&
    typeof message.signature === 'string'
  );
}

function iceConnection(
  iceServers: RTCIceServer[],
): RTCConfiguration {
  return {
    iceServers,
    bundlePolicy: 'max-bundle',
  };
}

function emptyFamilies(): IceFamilyCounts {
  return { ipv4: 0, ipv6: 0, unknown: 0 };
}

function addressFamily(address: string | undefined | null): IpFamily {
  if (!address) return 'unknown';
  if (address.includes(':')) return 'IPv6';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(address)) return 'IPv4';
  return 'unknown';
}

function candidateAddress(candidate: string): string | null {
  const value = candidate.startsWith('a=') ? candidate.slice(2) : candidate;
  const parts = value.split(/\s+/u);
  if (parts[0] !== 'candidate:' || parts.length < 6) return null;
  return parts[4] ?? null;
}

function countLocalCandidate(counts: IceFamilyCounts, candidate: RTCIceCandidate): void {
  const family = addressFamily(candidate.address || candidateAddress(candidate.candidate));
  if (family === 'IPv4') counts.ipv4 += 1;
  else if (family === 'IPv6') counts.ipv6 += 1;
  else counts.unknown += 1;
}


abstract class BaseTransfer {
  protected readonly options: CommonOptions;
  protected pc: RTCPeerConnection | null = null;
  protected channel: RTCDataChannel | null = null;
  protected peerAuthenticated = false;
  protected finished = false;
  protected deliveryCompleted = false;
  protected localFingerprint: string | null = null;
  protected remoteFingerprint: string | null = null;
  protected localFamilies: IceFamilyCounts = emptyFamilies();
  protected remoteFamilies: IceFamilyCounts = emptyFamilies();
  private readonly seenRemoteCandidates = new Set<string>();
  private diagnosticsSent = false;
  private readonly pendingIce: RTCIceCandidateInit[] = [];
  private connectTimer: number | null = null;
  protected authTimer: number | null = null;
  private disconnectTimer: number | null = null;

  protected constructor(options: CommonOptions) {
    this.options = options;
  }

  abstract start(): Promise<void>;

  close(): void {
    this.finished = true;
    this.clearTimers();
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.onopen = null;
      this.channel.onclose = null;
      this.channel.close();
      this.channel = null;
    }
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.ondatachannel = null;
      this.pc.onconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }
  }

  protected fail(message: string): void {
    if (this.finished) return;
    this.finished = true;
    this.clearTimers();
    try {
      this.channel?.close();
      this.pc?.close();
    } catch {
      // Best effort.
    }
    this.channel = null;
    this.pc = null;
    this.options.callbacks.onError(message);
  }

  protected preparePeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection(iceConnection(this.options.iceServers));
    this.pc = pc;
    pc.onicecandidate = (event) => {
      if (event.candidate) countLocalCandidate(this.localFamilies, event.candidate);
      this.options.sendSignal({
        kind: 'ice',
        candidate: event.candidate ? event.candidate.toJSON() : null,
      });
    };
    pc.onconnectionstatechange = () => {
      if (this.finished) return;
      if (pc.connectionState === 'connected') {
        this.clearDisconnectTimer();
        void this.emitDiagnostics();
      } else if (pc.connectionState === 'failed') {
        this.fail('The direct connection could not be established.');
      } else if (pc.connectionState === 'disconnected') {
        this.clearDisconnectTimer();
        this.disconnectTimer = window.setTimeout(() => {
          if (!this.finished && pc.connectionState !== 'connected') {
            this.fail('The direct connection was interrupted.');
          }
        }, 8_000);
      }
    };

    this.connectTimer = window.setTimeout(() => {
      if (!this.finished) this.fail('The other browser did not answer in time.');
    }, CONNECT_TIMEOUT_MS);
    return pc;
  }

  private countRemoteCandidate(candidate: string): void {
    if (this.seenRemoteCandidates.has(candidate)) return;
    this.seenRemoteCandidates.add(candidate);
    const family = addressFamily(candidateAddress(candidate));
    if (family === 'IPv4') this.remoteFamilies.ipv4 += 1;
    else if (family === 'IPv6') this.remoteFamilies.ipv6 += 1;
    else this.remoteFamilies.unknown += 1;
  }

  protected noteRemoteSdp(sdp: string | undefined): void {
    if (!sdp) return;
    for (const line of sdp.split(/\r?\n/u)) {
      if (line.startsWith('a=candidate:')) this.countRemoteCandidate(line);
    }
  }

  protected async emitDiagnostics(force = false): Promise<void> {
    if ((this.diagnosticsSent && !force) || this.finished || !this.pc) return;
    this.diagnosticsSent = true;
    let selected: TransferDiagnostics['selected'] = null;
    try {
      const stats = await this.pc.getStats();
      let pair: Record<string, unknown> | null = null;
      stats.forEach((report) => {
        const record = report as unknown as Record<string, unknown>;
        if (record.type !== 'candidate-pair') return;
        if (record.selected === true || (record.nominated === true && record.state === 'succeeded')) {
          pair = record;
        }
      });
      if (pair) {
        const localId = (pair as Record<string, unknown>).localCandidateId as string | undefined;
        const remoteId = (pair as Record<string, unknown>).remoteCandidateId as string | undefined;
        const local = localId
          ? (stats.get(localId) as unknown as Record<string, unknown> | undefined)
          : undefined;
        const remote = remoteId
          ? (stats.get(remoteId) as unknown as Record<string, unknown> | undefined)
          : undefined;
        if (local && remote) {
          selected = {
            localFamily: addressFamily(local.address as string | undefined),
            remoteFamily: addressFamily(remote.address as string | undefined),
            localType: String(local.candidateType ?? 'unknown'),
            remoteType: String(remote.candidateType ?? 'unknown'),
            protocol: String(local.protocol ?? remote.protocol ?? 'unknown'),
          };
        }
      }
    } catch {
      // Diagnostics are best-effort and never block a transfer.
    }
    this.options.callbacks.onDiagnostics?.({
      transferId: this.options.transferId,
      at: Date.now(),
      localCandidates: { ...this.localFamilies },
      remoteCandidates: { ...this.remoteFamilies },
      selected,
    });
  }

  protected captureFingerprints(): boolean {
    const local = fingerprintFromSdp(this.pc?.localDescription?.sdp);
    const remote = fingerprintFromSdp(this.pc?.remoteDescription?.sdp);
    if (!local || !remote) return false;
    this.localFingerprint = local;
    this.remoteFingerprint = remote;
    return true;
  }

  protected async flushPendingIce(): Promise<void> {
    for (const candidate of this.pendingIce.splice(0)) {
      await this.pc?.addIceCandidate(candidate);
    }
  }

  protected async addRemoteIce(candidate: RTCIceCandidateInit | null): Promise<void> {
    if (!candidate) return;
    if (candidate.candidate) this.countRemoteCandidate(candidate.candidate);
    if (!this.pc?.remoteDescription) {
      this.pendingIce.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      // A stale candidate is harmless; the connection can still succeed.
    }
  }

  protected attachChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      if (this.finished) return;
      this.clearConnectTimer();
      void this.sendAuthentication();
      this.authTimer = window.setTimeout(() => {
        if (!this.finished && !this.peerAuthenticated) {
          this.fail('The other browser could not prove its identity.');
        }
      }, AUTH_TIMEOUT_MS);
      this.onChannelOpen();
    };
    channel.onclose = () => {
      if (!this.finished && !this.deliveryCompleted) {
        this.fail('The direct connection closed before delivery.');
      }
    };
    channel.onmessage = (event) => this.handleChannelMessage(event.data);
  }

  private async sendAuthentication(): Promise<void> {
    const channel = this.channel;
    const { transferId, localPeerId, remotePeerId } = this.options;
    if (
      !channel ||
      channel.readyState !== 'open' ||
      !this.localFingerprint ||
      !this.remoteFingerprint
    ) {
      this.fail('The encrypted session could not be identified.');
      return;
    }
    const transcript = humanHandshakeTranscript({
      transferId,
      from: localPeerId,
      to: remotePeerId,
      localFingerprint: this.localFingerprint,
      remoteFingerprint: this.remoteFingerprint,
    });
    try {
      const signature = await signText(this.options.localPrivateKey, RTC_AUTH_DOMAIN, transcript);
      if (this.finished || channel.readyState !== 'open') return;
      const message: AuthMessage = {
        kind: 'auth',
        transferId,
        from: localPeerId,
        to: remotePeerId,
        localFingerprint: this.localFingerprint,
        remoteFingerprint: this.remoteFingerprint,
        signature,
      };
      channel.send(JSON.stringify(message));
    } catch {
      this.fail('The encrypted session could not be authenticated.');
    }
  }

  private async verifyAuthentication(message: AuthMessage): Promise<boolean> {
    if (
      message.from !== this.options.remotePeerId ||
      message.to !== this.options.localPeerId ||
      message.localFingerprint !== this.remoteFingerprint ||
      message.remoteFingerprint !== this.localFingerprint
    ) {
      return false;
    }
    const transcript = humanHandshakeTranscript({
      transferId: this.options.transferId,
      from: message.from,
      to: message.to,
      localFingerprint: message.localFingerprint,
      remoteFingerprint: message.remoteFingerprint,
    });
    return verifyText(
      this.options.remotePublicKey,
      RTC_AUTH_DOMAIN,
      transcript,
      message.signature,
    );
  }

  protected abstract onChannelOpen(): void;
  protected abstract onAuthenticated(): void;

  private sendReady(): void {
    if (this.channel?.readyState !== 'open') return;
    this.channel.send(JSON.stringify({ kind: 'auth-ready', transferId: this.options.transferId }));
  }

  protected handleChannelMessage(data: unknown): void {
    if (this.finished) return;
    if (typeof data === 'string') {
      const message = parseMessage(data);
      if (isAuthMessage(message, this.options.transferId)) {
        if (this.peerAuthenticated) return;
        void this.verifyAuthentication(message).then((valid) => {
          if (this.finished) return;
          if (!valid) {
            this.fail('The other browser could not prove its identity.');
            return;
          }
          this.peerAuthenticated = true;
          this.clearAuthTimer();
          this.sendReady();
          void this.emitDiagnostics();
          this.options.callbacks.onPhase('connecting', 0, 0);
          this.onAuthenticated();
        });
        return;
      }
      this.handleProtocolMessage(message);
      return;
    }
    this.handleBinaryMessage(data);
  }

  protected handleProtocolMessage(_message: unknown): void {}
  protected handleBinaryMessage(_data: unknown): void {}

  protected clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  protected clearAuthTimer(): void {
    if (this.authTimer !== null) {
      window.clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer !== null) {
      window.clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  protected clearTimers(): void {
    this.clearConnectTimer();
    this.clearAuthTimer();
    this.clearDisconnectTimer();
  }
}

export class SenderTransfer extends BaseTransfer {
  private readonly senderOptions: SenderOptions;
  private ackTimer: number | null = null;
  private peerReady = false;
  private sending = false;
  private readyTimer: number | null = null;

  constructor(options: SenderOptions) {
    super(options);
    this.senderOptions = options;
  }

  close(): void {
    if (this.readyTimer !== null) {
      window.clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    super.close();
  }

  async start(): Promise<void> {
    this.options.callbacks.onPhase('connecting', 0, 0);
    const pc = this.preparePeerConnection();
    const channel = pc.createDataChannel(`photo-${this.options.transferId}`, {
      ordered: true,
    });
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      if (this.finished) return;
      this.clearConnectTimer();
      if (!this.captureFingerprints()) {
        this.fail('The encrypted session could not be identified.');
        return;
      }
      void this.sendAuthenticationForSender();
      this.authTimer = window.setTimeout(() => {
        if (!this.finished && !this.peerAuthenticated) {
          this.fail('The other browser could not prove its identity.');
        }
      }, AUTH_TIMEOUT_MS);
    };
    channel.onmessage = (event) => this.handleChannelMessage(event.data);
    channel.onclose = () => {
      if (!this.finished && !this.deliveryCompleted) {
        this.fail('The direct connection closed before delivery.');
      }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.options.sendSignal({ kind: 'offer', sdp: pc.localDescription?.sdp ?? offer.sdp ?? '' });
    } catch {
      this.fail('Could not start the direct connection.');
    }
  }

  async handleSignal(payload: RtcSignalPayload): Promise<void> {
    if (this.finished) return;
    if (payload.kind === 'answer') {
      try {
        await this.pc?.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        this.captureFingerprints();
        this.noteRemoteSdp(payload.sdp);
        await this.flushPendingIce();
      } catch {
        this.fail('The direct connection could not be completed.');
      }
    } else if (payload.kind === 'ice') {
      await this.addRemoteIce(payload.candidate);
    }
  }

  private async sendAuthenticationForSender(): Promise<void> {
    const channel = this.channel;
    if (!channel || !this.localFingerprint || !this.remoteFingerprint) {
      this.fail('The encrypted session could not be identified.');
      return;
    }
    const transcript = humanHandshakeTranscript({
      transferId: this.options.transferId,
      from: this.options.localPeerId,
      to: this.options.remotePeerId,
      localFingerprint: this.localFingerprint,
      remoteFingerprint: this.remoteFingerprint,
    });
    try {
      const signature = await signText(this.options.localPrivateKey, RTC_AUTH_DOMAIN, transcript);
      if (this.finished || channel.readyState !== 'open') return;
      channel.send(
        JSON.stringify({
          kind: 'auth',
          transferId: this.options.transferId,
          from: this.options.localPeerId,
          to: this.options.remotePeerId,
          localFingerprint: this.localFingerprint,
          remoteFingerprint: this.remoteFingerprint,
          signature,
        } satisfies AuthMessage),
      );
    } catch {
      this.fail('The encrypted session could not be authenticated.');
    }
  }

  protected onChannelOpen(): void {}

  protected onAuthenticated(): void {
    if (!this.peerReady) {
      this.readyTimer = window.setTimeout(() => {
        if (!this.finished && !this.peerReady) {
          this.fail('The other browser did not confirm the encrypted handshake.');
        }
      }, 10_000);
    }
    this.maybeSendPhoto();
  }

  private maybeSendPhoto(): void {
    if (this.sending || !this.peerAuthenticated || !this.peerReady) return;
    this.sending = true;
    if (this.readyTimer !== null) {
      window.clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    void this.sendPhoto();
  }

  protected handleProtocolMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const kind = (message as { kind?: unknown }).kind;
    if (kind === 'auth-ready') {
      this.peerReady = true;
      this.maybeSendPhoto();
      return;
    }
    if (kind === 'ack') {
      if (!this.peerAuthenticated) return;
      if (this.ackTimer !== null) {
        window.clearTimeout(this.ackTimer);
        this.ackTimer = null;
      }
      if (this.finished) return;
      this.deliveryCompleted = true;
      void this.emitDiagnostics(true);
      if (this.readyTimer !== null) {
        window.clearTimeout(this.readyTimer);
        this.readyTimer = null;
      }
      this.options.callbacks.onPhase(
        'complete',
        this.senderOptions.meta.size,
        this.senderOptions.meta.size,
      );
      this.options.callbacks.onSenderComplete();
      window.setTimeout(() => this.close(), 250);
    }
  }

  private async sendPhoto(): Promise<void> {
    const channel = this.channel;
    if (!channel || channel.readyState !== 'open') {
      this.fail('The direct connection closed before delivery.');
      return;
    }
    const { meta, photo } = this.senderOptions;
    let buffer: ArrayBuffer;
    try {
      buffer = await photo.arrayBuffer();
    } catch {
      this.fail('The photo could not be read from this browser.');
      return;
    }

    channel.send(
      JSON.stringify({
        kind: 'photo-meta',
        transferId: this.options.transferId,
        name: meta.name,
        type: meta.type,
        size: meta.size,
      }),
    );

    let sent = 0;
    let inactivityTimer = window.setTimeout(() => {
      if (!this.finished) this.fail('The transfer stalled.');
    }, TRANSFER_INACTIVITY_MS);

    try {
      while (sent < buffer.byteLength && !this.finished) {
        if (channel.readyState !== 'open') {
          throw new Error('channel closed');
        }
        while (channel.bufferedAmount > HIGH_WATER_MARK && channel.readyState === 'open') {
          await wait(12);
          if (this.finished) return;
        }
        const end = Math.min(sent + CHUNK_SIZE, buffer.byteLength);
        channel.send(buffer.slice(sent, end));
        sent = end;
        window.clearTimeout(inactivityTimer);
        inactivityTimer = window.setTimeout(() => {
          if (!this.finished) this.fail('The transfer stalled.');
        }, TRANSFER_INACTIVITY_MS);
        this.options.callbacks.onPhase('progress', sent, meta.size);
        if (sent % (CHUNK_SIZE * 8) === 0) {
          await wait(0);
        }
      }
      window.clearTimeout(inactivityTimer);
      if (this.finished) return;
      channel.send(JSON.stringify({ kind: 'photo-complete', transferId: this.options.transferId }));
      this.ackTimer = window.setTimeout(() => {
        if (!this.finished) this.fail('The other browser did not confirm the photo.');
      }, ACK_TIMEOUT_MS);
    } catch {
      window.clearTimeout(inactivityTimer);
      this.fail('The direct connection dropped during the transfer.');
    }
  }
}

export class ReceiverTransfer extends BaseTransfer {
  private readonly receiverOptions: ReceiverOptions;
  private expectedMeta: PhotoMeta | null = null;
  private received = 0;
  private chunks: ArrayBuffer[] = [];
  private receiverInactivityTimer: number | null = null;
  private completed = false;

  constructor(options: ReceiverOptions) {
    super(options);
    this.receiverOptions = options;
  }

  async start(): Promise<void> {
    const pc = this.preparePeerConnection();
    pc.ondatachannel = (event) => {
      this.attachChannel(event.channel);
    };

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: this.receiverOptions.offerSdp });
      this.noteRemoteSdp(this.receiverOptions.offerSdp);
      await this.flushPendingIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (!this.captureFingerprints()) {
        this.fail('The encrypted session could not be identified.');
        return;
      }
      this.options.sendSignal({
        kind: 'answer',
        sdp: pc.localDescription?.sdp ?? answer.sdp ?? '',
      });
    } catch {
      this.fail('Could not accept the direct connection.');
    }
  }

  async handleSignal(payload: RtcSignalPayload): Promise<void> {
    if (payload.kind === 'ice') {
      await this.addRemoteIce(payload.candidate);
    }
  }

  protected onChannelOpen(): void {
    this.resetInactivity();
  }

  protected onAuthenticated(): void {
    this.options.callbacks.onPhase('connecting', 0, this.expectedMeta?.size ?? 0);
    this.resetInactivity();
  }

  protected handleProtocolMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const data = message as Record<string, unknown>;
    if (data.kind === 'photo-meta') {
      if (!this.peerAuthenticated || this.expectedMeta) return;
      const name = typeof data.name === 'string' ? data.name.slice(0, 200) : 'photo';
      const type = typeof data.type === 'string' ? data.type : 'application/octet-stream';
      const size = typeof data.size === 'number' && Number.isFinite(data.size) ? data.size : 0;
      if (!type.startsWith('image/') || size <= 0 || size > MAX_PHOTO_BYTES) {
        this.fail('The other browser sent an invalid photo.');
        return;
      }
      this.expectedMeta = { name, type, size };
      this.resetInactivity();
      this.options.callbacks.onPhase('progress', 0, size);
      return;
    }

    if (data.kind === 'photo-complete') {
      if (!this.peerAuthenticated || !this.expectedMeta || this.completed) return;
      if (this.received !== this.expectedMeta.size) {
        this.fail('The photo arrived incomplete.');
        return;
      }
      this.completed = true;
      this.deliveryCompleted = true;
      this.clearReceiverTimer();
      void this.emitDiagnostics(true);
      const blob = new Blob(this.chunks, { type: this.expectedMeta.type });
      this.channel?.send(
        JSON.stringify({ kind: 'ack', transferId: this.options.transferId }),
      );
      this.options.callbacks.onPhase('complete', this.received, this.expectedMeta.size);
      this.options.callbacks.onReceiverComplete(blob, this.expectedMeta);
      window.setTimeout(() => this.close(), 1_000);
    }
  }

  protected handleBinaryMessage(data: unknown): void {
    if (!this.peerAuthenticated || !this.expectedMeta || this.completed) return;
    if (!(data instanceof ArrayBuffer)) return;
    if (this.received + data.byteLength > this.expectedMeta.size) {
      this.fail('The photo arrived with an unexpected size.');
      return;
    }
    this.chunks.push(data);
    this.received += data.byteLength;
    this.resetInactivity();
    this.options.callbacks.onPhase('progress', this.received, this.expectedMeta.size);
  }

  private resetInactivity(): void {
    this.clearReceiverTimer();
    this.receiverInactivityTimer = window.setTimeout(() => {
      if (!this.finished && !this.completed) this.fail('The transfer stalled.');
    }, TRANSFER_INACTIVITY_MS);
  }

  private clearReceiverTimer(): void {
    if (this.receiverInactivityTimer !== null) {
      window.clearTimeout(this.receiverInactivityTimer);
      this.receiverInactivityTimer = null;
    }
  }

  close(): void {
    this.clearReceiverTimer();
    super.close();
  }
}
