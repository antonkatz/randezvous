import { ConnectionBudget } from './connection-budget';
import { randomTransferId } from './ids';
import type {
  AudioSession,
  Envelope,
  HumanId,
  ImageTransferProgress,
  IncomingAudioRequest,
  IncomingImageOffer,
  RendezvousId,
  SignalKind,
  SignalPayload,
  StoredIdentity,
} from './types';

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
]);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;
const MAX_BUFFERED_SEND_BYTES = 1024 * 1024;
const MAX_PENDING_ICE = 100;
const OFFER_TIMEOUT_MS = 120_000;
const IMAGE_CONNECT_TIMEOUT_MS = 30_000;
const IMAGE_TRANSFER_TIMEOUT_MS = 120_000;
const IMAGE_TRANSFER_IDLE_MS = 30_000;
const AUDIO_RESPONSE_TIMEOUT_MS = 2 * 60_000;
const AUDIO_CONNECT_TIMEOUT_MS = 30_000;
const AUDIO_LIMIT_MS = 60_000;
// Keep the receiving transport alive briefly after the ack so the final SCTP
// packet is not discarded with the peer connection.
const ACK_FLUSH_MS = 1_000;
// The receiver signs and relays its failure reason just before closing the
// transport, and the close reaches the sender first. Wait briefly for that
// reason so the sender reports the real cause instead of a generic close.
const CLOSE_REASON_GRACE_MS = 1_500;

interface RtcDeps {
  sendSignal: (
    target: HumanId,
    channelId: RendezvousId,
    signal: SignalKind,
    transferId: string,
    data?: unknown,
  ) => void;
  isVerified: (humanId: HumanId) => boolean;
  canAcceptChannel: (humanId: HumanId, channelId: RendezvousId) => boolean;
  onImageOffer: (offer: IncomingImageOffer) => void;
  onImageProgress: (progress: ImageTransferProgress) => void;
  onImageComplete: (transferId: string, blob: Blob, mime: string) => void;
  onImageFailed: (transferId: string, message: string) => void;
  onAudioRequest: (request: IncomingAudioRequest) => void;
  onAudioState: (session: AudioSession | null) => void;
  onAudioNotice: (message: string) => void;
}

/**
 * ICE candidates can arrive before the SDP that makes the remote description
 * known. They are held here until the connection can apply them; dropping them
 * leaves some NAT pairs permanently stuck in connecting.
 */
interface NegotiatedPeer {
  pc: RTCPeerConnection | null;
  remoteReady: boolean;
  pendingIce: RTCIceCandidateInit[];
}

interface OutgoingImage extends NegotiatedPeer {
  transferId: string;
  target: HumanId;
  channelId: RendezvousId;
  file: File;
  channel: RTCDataChannel | null;
  timeout: number;
  done: boolean;
}

interface IncomingImage extends NegotiatedPeer {
  transferId: string;
  sender: HumanId;
  channelId: RendezvousId;
  offer: IncomingImageOffer;
  channel: RTCDataChannel | null;
  chunks: Uint8Array[];
  chunkChain: Promise<void>;
  received: number;
  expected: number;
  mime: string;
  accepted: boolean;
  connectTimer: number;
  idleTimer: number;
}

interface OutgoingAudio extends NegotiatedPeer {
  transferId: string;
  target: HumanId;
  channelId: RendezvousId;
  stream: MediaStream | null;
  timer: number;
  ticker: number;
  startedAt: number | null;
  muted: boolean;
  remoteStream: MediaStream | null;
  negotiating: boolean;
}

interface IncomingAudio extends NegotiatedPeer {
  transferId: string;
  sender: HumanId;
  channelId: RendezvousId;
  stream: MediaStream | null;
  accepted: boolean;
  timer: number;
  ticker: number;
  startedAt: number | null;
  muted: boolean;
  remoteStream: MediaStream | null;
}

export class RtcManager {
  private outgoingImage: OutgoingImage | null = null;
  private incomingImages = new Map<string, IncomingImage>();
  private outgoingAudio: OutgoingAudio | null = null;
  private incomingAudio = new Map<string, IncomingAudio>();
  private audioSession: AudioSession | null = null;
  private readonly connections: ConnectionBudget;
  private stopped = false;

  constructor(
    private readonly identity: StoredIdentity,
    private readonly deps: RtcDeps,
    connections?: ConnectionBudget,
  ) {
    this.connections = connections ?? new ConnectionBudget();
  }

  stop(): void {
    this.stopped = true;
    this.closeOutgoingImage();
    for (const transfer of [...this.incomingImages.values()]) {
      this.dropIncomingImage(transfer.transferId);
    }
    this.closeAudio(false);
  }

  get liveConnectionCount(): number {
    return this.connections.size;
  }

  /** Humans with an active or pending photo or voice session. */
  busyPeers(): Set<HumanId> {
    const peers = new Set<HumanId>();
    if (this.outgoingImage) peers.add(this.outgoingImage.target);
    for (const transfer of this.incomingImages.values()) peers.add(transfer.sender);
    if (this.outgoingAudio) peers.add(this.outgoingAudio.target);
    for (const transfer of this.incomingAudio.values()) peers.add(transfer.sender);
    return peers;
  }

