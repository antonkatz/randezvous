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
  VoiceNoteAttachment,
} from './types';

export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
export const MAX_NOTE_BYTES = 8 * 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;
const HIGH_WATER_MARK = 4 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;
const AUTH_TIMEOUT_MS = 15_000;
const TRANSFER_INACTIVITY_MS = 45_000;
const ACK_TIMEOUT_MS = 20_000;
const RTC_AUTH_DOMAIN = 'rendezvous/rtc-auth/v1';

export type TransferPhase = 'connecting' | 'progress' | 'complete' | 'error';
export type PayloadDirection = 'primary' | 'reciprocal';

export interface NoteMeta {
  name: string;
  type: string;
  size: number;
  durationMs: number;
}

export interface PhotoMeta {
  name: string;
  type: string;
  size: number;
  photoId?: string;
  note?: NoteMeta | null;
}

export interface MediaPayload {
  photo: Blob;
  meta: PhotoMeta;
  note: VoiceNoteAttachment | null;
  photoId: string;
}

export interface TransferCallbacks {
  onPhase: (phase: TransferPhase, transferred: number, total: number) => void;
  onError: (message: string, direction: PayloadDirection) => void;
  onSenderComplete: () => void | Promise<void>;
  onReceiverComplete: (payload: MediaPayload) => void | Promise<void>;
  onReciprocalComplete?: (payload: MediaPayload) => void | Promise<void>;
  /** Fired only after the primary ACK has gone out over the wire. */
  onReceiverAcked?: (payload: MediaPayload) => void;
  /** Fired after we ACK the reciprocal payload we received. */
  onReciprocalAcked?: (payload: MediaPayload) => void;
  /** Fired when our own reciprocal contribution was ACKed by the peer. */
  onContributionAcked?: () => void;
  onPeerContribution?: (present: boolean) => void;
  onDiagnostics?: (diagnostics: TransferDiagnostics) => void;
  onClosed?: () => void;
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

interface PayloadOptions {
  photo: Blob;
  meta: PhotoMeta;
  note: VoiceNoteAttachment | null;
}

interface SenderOptions extends CommonOptions, PayloadOptions {}

interface ReceiverOptions extends CommonOptions {
  offerSdp: string;
  contribution: PayloadOptions | null;
}

interface IncomingPayload {
  direction: PayloadDirection;
  meta: PhotoMeta;
  noteMeta: NoteMeta | null;
  chunks: ArrayBuffer[];
  noteChunks: ArrayBuffer[];
  photoBytes: number;
  noteBytes: number;
  completed: boolean;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAuthMessage(value: unknown, transferId: string): value is AuthMessage {
  if (!isObject(value)) return false;
  return (
    value.kind === 'auth' &&
    value.transferId === transferId &&
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    typeof value.localFingerprint === 'string' &&
    typeof value.remoteFingerprint === 'string' &&
    typeof value.signature === 'string'
  );
}

function iceConnection(iceServers: RTCIceServer[]): RTCConfiguration {
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

function noteMeta(note: VoiceNoteAttachment | null): NoteMeta | null {
  if (!note) return null;
  return {
    name: note.name,
    type: note.type,
    size: note.size,
    durationMs: note.durationMs,
  };
}

function validateMeta(value: unknown): { meta: PhotoMeta; noteMeta: NoteMeta | null } | null {
  if (!isObject(value)) return null;
  const name = typeof value.name === 'string' ? value.name.slice(0, 200) : 'photograph';
  const type = typeof value.type === 'string' ? value.type : '';
  const size = typeof value.size === 'number' ? value.size : 0;
  if (!type.startsWith('image/') || !Number.isFinite(size) || size <= 0 || size > MAX_PHOTO_BYTES) {
    return null;
  }
  const rawNote = value.note;
  let validNote: NoteMeta | null = null;
  if (rawNote !== null && rawNote !== undefined) {
    if (!isObject(rawNote)) return null;
    const noteType = typeof rawNote.type === 'string' ? rawNote.type : '';
    const noteSize = typeof rawNote.size === 'number' ? rawNote.size : 0;
    const durationMs = typeof rawNote.durationMs === 'number' ? rawNote.durationMs : 0;
    if (
      !noteType.startsWith('audio/') ||
      !Number.isFinite(noteSize) ||
      noteSize <= 0 ||
      noteSize > MAX_NOTE_BYTES ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      durationMs > 61_000
    ) {
      return null;
    }
    validNote = {
      name: typeof rawNote.name === 'string' ? rawNote.name.slice(0, 200) : 'voice note',
      type: noteType,
      size: noteSize,
      durationMs,
    };
  }
  return {
    meta: {
      name,
      type,
      size,
      ...(typeof value.photoId === 'string' ? { photoId: value.photoId } : {}),
      note: validNote,
    },
    noteMeta: validNote,
  };
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
  private closedReported = false;

  protected constructor(options: CommonOptions) {
    this.options = options;
  }

  abstract start(): Promise<void>;

  close(): void {
    if (this.finished) return;
    this.finished = true;
    this.clearTimers();
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.onopen = null;
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
      this.pc.ondatachannel = null;
      this.pc.onconnectionstatechange = null;
      try {
        this.pc.close();
      } catch {
        // Best effort.
      }
      this.pc = null;
    }
    this.reportClosed();
  }

  private reportClosed(): void {
    if (this.closedReported) return;
    this.closedReported = true;
    this.options.callbacks.onClosed?.();
  }

  protected fail(message: string, direction: PayloadDirection = 'primary'): void {
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
    this.options.callbacks.onError(message, direction);
    this.reportClosed();
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

  protected sendControl(message: unknown): void {
    if (this.channel?.readyState !== 'open') return;
    this.channel.send(JSON.stringify(message));
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
  protected abstract onControlMessage(message: Record<string, unknown>): void;
  protected abstract onBinaryMessage(data: ArrayBuffer): void;

  private sendReady(): void {
    this.sendControl({ kind: 'auth-ready', transferId: this.options.transferId });
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
      if (isObject(message)) this.onControlMessage(message);
      return;
    }
    if (data instanceof ArrayBuffer) this.onBinaryMessage(data);
  }

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

interface PayloadSender {
  sendPayload(direction: PayloadDirection, payload: PayloadOptions): Promise<void>;
}

async function streamPayload(
  channel: RTCDataChannel,
  transferId: string,
  direction: PayloadDirection,
  payload: PayloadOptions,
  onProgress: (sent: number, total: number) => void,
  isFinished: () => boolean,
  fail: (message: string, direction: PayloadDirection) => void,
): Promise<void> {
  const photoBuffer = await payload.photo.arrayBuffer();
  const noteBuffer = payload.note ? await payload.note.blob.arrayBuffer() : null;
  const photoSize = photoBuffer.byteLength;
  const total = photoSize + (noteBuffer?.byteLength ?? 0);

  channel.send(
    JSON.stringify({
      kind: 'payload-meta',
      transferId,
      direction,
      name: payload.meta.name,
      type: payload.meta.type,
      size: payload.meta.size,
      photoId: payload.meta.photoId,
      note: noteMeta(payload.note),
    }),
  );

  let sent = 0;
  let inactivityTimer = window.setTimeout(() => {
    fail('The transfer stalled.', direction);
  }, TRANSFER_INACTIVITY_MS);

  const sendBuffer = async (buffer: ArrayBuffer): Promise<void> => {
    let offset = 0;
    while (offset < buffer.byteLength) {
      if (channel.readyState !== 'open') throw new Error('channel closed');
      while (channel.bufferedAmount > HIGH_WATER_MARK && channel.readyState === 'open') {
        await wait(12);
        if (isFinished()) return;
      }
      const end = Math.min(offset + CHUNK_SIZE, buffer.byteLength);
      channel.send(buffer.slice(offset, end));
      sent += end - offset;
      offset = end;
      window.clearTimeout(inactivityTimer);
      inactivityTimer = window.setTimeout(() => {
        fail('The transfer stalled.', direction);
      }, TRANSFER_INACTIVITY_MS);
      onProgress(sent, total);
      if (offset % (CHUNK_SIZE * 8) === 0) await wait(0);
    }
  };

  try {
    await sendBuffer(photoBuffer);
    if (noteBuffer) await sendBuffer(noteBuffer);
    window.clearTimeout(inactivityTimer);
    if (isFinished()) return;
    channel.send(
      JSON.stringify({
        kind: 'payload-complete',
        transferId,
        direction,
      }),
    );
  } catch {
    window.clearTimeout(inactivityTimer);
    throw new Error('The direct connection dropped during the transfer.');
  }
}

export class SenderTransfer extends BaseTransfer {
  private readonly senderOptions: SenderOptions;
  private ackTimer: number | null = null;
  private peerReady = false;
  private sending = false;
  private readyTimer: number | null = null;
  private primaryAcked = false;
  private peerContribution = false;
  private reciprocalMeta: { meta: PhotoMeta; noteMeta: NoteMeta | null } | null = null;
  private reciprocalChunks: ArrayBuffer[] = [];
  private reciprocalNoteChunks: ArrayBuffer[] = [];
  private reciprocalPhotoBytes = 0;
  private reciprocalNoteBytes = 0;
  private reciprocalCompleted = false;

  constructor(options: SenderOptions) {
    super(options);
    this.senderOptions = options;
  }

  close(): void {
    if (this.readyTimer !== null) {
      window.clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.ackTimer !== null) {
      window.clearTimeout(this.ackTimer);
      this.ackTimer = null;
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
    this.maybeSendPrimary();
  }

  private maybeSendPrimary(): void {
    if (this.sending || !this.peerAuthenticated || !this.peerReady) return;
    this.sending = true;
    if (this.readyTimer !== null) {
      window.clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    void this.sendPrimary();
  }

  protected onControlMessage(message: Record<string, unknown>): void {
    const kind = message.kind;
    if (kind === 'auth-ready') {
      this.peerReady = true;
      this.maybeSendPrimary();
      return;
    }
    if (kind === 'reciprocal-presence') {
      this.peerContribution = message.present === true;
      this.options.callbacks.onPeerContribution?.(this.peerContribution);
      if (this.primaryAcked && !this.peerContribution) this.finish();
      return;
    }
    if (kind === 'ack') {
      if (message.direction === 'primary') {
        this.onPrimaryAck();
      } else if (message.direction === 'reciprocal') {
        this.onReciprocalAck();
      }
      return;
    }
    if (kind === 'payload-meta' && message.direction === 'reciprocal') {
      this.onReciprocalMeta(message);
      return;
    }
    if (kind === 'payload-complete' && message.direction === 'reciprocal') {
      void this.onReciprocalComplete();
    }
  }

  protected onBinaryMessage(data: ArrayBuffer): void {
    if (!this.reciprocalMeta || this.reciprocalCompleted) return;
    const { meta, noteMeta: upcomingNote } = this.reciprocalMeta;
    if (this.reciprocalPhotoBytes + data.byteLength <= meta.size) {
      this.reciprocalChunks.push(data);
      this.reciprocalPhotoBytes += data.byteLength;
      this.options.callbacks.onPhase(
        'progress',
        this.reciprocalPhotoBytes + this.reciprocalNoteBytes,
        meta.size + (upcomingNote?.size ?? 0),
      );
      return;
    }
    const remainingPhoto = meta.size - this.reciprocalPhotoBytes;
    if (remainingPhoto > 0) {
      this.reciprocalChunks.push(data.slice(0, remainingPhoto));
      this.reciprocalPhotoBytes = meta.size;
      data = data.slice(remainingPhoto);
    }
    if (!upcomingNote) return;
    if (this.reciprocalNoteBytes + data.byteLength > upcomingNote.size) {
      this.fail('The reciprocal voice note arrived with an unexpected size.', 'reciprocal');
      return;
    }
    this.reciprocalNoteChunks.push(data);
    this.reciprocalNoteBytes += data.byteLength;
    this.options.callbacks.onPhase(
      'progress',
      this.reciprocalPhotoBytes + this.reciprocalNoteBytes,
      meta.size + upcomingNote.size,
    );
  }

  private onPrimaryAck(): void {
    if (!this.peerAuthenticated || this.primaryAcked) return;
    this.primaryAcked = true;
    this.deliveryCompleted = true;
    if (this.ackTimer !== null) {
      window.clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    void this.emitDiagnostics(true);
    this.options.callbacks.onPhase(
      'complete',
      this.senderOptions.meta.size + (this.senderOptions.note?.size ?? 0),
      this.senderOptions.meta.size + (this.senderOptions.note?.size ?? 0),
    );
    void Promise.resolve(this.options.callbacks.onSenderComplete()).catch(() => {
      // The caller reports storage errors separately.
    });
    if (!this.peerContribution) this.finish();
  }

  private onReciprocalMeta(message: Record<string, unknown>): void {
    if (!this.peerAuthenticated || this.reciprocalMeta) return;
    if (!this.peerContribution) {
      this.peerContribution = true;
      this.options.callbacks.onPeerContribution?.(true);
    }
    const validated = validateMeta(message);
    if (!validated) {
      this.fail('The other browser sent an invalid reciprocal photo.', 'reciprocal');
      return;
    }
    this.reciprocalMeta = validated;
    this.reciprocalCompleted = false;
    this.options.callbacks.onPhase('progress', 0, validated.meta.size + (validated.noteMeta?.size ?? 0));
  }

  private async onReciprocalComplete(): Promise<void> {
    if (!this.reciprocalMeta || this.reciprocalCompleted) return;
    const { meta, noteMeta: receivedNote } = this.reciprocalMeta;
    if (this.reciprocalPhotoBytes !== meta.size) {
      this.fail('The reciprocal photo arrived incomplete.', 'reciprocal');
      return;
    }
    if (receivedNote && this.reciprocalNoteBytes !== receivedNote.size) {
      this.fail('The reciprocal voice note arrived incomplete.', 'reciprocal');
      return;
    }
    this.reciprocalCompleted = true;
    const photo = new Blob(this.reciprocalChunks, { type: meta.type });
    const note: VoiceNoteAttachment | null =
      receivedNote && this.reciprocalNoteChunks.length > 0
        ? {
            blob: new Blob(this.reciprocalNoteChunks, { type: receivedNote.type }),
            name: receivedNote.name,
            type: receivedNote.type,
            size: receivedNote.size,
            durationMs: receivedNote.durationMs,
          }
        : null;
    const { photoIdFor } = await import('./media');
    const photoId = await photoIdFor(photo);
    try {
      await this.options.callbacks.onReciprocalComplete?.({
        photo,
        meta: { ...meta, note: receivedNote },
        note,
        photoId,
      });
    } finally {
      this.sendControl({
        kind: 'ack',
        transferId: this.options.transferId,
        direction: 'reciprocal',
      });
      try {
        this.options.callbacks.onReciprocalAcked?.({
          photo,
          meta: { ...meta, note: receivedNote },
          note,
          photoId,
        });
      } catch {
        // Reporting is best effort and never blocks the ACK.
      }
    }
  }

  private onReciprocalAck(): void {
    if (!this.reciprocalCompleted) return;
    this.finish();
  }

  private finish(): void {
    window.setTimeout(() => this.close(), 250);
  }

  private async sendPrimary(): Promise<void> {
    const channel = this.channel;
    if (!channel || channel.readyState !== 'open') {
      this.fail('The direct connection closed before delivery.');
      return;
    }
    const payload = {
      photo: this.senderOptions.photo,
      meta: this.senderOptions.meta,
      note: this.senderOptions.note,
    };
    try {
      await streamPayload(
        channel,
        this.options.transferId,
        'primary',
        payload,
        (sent, total) => this.options.callbacks.onPhase('progress', sent, total),
        () => this.finished,
        (message, direction) => this.fail(message, direction),
      );
      if (this.finished) return;
      this.ackTimer = window.setTimeout(() => {
        if (!this.finished && !this.primaryAcked) {
          this.fail('The other browser did not confirm the photo.');
        }
      }, ACK_TIMEOUT_MS);
    } catch (error) {
      this.fail(
        error instanceof Error ? error.message : 'The transfer could not be sent.',
      );
    }
  }
}

export class ReceiverTransfer extends BaseTransfer {
  private readonly receiverOptions: ReceiverOptions;
  private incoming: IncomingPayload | null = null;
  private receiverInactivityTimer: number | null = null;
  private completed = false;
  private contributionAcked = false;
  private sendingContribution = false;

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
    this.sendControl({
      kind: 'reciprocal-presence',
      transferId: this.options.transferId,
      present: Boolean(this.receiverOptions.contribution),
    });
    this.options.callbacks.onPhase('connecting', 0, 0);
    this.resetInactivity();
  }

  protected onControlMessage(message: Record<string, unknown>): void {
    if (message.kind === 'payload-meta' && message.direction === 'primary') {
      if (!this.peerAuthenticated || this.incoming) return;
      const validated = validateMeta(message);
      if (!validated) {
        this.fail('The other browser sent an invalid photo.');
        return;
      }
      this.incoming = {
        direction: 'primary',
        meta: validated.meta,
        noteMeta: validated.noteMeta,
        chunks: [],
        noteChunks: [],
        photoBytes: 0,
        noteBytes: 0,
        completed: false,
      };
      this.resetInactivity();
      this.options.callbacks.onPhase(
        'progress',
        0,
        validated.meta.size + (validated.noteMeta?.size ?? 0),
      );
      return;
    }
    if (message.kind === 'payload-complete' && message.direction === 'primary') {
      void this.finishPrimary();
      return;
    }
    if (message.kind === 'ack' && message.direction === 'reciprocal') {
      if (!this.sendingContribution) return;
      this.contributionAcked = true;
      this.onContributionAcked();
      return;
    }
  }

  protected onBinaryMessage(data: ArrayBuffer): void {
    const incoming = this.incoming;
    if (!this.peerAuthenticated || !incoming || incoming.completed) return;
    if (incoming.photoBytes + data.byteLength <= incoming.meta.size) {
      incoming.chunks.push(data);
      incoming.photoBytes += data.byteLength;
      this.resetInactivity();
      this.options.callbacks.onPhase(
        'progress',
        incoming.photoBytes + incoming.noteBytes,
        incoming.meta.size + (incoming.noteMeta?.size ?? 0),
      );
      return;
    }
    const remainingPhoto = incoming.meta.size - incoming.photoBytes;
    if (remainingPhoto > 0) {
      incoming.chunks.push(data.slice(0, remainingPhoto));
      incoming.photoBytes = incoming.meta.size;
      data = data.slice(remainingPhoto);
    }
    if (!incoming.noteMeta) return;
    if (incoming.noteBytes + data.byteLength > incoming.noteMeta.size) {
      this.fail('The voice note arrived with an unexpected size.');
      return;
    }
    incoming.noteChunks.push(data);
    incoming.noteBytes += data.byteLength;
    this.resetInactivity();
    this.options.callbacks.onPhase(
      'progress',
      incoming.photoBytes + incoming.noteBytes,
      incoming.meta.size + incoming.noteMeta.size,
    );
  }

  private async finishPrimary(): Promise<void> {
    const incoming = this.incoming;
    if (!incoming || this.completed || !this.peerAuthenticated) return;
    if (incoming.photoBytes !== incoming.meta.size) {
      this.fail('The photo arrived incomplete.');
      return;
    }
    if (incoming.noteMeta && incoming.noteBytes !== incoming.noteMeta.size) {
      this.fail('The voice note arrived incomplete.');
      return;
    }
    this.completed = true;
    this.clearReceiverTimer();
    void this.emitDiagnostics(true);
    const photo = new Blob(incoming.chunks, { type: incoming.meta.type });
    const note: VoiceNoteAttachment | null =
      incoming.noteMeta && incoming.noteChunks.length > 0
        ? {
            blob: new Blob(incoming.noteChunks, { type: incoming.noteMeta.type }),
            name: incoming.noteMeta.name,
            type: incoming.noteMeta.type,
            size: incoming.noteMeta.size,
            durationMs: incoming.noteMeta.durationMs,
          }
        : null;
    const { photoIdFor } = await import('./media');
    const photoId = await photoIdFor(photo);
    try {
      await this.options.callbacks.onReceiverComplete({
        photo,
        meta: { ...incoming.meta, note: incoming.noteMeta },
        note,
        photoId,
      });
    } catch {
      this.fail('The photo could not be stored on this browser.');
      return;
    }
    // The ACK is sent only after local persistence succeeded.
    this.sendControl({
      kind: 'ack',
      transferId: this.options.transferId,
      direction: 'primary',
    });
    this.deliveryCompleted = true;
    try {
      this.options.callbacks.onReceiverAcked?.({
        photo,
        meta: { ...incoming.meta, note: incoming.noteMeta },
        note,
        photoId,
      });
    } catch {
      // Reporting is best effort and never blocks the ACK.
    }
    this.options.callbacks.onPhase(
      'complete',
      incoming.photoBytes + incoming.noteBytes,
      incoming.meta.size + (incoming.noteMeta?.size ?? 0),
    );
    if (this.receiverOptions.contribution) {
      void this.sendContribution();
    } else {
      window.setTimeout(() => this.close(), 400);
    }
  }

  private async sendContribution(): Promise<void> {
    if (this.sendingContribution) return;
    const contribution = this.receiverOptions.contribution;
    const channel = this.channel;
    if (!contribution || !channel || channel.readyState !== 'open') return;
    this.sendingContribution = true;
    try {
      await streamPayload(
        channel,
        this.options.transferId,
        'reciprocal',
        contribution,
        (sent, total) => this.options.callbacks.onPhase('progress', sent, total),
        () => this.finished,
        (message, direction) => this.fail(message, direction),
      );
      window.setTimeout(() => {
        if (!this.finished && !this.contributionAcked) {
          this.fail('The other browser did not confirm your reciprocal photo.', 'reciprocal');
        }
      }, ACK_TIMEOUT_MS);
    } catch (error) {
      this.fail(
        error instanceof Error ? error.message : 'Your reciprocal photo could not be sent.',
        'reciprocal',
      );
    }
  }

  private onContributionAcked(): void {
    try {
      this.options.callbacks.onContributionAcked?.();
    } catch {
      // Reporting is best effort.
    }
    window.setTimeout(() => this.close(), 250);
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