  /** Called after the local user accepts an incoming image offer. */
  async acceptImage(transferId: string): Promise<void> {
    const transfer = this.incomingImages.get(transferId);
    if (!transfer || transfer.accepted) return;
    if (Date.now() - transfer.offer.receivedAt > OFFER_TIMEOUT_MS) {
      this.deps.sendSignal(transfer.sender, transfer.channelId, 'image-decline', transferId, {
        reason: 'The image offer expired.',
      });
      this.dropIncomingImage(transferId);
      this.deps.onImageFailed(transferId, 'The image offer expired.');
      return;
    }
    transfer.accepted = true;
    this.deps.sendSignal(
      transfer.sender,
      transfer.channelId,
      'image-accept',
      transfer.transferId,
    );
    transfer.connectTimer = window.setTimeout(() => {
      if (this.incomingImages.get(transferId) === transfer && transfer.expected === 0) {
        this.failIncomingImage(transfer, 'The direct connection timed out.');
      }
    }, IMAGE_CONNECT_TIMEOUT_MS);
    this.deps.onImageProgress({
      transferId,
      direction: 'incoming',
      peer: transfer.sender,
      name: 'image',
      size: Math.round(transfer.offer.sizeMb * 1024 * 1024),
      phase: 'connecting',
      transferred: 0,
      error: null,
    });
  }

  declineImage(transferId: string): void {
    const transfer = this.incomingImages.get(transferId);
    if (!transfer) return;
    this.deps.sendSignal(transfer.sender, transfer.channelId, 'image-decline', transferId);
    this.dropIncomingImage(transferId);
  }

  closeIncomingImage(transferId: string): void {
    this.dropIncomingImage(transferId);
  }

  sendImage(target: HumanId, channelId: RendezvousId, file: File): void {
    if (this.outgoingImage) throw new Error('Only one image can be sent at a time.');
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) throw new Error('Only PNG, JPEG, WebP, GIF, or AVIF images are allowed.');
    if (file.size <= 0) throw new Error('That image is empty.');
    if (file.size > MAX_IMAGE_BYTES) throw new Error('Images must be 25 MB or smaller.');
    const transferId = randomTransferId();
    const transfer: OutgoingImage = {
      transferId,
      target,
      channelId,
      file,
      pc: null,
      remoteReady: false,
      pendingIce: [],
      channel: null,
      timeout: window.setTimeout(() => this.failOutgoingImage('No answer from the recipient.'), OFFER_TIMEOUT_MS),
      done: false,
    };
    this.outgoingImage = transfer;
    this.deps.sendSignal(target, channelId, 'image-offer', transferId, {
      sizeMb: file.size / (1024 * 1024),
    });
    this.deps.onImageProgress({
      transferId,
      direction: 'outgoing',
      peer: target,
      name: 'image',
      size: file.size,
      phase: 'waiting',
      transferred: 0,
      error: null,
    });
  }

  get isSendingImage(): boolean {
    return this.outgoingImage !== null;
  }

  async requestAudio(target: HumanId, channelId: RendezvousId): Promise<void> {
    if (this.outgoingAudio) return;
    const transferId = randomTransferId();
    this.outgoingAudio = {
      transferId,
      target,
      channelId,
      pc: null,
      remoteReady: false,
      pendingIce: [],
      stream: null,
      timer: 0,
      ticker: 0,
      startedAt: null,
      muted: false,
      remoteStream: null,
      negotiating: false,
    };
    this.setAudio({
      transferId,
      peer: target,
      phase: 'requesting',
      startedAt: null,
      muted: false,
      remoteStream: null,
      error: null,
    });
    // Wait for the recipient to respond. Once they press accept they send an
    // interim "accepting" signal, so this timer never runs during their
    // microphone permission prompt.
    this.outgoingAudio.timer = window.setTimeout(() => {
      if (this.outgoingAudio?.transferId === transferId && !this.outgoingAudio.startedAt) {
        this.deps.sendSignal(target, channelId, 'audio-decline', transferId);
        this.deps.onAudioNotice('No answer to the voice request.');
        this.closeAudio(false);
      }
    }, AUDIO_RESPONSE_TIMEOUT_MS);
    this.deps.sendSignal(target, channelId, 'audio-request', transferId);
  }

  async acceptAudio(transferId: string): Promise<void> {
    const request = this.incomingAudio.get(transferId);
    if (!request) {
      this.deps.onAudioNotice('That voice request is no longer available.');
      return;
    }
    if (request.accepted) return;
    request.accepted = true;
    // Tell the initiator we saw the request before the browser prompt opens.
    // This stops their no-answer timer while permission is pending.
    this.deps.sendSignal(request.sender, request.channelId, 'audio-accepting', transferId);
    this.setAudio({
      transferId,
      peer: request.sender,
      phase: 'connecting',
      startedAt: null,
      muted: false,
      remoteStream: null,
      error: null,
    });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (this.incomingAudio.get(transferId) === request) {
        this.deps.sendSignal(request.sender, request.channelId, 'audio-decline', transferId);
        this.dropIncomingAudio(transferId);
        this.deps.onAudioNotice(microphoneErrorMessage(error));
      }
      return;
    }
    if (this.stopped || this.incomingAudio.get(transferId) !== request) {
      stopStream(stream);
      return;
    }
    request.stream = stream;
    this.deps.sendSignal(request.sender, request.channelId, 'audio-accept', transferId);
    request.timer = window.setTimeout(() => {
      if (this.incomingAudio.get(transferId) === request && !request.startedAt) {
        this.deps.sendSignal(request.sender, request.channelId, 'audio-decline', transferId);
        this.deps.onAudioNotice('The other person did not start the voice connection.');
        this.dropIncomingAudio(transferId);
      }
    }, AUDIO_RESPONSE_TIMEOUT_MS);
  }

  declineAudio(transferId: string): void {
    const request = this.incomingAudio.get(transferId);
    if (!request) {
      this.deps.onAudioNotice('That voice request is no longer available.');
      return;
    }
    this.deps.sendSignal(request.sender, request.channelId, 'audio-decline', transferId);
    this.dropIncomingAudio(transferId);
  }

  toggleMute(): void {
    if (this.outgoingAudio?.stream) {
      this.outgoingAudio.muted = !this.outgoingAudio.muted;
      for (const track of this.outgoingAudio.stream.getAudioTracks()) {
        track.enabled = !this.outgoingAudio.muted;
      }
      this.deps.sendSignal(
        this.outgoingAudio.target,
        this.outgoingAudio.channelId,
        'audio-mute',
        this.outgoingAudio.transferId,
        { muted: this.outgoingAudio.muted },
      );
      this.publishAudio();
    }
    if (this.incomingAudio.size > 0) {
      const [session] = [...this.incomingAudio.values()];
      if (session?.stream) {
        session.muted = !session.muted;
        for (const track of session.stream.getAudioTracks()) track.enabled = !session.muted;
        this.deps.sendSignal(session.sender, session.channelId, 'audio-mute', session.transferId, {
          muted: session.muted,
        });
        this.publishAudio();
      }
    }
  }

  endAudio(): void {
    this.closeAudio(true);
  }

  async handleSignal(envelope: Envelope): Promise<void> {
    if (envelope.payload.kind !== 'SIGNAL') return;
    const payload = envelope.payload;
    if (payload.target !== this.identity.humanId) return;
    if (!this.deps.isVerified(envelope.author)) return;
    if (
      (payload.signal === 'image-offer' || payload.signal === 'audio-request') &&
      !this.deps.canAcceptChannel(envelope.author, payload.channelId)
    ) {
      return;
    }
    const transferId = payload.transferId;

    if (payload.signal === 'image-offer') {
      const data = payload.data as { sizeMb?: unknown } | undefined;
      if (
        !data ||
        typeof data.sizeMb !== 'number' ||
        !Number.isFinite(data.sizeMb) ||
        data.sizeMb <= 0 ||
        data.sizeMb > 25
      ) {
        return;
      }
      const offer: IncomingImageOffer = {
        transferId,
        channelId: payload.channelId,
        sender: envelope.author,
        senderWords: [],
        senderEmoji: [],
        verified: true,
        sizeMb: data.sizeMb,
        receivedAt: Date.now(),
      };
      if (this.incomingImages.has(transferId)) return;
      this.incomingImages.set(transferId, {
        transferId,
        sender: envelope.author,
        channelId: payload.channelId,
        offer,
        pc: null,
        remoteReady: false,
        pendingIce: [],
        channel: null,
        chunks: [],
        chunkChain: Promise.resolve(),
        received: 0,
        expected: 0,
        mime: '',
        accepted: false,
        connectTimer: 0,
        idleTimer: 0,
      });
      this.deps.onImageOffer(offer);
      return;
    }

    if (payload.signal === 'image-accept') {
      const transfer = this.outgoingImage;
      if (!transfer || transfer.transferId !== transferId) return;
      await this.startImageOffer(transfer);
      return;
    }

    if (payload.signal === 'image-decline') {
      const data = payload.data as { reason?: unknown } | undefined;
      const reason = typeof data?.reason === 'string' ? data.reason.slice(0, 200) : '';
      if (this.outgoingImage?.transferId === transferId) {
        const transfer = this.outgoingImage;
        this.deps.onImageProgress({
          transferId,
          direction: 'outgoing',
          peer: transfer.target,
          name: 'image',
          size: transfer.file.size,
          phase: reason ? 'failed' : 'declined',
          transferred: 0,
          error: reason || null,
        });
        this.closeOutgoingImage();
      }
      const incoming = this.incomingImages.get(transferId);
      if (incoming) {
        const accepted = incoming.accepted;
        this.dropIncomingImage(transferId);
        if (accepted || reason) {
          this.deps.onImageFailed(
            transferId,
            reason || 'The image was withdrawn before it was received.',
          );
        }
      }
      return;
    }

    if (payload.signal === 'offer' || payload.signal === 'answer' || payload.signal === 'ice') {
      await this.handleWebRtcSignal(payload);
      return;
    }

    if (payload.signal === 'audio-request') {
      const request: IncomingAudioRequest = {
        transferId,
        channelId: payload.channelId,
        sender: envelope.author,
        senderWords: [],
        senderEmoji: [],
        verified: true,
        receivedAt: Date.now(),
      };
      this.incomingAudio.set(transferId, {
        transferId,
        sender: envelope.author,
        channelId: payload.channelId,
        pc: null,
        remoteReady: false,
        pendingIce: [],
        stream: null,
        accepted: false,
        timer: 0,
        ticker: 0,
        startedAt: null,
        muted: false,
        remoteStream: null,
      });
      this.deps.onAudioRequest(request);
      return;
    }

    if (payload.signal === 'audio-accepting') {
      const outgoing = this.outgoingAudio?.transferId === transferId ? this.outgoingAudio : null;
      if (!outgoing) return;
      window.clearTimeout(outgoing.timer);
      if (this.audioSession?.transferId === transferId) {
        this.setAudio({ ...this.audioSession, phase: 'connecting' });
      }
      outgoing.timer = window.setTimeout(() => {
        if (this.outgoingAudio === outgoing && !outgoing.startedAt) {
          this.deps.sendSignal(
            outgoing.target,
            outgoing.channelId,
            'audio-decline',
            outgoing.transferId,
          );
          this.deps.onAudioNotice('The other person did not finish starting their microphone.');
          this.closeAudio(false);
        }
      }, AUDIO_RESPONSE_TIMEOUT_MS);
      return;
    }

    if (payload.signal === 'audio-accept') {
      if (this.outgoingAudio?.transferId === transferId) await this.startAudioOffer(this.outgoingAudio);
      return;
    }

    if (payload.signal === 'audio-decline') {
      if (this.outgoingAudio?.transferId === transferId) {
        this.deps.onAudioNotice('The voice request was declined.');
        this.closeAudio(false);
      } else if (this.incomingAudio.has(transferId)) {
        this.deps.onAudioNotice('The voice request was cancelled.');
        this.dropIncomingAudio(transferId);
      }
      return;
    }

    if (payload.signal === 'audio-end') {
      const outgoing = this.outgoingAudio?.transferId === transferId ? this.outgoingAudio : null;
      const incoming = this.incomingAudio.get(transferId);
      if (outgoing || incoming) {
        const live = Boolean(outgoing?.startedAt || incoming?.startedAt);
        this.deps.onAudioNotice(
          live ? 'The other person ended the voice conversation.' : 'The voice request ended.',
        );
      }
      if (outgoing) this.closeAudio(false);
      this.dropIncomingAudio(transferId);
      return;
    }

    if (payload.signal === 'audio-mute') {
      const data = payload.data as { muted?: unknown } | undefined;
      if (typeof data?.muted === 'boolean' && this.audioSession) {
        this.setAudio({ ...this.audioSession, muted: data.muted });
      }
    }
  }

  private async startImageOffer(transfer: OutgoingImage): Promise<void> {
    // A duplicate accept must not replace the live connection; the answerer
    // path has the same guard.
    if (transfer.pc) return;
    window.clearTimeout(transfer.timeout);
    if (!this.connections.tryAcquire(`image:out:${transfer.transferId}`)) {
      this.failOutgoingImage(`At most ${this.connections.size} live peer connections are allowed.`);
      return;
    }
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    transfer.pc = pc;
    const channel = pc.createDataChannel('image', { ordered: true });
    transfer.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = MAX_BUFFERED_SEND_BYTES / 2;
    channel.addEventListener('open', () => {
      window.clearTimeout(transfer.timeout);
      transfer.timeout = window.setTimeout(() => {
        if (this.outgoingImage === transfer && !transfer.done) {
          this.failOutgoingImage('The image transfer timed out.');
        }
      }, IMAGE_TRANSFER_TIMEOUT_MS);
      void this.sendImageBytes(transfer);
    });
    channel.addEventListener('close', () => {
      this.reportOutgoingClose(transfer);
    });
    this.wireIce(pc, transfer.target, transfer.channelId, transfer.transferId);
    transfer.timeout = window.setTimeout(() => {
      if (this.outgoingImage === transfer && transfer.channel?.readyState !== 'open') {
        this.failOutgoingImage('The direct connection timed out.');
      }
    }, IMAGE_CONNECT_TIMEOUT_MS);
    pc.addEventListener('connectionstatechange', () => {
      if (
        (pc.connectionState === 'failed' || pc.connectionState === 'closed') &&
        this.outgoingImage === transfer &&
        !transfer.done
      ) {
        this.failOutgoingImage('The direct connection could not be made.');
      }
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (this.outgoingImage !== transfer) return;
    this.deps.sendSignal(transfer.target, transfer.channelId, 'offer', transfer.transferId, {
      sdp: plainSdp(pc.localDescription),
    });
    this.deps.onImageProgress({
      transferId: transfer.transferId,
      direction: 'outgoing',
      peer: transfer.target,
      name: 'image',
      size: transfer.file.size,
      phase: 'connecting',
      transferred: 0,
      error: null,
    });
  }

  private async sendImageBytes(transfer: OutgoingImage): Promise<void> {
    const channel = transfer.channel;
    if (!channel || channel.readyState !== 'open') {
      // Never leave the transfer silently stalled; surface the close.
      this.reportOutgoingClose(transfer);
      return;
    }
    try {
      channel.send(
        JSON.stringify({
          type: 'meta',
          name: 'image',
          size: transfer.file.size,
          mime: transfer.file.type,
        }),
      );
    } catch {
      this.failOutgoingImage('The image could not be sent over the direct connection.');
      return;
    }
    let buffer: Uint8Array;
    try {
      buffer = new Uint8Array(await transfer.file.arrayBuffer());
    } catch {
      this.failOutgoingImage('The image could not be read.');
      return;
    }
    if (buffer.length === 0) {
      this.failOutgoingImage('That image is empty.');
      return;
    }
    channel.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data) as { type?: string };
        if (message.type === 'ack') {
          if (this.outgoingImage !== transfer || transfer.done) return;
          transfer.done = true;
          window.clearTimeout(transfer.timeout);
          this.deps.onImageProgress({
            transferId: transfer.transferId,
            direction: 'outgoing',
            peer: transfer.target,
            name: 'image',
            size: transfer.file.size,
            phase: 'done',
            transferred: transfer.file.size,
            error: null,
          });
          this.closeOutgoingImage();
        }
      } catch {
        // Ignore non-control messages.
      }
    });
    let offset = 0;
    let reported = 0;
    const sendNext = (): void => {
      if (transfer.done || this.outgoingImage !== transfer) return;
      if (channel.readyState !== 'open') {
        this.reportOutgoingClose(transfer);
        return;
      }
      try {
        // Respect the SCTP send buffer. Mobile browsers have a much smaller
        // buffer than desktop ones and throw if it is filled in one burst.
        while (offset < buffer.length && channel.bufferedAmount < MAX_BUFFERED_SEND_BYTES) {
          const end = Math.min(buffer.length, offset + CHUNK_SIZE);
          channel.send(buffer.slice(offset, end));
          offset = end;
        }
      } catch {
        this.failOutgoingImage('The image could not be sent over the direct connection.');
        return;
      }
      if (offset > reported) {
        reported = offset;
        this.deps.onImageProgress({
          transferId: transfer.transferId,
          direction: 'outgoing',
          peer: transfer.target,
          name: 'image',
          size: transfer.file.size,
          phase: 'transferring',
          transferred: offset,
          error: null,
        });
      }
      if (offset < buffer.length) {
        window.setTimeout(
          sendNext,
          channel.bufferedAmount >= MAX_BUFFERED_SEND_BYTES ? 50 : 0,
        );
      }
    };
    sendNext();
  }

  private async handleWebRtcSignal(payload: SignalPayload): Promise<void> {
    const data = payload.data as
      | { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }
      | undefined;
    const incoming = this.incomingImages.get(payload.transferId);
    const outgoing = this.outgoingImage?.transferId === payload.transferId ? this.outgoingImage : null;
    const incomingAudio = this.incomingAudio.get(payload.transferId);
    const outgoingAudio =
      this.outgoingAudio?.transferId === payload.transferId ? this.outgoingAudio : null;
    const target = incoming ?? outgoing ?? incomingAudio ?? outgoingAudio ?? null;

    if (payload.signal === 'offer' && data?.sdp) {
      if (incoming && incoming.accepted) {
        if (incoming.pc) return;
        if (!this.connections.tryAcquire(`image:in:${incoming.transferId}`)) {
          this.failIncomingImage(incoming, 'Too many live connections are open right now.');
          return;
        }
        const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        incoming.pc = peer;
        peer.addEventListener('datachannel', (event) => {
          incoming.channel = event.channel;
          event.channel.binaryType = 'arraybuffer';
          event.channel.addEventListener('message', (message) => this.receiveImageChunk(incoming, message));
          event.channel.addEventListener('close', () => {
            if (this.incomingImages.get(incoming.transferId) === incoming) {
              this.failIncomingImage(incoming, 'The direct connection closed during the transfer.');
            }
          });
        });
        peer.addEventListener('connectionstatechange', () => {
          if (
            (peer.connectionState === 'failed' || peer.connectionState === 'closed') &&
            this.incomingImages.get(incoming.transferId) === incoming
          ) {
            this.failIncomingImage(incoming, 'The direct connection could not be made.');
          }
        });
        this.wireIce(peer, incoming.sender, incoming.channelId, incoming.transferId);
        try {
          await peer.setRemoteDescription(data.sdp);
        } catch {
          this.failIncomingImage(incoming, 'The direct connection could not be made.');
          return;
        }
        incoming.remoteReady = true;
        await this.flushPendingIce(incoming);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        if (this.incomingImages.get(incoming.transferId) !== incoming) return;
        this.deps.sendSignal(incoming.sender, incoming.channelId, 'answer', incoming.transferId, {
          sdp: plainSdp(peer.localDescription),
        });
        return;
      }
      if (incomingAudio?.accepted) {
        if (incomingAudio.pc) return;
        if (!this.connections.tryAcquire(`audio:in:${incomingAudio.transferId}`)) {
          this.deps.sendSignal(incomingAudio.sender, incomingAudio.channelId, 'audio-decline', incomingAudio.transferId);
          this.deps.onAudioNotice('Too many live connections are open right now.');
          this.dropIncomingAudio(incomingAudio.transferId);
          return;
        }
        const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        incomingAudio.pc = peer;
        peer.addEventListener('track', (event) => {
          incomingAudio.remoteStream = event.streams[0] ?? null;
          this.startIncomingAudio(incomingAudio);
        });
        peer.addEventListener('connectionstatechange', () => {
          if (
            (peer.connectionState === 'failed' || peer.connectionState === 'closed') &&
            this.incomingAudio.get(incomingAudio.transferId) === incomingAudio
          ) {
            this.dropIncomingAudio(incomingAudio.transferId);
          }
        });
        if (incomingAudio.stream) {
          for (const track of incomingAudio.stream.getTracks()) peer.addTrack(track, incomingAudio.stream);
        }
        this.wireIce(peer, incomingAudio.sender, incomingAudio.channelId, incomingAudio.transferId);
        try {
          await peer.setRemoteDescription(data.sdp);
        } catch {
          this.deps.sendSignal(incomingAudio.sender, incomingAudio.channelId, 'audio-decline', incomingAudio.transferId);
          this.deps.onAudioNotice('The voice connection could not be made.');
          this.dropIncomingAudio(incomingAudio.transferId);
          return;
        }
        incomingAudio.remoteReady = true;
        await this.flushPendingIce(incomingAudio);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        if (this.incomingAudio.get(incomingAudio.transferId) !== incomingAudio) return;
        this.deps.sendSignal(incomingAudio.sender, incomingAudio.channelId, 'answer', incomingAudio.transferId, {
          sdp: plainSdp(peer.localDescription),
        });
        // The caller only sends an offer after its own microphone is ready, so
        // it is safe to time out the remaining connection setup now.
        window.clearTimeout(incomingAudio.timer);
        incomingAudio.timer = window.setTimeout(() => {
          if (
            this.incomingAudio.get(incomingAudio.transferId) === incomingAudio &&
            !incomingAudio.startedAt
          ) {
            this.deps.sendSignal(
              incomingAudio.sender,
              incomingAudio.channelId,
              'audio-end',
              incomingAudio.transferId,
            );
            this.deps.onAudioNotice('The voice connection timed out.');
            this.dropIncomingAudio(incomingAudio.transferId);
          }
        }, AUDIO_CONNECT_TIMEOUT_MS);
      }
      return;
    }

    if (payload.signal === 'answer' && data?.sdp && target?.pc) {
      if (target.remoteReady) return;
      try {
        await target.pc.setRemoteDescription(data.sdp);
      } catch {
        // A concurrent duplicate answer may already have been applied; that
        // is benign and must not fail the live transfer.
        if (target.remoteReady) return;
        if (outgoing) {
          this.failOutgoingImage('The direct connection could not be made.');
        } else if (outgoingAudio) {
          this.deps.onAudioNotice('The voice connection could not be made.');
          this.closeAudio(false);
        }
        return;
      }
      target.remoteReady = true;
      await this.flushPendingIce(target);
      if (outgoingAudio && target === outgoingAudio) this.startOutgoingAudio(outgoingAudio);
      return;
    }

    if (payload.signal === 'ice' && data?.candidate && target) {
      const candidate = data.candidate;
      if (!target.remoteReady || !target.pc) {
        if (target.pendingIce.length < MAX_PENDING_ICE) target.pendingIce.push(candidate);
        return;
      }
      await target.pc.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  private async flushPendingIce(target: NegotiatedPeer): Promise<void> {
    const pc = target.pc;
    if (!pc) return;
    const candidates = target.pendingIce.splice(0);
    for (const candidate of candidates) {
      await pc.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  private failIncomingImage(transfer: IncomingImage, message: string): void {
    if (this.incomingImages.get(transfer.transferId) !== transfer) return;
    if (transfer.accepted) {
      this.deps.sendSignal(transfer.sender, transfer.channelId, 'image-decline', transfer.transferId, {
        reason: message,
      });
    }
    this.deps.onImageFailed(transfer.transferId, message);
    this.dropIncomingImage(transfer.transferId);
  }

  private dropIncomingImage(transferId: string): void {
    const transfer = this.incomingImages.get(transferId);
    if (!transfer) return;
    this.incomingImages.delete(transferId);
    window.clearTimeout(transfer.connectTimer);
    window.clearTimeout(transfer.idleTimer);
    closePeer(transfer.pc);
    this.connections.release(`image:in:${transferId}`);
  }

  private receiveImageChunk(transfer: IncomingImage, event: MessageEvent): void {
    if (this.incomingImages.get(transfer.transferId) !== transfer) return;
    if (typeof event.data === 'string') {
      try {
        const message = JSON.parse(event.data) as { type?: string; size?: number; mime?: string };
        if (message.type === 'meta') {
          if (transfer.expected > 0) return;
          if (
            typeof message.size !== 'number' ||
            !Number.isFinite(message.size) ||
            message.size <= 0 ||
            message.size > MAX_IMAGE_BYTES ||
            typeof message.mime !== 'string' ||
            !ALLOWED_IMAGE_TYPES.has(message.mime)
          ) {
            this.failIncomingImage(transfer, 'Unsupported or oversized image.');
            return;
          }
          transfer.expected = message.size;
          transfer.mime = message.mime;
          window.clearTimeout(transfer.connectTimer);
          transfer.connectTimer = 0;
          this.resetIncomingIdleTimer(transfer);
          this.deps.onImageProgress({
            transferId: transfer.transferId,
            direction: 'incoming',
            peer: transfer.sender,
            name: 'image',
            size: transfer.expected,
            phase: 'transferring',
            transferred: 0,
            error: null,
          });
        }
      } catch {
        // Ignore malformed control messages.
      }
      return;
    }
    transfer.chunkChain = transfer.chunkChain
      .then(async () => {
        if (this.incomingImages.get(transfer.transferId) !== transfer) return;
        const chunk =
          event.data instanceof Blob
            ? new Uint8Array(await event.data.arrayBuffer())
            : new Uint8Array(event.data as ArrayBuffer);
        this.appendIncomingChunk(transfer, chunk);
      })
      .catch(() => {
        this.failIncomingImage(transfer, 'The image could not be received.');
      });
  }

  private appendIncomingChunk(transfer: IncomingImage, chunk: Uint8Array): void {
    if (this.incomingImages.get(transfer.transferId) !== transfer) return;
    if (transfer.expected === 0) {
      this.failIncomingImage(transfer, 'The image metadata was not received.');
      return;
    }
    if (transfer.received + chunk.length > transfer.expected) {
      this.failIncomingImage(transfer, 'The image transfer was incomplete.');
      return;
    }
    transfer.chunks.push(chunk);
    transfer.received += chunk.length;
    this.resetIncomingIdleTimer(transfer);
    this.deps.onImageProgress({
      transferId: transfer.transferId,
      direction: 'incoming',
      peer: transfer.sender,
      name: 'image',
      size: transfer.expected,
      phase: 'transferring',
      transferred: transfer.received,
      error: null,
    });
    if (transfer.received === transfer.expected) this.finishIncomingImage(transfer);
  }

  private resetIncomingIdleTimer(transfer: IncomingImage): void {
    window.clearTimeout(transfer.idleTimer);
    transfer.idleTimer = window.setTimeout(() => {
      if (this.incomingImages.get(transfer.transferId) === transfer) {
        this.failIncomingImage(transfer, 'The image transfer timed out.');
      }
    }, IMAGE_TRANSFER_IDLE_MS);
  }

  private finishIncomingImage(transfer: IncomingImage): void {
    if (this.incomingImages.get(transfer.transferId) !== transfer) return;
    const blob = new Blob(transfer.chunks as unknown as BlobPart[], {
      type: transfer.mime || 'application/octet-stream',
    });
    this.incomingImages.delete(transfer.transferId);
    window.clearTimeout(transfer.connectTimer);
    window.clearTimeout(transfer.idleTimer);
    this.connections.release(`image:in:${transfer.transferId}`);
    try {
      transfer.channel?.send(JSON.stringify({ type: 'ack' }));
    } catch {
      // The image is complete locally even if the ack cannot be queued.
    }
    this.deps.onImageComplete(transfer.transferId, blob, transfer.mime);
    // Keep the transport alive briefly so the ack is actually flushed before
    // closing the peer connection.
    window.setTimeout(() => closePeer(transfer.pc), ACK_FLUSH_MS);
  }

  /**
   * The transport closed before the transfer finished. The peer usually sends
   * an image-decline carrying the real reason a moment before its close lands
   * here, so give that signal a short grace period before falling back to the
   * generic close message.
   */
  private reportOutgoingClose(transfer: OutgoingImage): void {
    if (this.outgoingImage !== transfer || transfer.done) return;
    window.clearTimeout(transfer.timeout);
    transfer.timeout = window.setTimeout(() => {
      if (this.outgoingImage === transfer && !transfer.done) {
        this.failOutgoingImage('The direct connection closed during the transfer.');
      }
    }, CLOSE_REASON_GRACE_MS);
  }

  private failOutgoingImage(message: string): void {
    const transfer = this.outgoingImage;
    if (!transfer || transfer.done) return;
    this.deps.sendSignal(transfer.target, transfer.channelId, 'image-decline', transfer.transferId, {
      reason: message,
    });
    this.deps.onImageProgress({
      transferId: transfer.transferId,
      direction: 'outgoing',
      peer: transfer.target,
      name: 'image',
      size: transfer.file.size,
      phase: 'failed',
      transferred: 0,
      error: message,
    });
    this.closeOutgoingImage();
  }

  private closeOutgoingImage(): void {
    const transfer = this.outgoingImage;
    if (!transfer) return;
    this.outgoingImage = null;
    window.clearTimeout(transfer.timeout);
    closePeer(transfer.pc);
    this.connections.release(`image:out:${transfer.transferId}`);
  }

  private async startAudioOffer(outgoing: OutgoingAudio): Promise<void> {
    if (this.outgoingAudio !== outgoing || outgoing.negotiating) return;
    // Set synchronously: getUserMedia below yields before the pc exists.
    outgoing.negotiating = true;
    window.clearTimeout(outgoing.timer);
    outgoing.timer = 0;
    if (!this.connections.tryAcquire(`audio:out:${outgoing.transferId}`)) {
      this.deps.sendSignal(outgoing.target, outgoing.channelId, 'audio-decline', outgoing.transferId);
      this.deps.onAudioNotice('Too many live connections are open right now.');
      this.closeAudio(false);
      return;
    }
    if (this.audioSession?.transferId === outgoing.transferId) {
      this.setAudio({ ...this.audioSession, phase: 'connecting' });
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (this.outgoingAudio === outgoing) {
        this.deps.sendSignal(outgoing.target, outgoing.channelId, 'audio-decline', outgoing.transferId);
        this.deps.onAudioNotice(microphoneErrorMessage(error));
        this.closeAudio(false);
      }
      return;
    }
    if (this.stopped || this.outgoingAudio !== outgoing) {
      stopStream(stream);
      return;
    }
    outgoing.stream = stream;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    outgoing.pc = pc;
    for (const track of outgoing.stream.getTracks()) pc.addTrack(track, outgoing.stream);
    pc.addEventListener('track', (event) => {
      outgoing.remoteStream = event.streams[0] ?? null;
      this.startOutgoingAudio(outgoing);
    });
    pc.addEventListener('connectionstatechange', () => {
      if (
        (pc.connectionState === 'failed' || pc.connectionState === 'closed') &&
        this.outgoingAudio?.transferId === outgoing.transferId
      ) {
        this.closeAudio(false);
      }
    });
    this.wireIce(pc, outgoing.target, outgoing.channelId, outgoing.transferId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (this.outgoingAudio !== outgoing) return;
    this.deps.sendSignal(outgoing.target, outgoing.channelId, 'offer', outgoing.transferId, {
      sdp: plainSdp(pc.localDescription),
    });
    // Start counting only after the microphone is ready and the offer is out;
    // the earlier wait belongs to the recipient, not to the connection.
    window.clearTimeout(outgoing.timer);
    outgoing.timer = window.setTimeout(() => {
      if (this.outgoingAudio === outgoing && !outgoing.startedAt) {
        this.deps.onAudioNotice('The voice connection timed out.');
        this.closeAudio(true);
      }
    }, AUDIO_CONNECT_TIMEOUT_MS);
  }

  private startOutgoingAudio(outgoing: OutgoingAudio): void {
    if (outgoing.startedAt) return;
    outgoing.startedAt = Date.now();
    this.setAudio({
      transferId: outgoing.transferId,
      peer: outgoing.target,
      phase: 'live',
      startedAt: outgoing.startedAt,
      muted: outgoing.muted,
      remoteStream: outgoing.remoteStream,
      error: null,
    });
    window.clearTimeout(outgoing.timer);
    outgoing.timer = window.setTimeout(() => this.endAudio(), AUDIO_LIMIT_MS);
    outgoing.ticker = window.setInterval(() => this.publishAudio(), 250);
  }

  private startIncomingAudio(incoming: IncomingAudio): void {
    if (incoming.startedAt) return;
    incoming.startedAt = Date.now();
    this.setAudio({
      transferId: incoming.transferId,
      peer: incoming.sender,
      phase: 'live',
      startedAt: incoming.startedAt,
      muted: incoming.muted,
      remoteStream: incoming.remoteStream,
      error: null,
    });
    window.clearTimeout(incoming.timer);
    incoming.timer = window.setTimeout(() => this.endAudio(), AUDIO_LIMIT_MS);
    incoming.ticker = window.setInterval(() => this.publishAudio(), 250);
  }

  private closeAudio(notify: boolean): void {
    const outgoing = this.outgoingAudio;
    const incoming = [...this.incomingAudio.values()];
    if (notify) {
      if (outgoing) {
        this.deps.sendSignal(outgoing.target, outgoing.channelId, 'audio-end', outgoing.transferId);
      }
      for (const session of incoming) {
        this.deps.sendSignal(session.sender, session.channelId, 'audio-end', session.transferId);
      }
    }
    if (outgoing) {
      window.clearTimeout(outgoing.timer);
      window.clearInterval(outgoing.ticker);
      for (const track of outgoing.stream?.getTracks() ?? []) track.stop();
      closePeer(outgoing.pc);
      this.connections.release(`audio:out:${outgoing.transferId}`);
    }
    for (const session of incoming) {
      window.clearTimeout(session.timer);
      window.clearInterval(session.ticker);
      for (const track of session.stream?.getTracks() ?? []) track.stop();
      closePeer(session.pc);
      this.connections.release(`audio:in:${session.transferId}`);
    }
    this.outgoingAudio = null;
    this.incomingAudio.clear();
    this.audioSession = null;
    this.deps.onAudioState(null);
  }

  private dropIncomingAudio(transferId: string): void {
    const incoming = this.incomingAudio.get(transferId);
    if (!incoming) return;
    window.clearTimeout(incoming.timer);
    window.clearInterval(incoming.ticker);
    stopStream(incoming.stream);
    closePeer(incoming.pc);
    this.connections.release(`audio:in:${transferId}`);
    this.incomingAudio.delete(transferId);
    if (this.audioSession?.transferId === transferId) this.setAudio(null);
  }

  private setAudio(session: AudioSession | null): void {
    this.audioSession = session;
    this.deps.onAudioState(session);
  }

  private publishAudio(): void {
    const outgoing = this.outgoingAudio;
    if (outgoing && this.audioSession?.transferId === outgoing.transferId) {
      this.setAudio({
        ...this.audioSession,
        muted: outgoing.muted,
        remoteStream: outgoing.remoteStream,
        phase: 'live',
      });
      return;
    }
    const incoming = [...this.incomingAudio.values()][0];
    if (incoming && this.audioSession?.transferId === incoming.transferId) {
      this.setAudio({
        ...this.audioSession,
        muted: incoming.muted,
        remoteStream: incoming.remoteStream,
        phase: 'live',
      });
    }
  }

  private wireIce(
    pc: RTCPeerConnection,
    target: HumanId,
    channelId: RendezvousId,
    transferId: string,
  ): void {
    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        this.deps.sendSignal(target, channelId, 'ice', transferId, {
          candidate: event.candidate.toJSON(),
        });
      }
    });
  }
}

function plainSdp(description: RTCSessionDescription | null): { type: RTCSdpType; sdp: string } | null {
  if (!description) return null;
  return { type: description.type, sdp: description.sdp };
}

function closePeer(pc: RTCPeerConnection | null): void {
  if (!pc) return;
  try {
    pc.close();
  } catch {
    // Ignore.
  }
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function microphoneErrorMessage(error: unknown): string {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name?: unknown }).name)
      : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was not allowed.';
    case 'NotFoundError':
      return 'No microphone was found.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is unavailable.';
    default:
      return 'Could not start the microphone.';
  }
}
