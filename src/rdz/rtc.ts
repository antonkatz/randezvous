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
const OFFER_TIMEOUT_MS = 120_000;
const AUDIO_LIMIT_MS = 60_000;

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
}

interface OutgoingImage {
  transferId: string;
  target: HumanId;
  channelId: RendezvousId;
  file: File;
  pc: RTCPeerConnection | null;
  channel: RTCDataChannel | null;
  timeout: number;
  done: boolean;
}

interface IncomingImage {
  transferId: string;
  sender: HumanId;
  channelId: RendezvousId;
  offer: IncomingImageOffer;
  pc: RTCPeerConnection | null;
  channel: RTCDataChannel | null;
  chunks: Uint8Array[];
  received: number;
  expected: number;
  mime: string;
  accepted: boolean;
}

interface OutgoingAudio {
  transferId: string;
  target: HumanId;
  channelId: RendezvousId;
  pc: RTCPeerConnection | null;
  stream: MediaStream | null;
  timer: number;
  ticker: number;
  startedAt: number | null;
  muted: boolean;
  remoteStream: MediaStream | null;
}

interface IncomingAudio {
  transferId: string;
  sender: HumanId;
  channelId: RendezvousId;
  pc: RTCPeerConnection | null;
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
    for (const [id, transfer] of this.incomingImages) {
      closePeer(transfer.pc);
      this.connections.release(`image:in:${id}`);
    }
    this.incomingImages.clear();
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
    if (!transfer) return;
    transfer.accepted = true;
    this.deps.sendSignal(
      transfer.sender,
      transfer.channelId,
      'image-accept',
      transfer.transferId,
    );
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
    this.incomingImages.set(transferId, transfer);
  }

  declineImage(transferId: string): void {
    const transfer = this.incomingImages.get(transferId);
    if (!transfer) return;
    this.deps.sendSignal(transfer.sender, transfer.channelId, 'image-decline', transferId);
    this.incomingImages.delete(transferId);
  }

  closeIncomingImage(transferId: string): void {
    const transfer = this.incomingImages.get(transferId);
    if (!transfer) return;
    closePeer(transfer.pc);
    this.connections.release(`image:in:${transferId}`);
    this.incomingImages.delete(transferId);
  }

  sendImage(target: HumanId, channelId: RendezvousId, file: File): void {
    if (this.outgoingImage) throw new Error('Only one image can be sent at a time.');
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) throw new Error('Only PNG, JPEG, WebP, GIF, or AVIF images are allowed.');
    if (file.size > MAX_IMAGE_BYTES) throw new Error('Images must be 25 MB or smaller.');
    const transferId = randomTransferId();
    const transfer: OutgoingImage = {
      transferId,
      target,
      channelId,
      file,
      pc: null,
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
      stream: null,
      timer: 0,
      ticker: 0,
      startedAt: null,
      muted: false,
      remoteStream: null,
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
    this.outgoingAudio.timer = window.setTimeout(() => {
      if (this.outgoingAudio?.transferId === transferId && !this.outgoingAudio.startedAt) {
        this.closeAudio(false);
      }
    }, 30_000);
    this.deps.sendSignal(target, channelId, 'audio-request', transferId);
  }

  async acceptAudio(transferId: string): Promise<void> {
    const request = this.incomingAudio.get(transferId);
    if (!request) return;
    request.accepted = true;
    try {
      request.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.deps.sendSignal(request.sender, request.channelId, 'audio-decline', transferId);
      this.incomingAudio.delete(transferId);
      this.setAudio(null);
      return;
    }
    this.deps.sendSignal(request.sender, request.channelId, 'audio-accept', transferId);
    request.timer = window.setTimeout(() => {
      if (this.incomingAudio.get(transferId)?.startedAt === null) {
        closePeer(request.pc);
        for (const track of request.stream?.getTracks() ?? []) track.stop();
        this.connections.release(`audio:in:${transferId}`);
        this.incomingAudio.delete(transferId);
        this.setAudio(null);
      }
    }, 30_000);
    this.setAudio({
      transferId,
      peer: request.sender,
      phase: 'connecting',
      startedAt: null,
      muted: false,
      remoteStream: null,
      error: null,
    });
  }

  declineAudio(transferId: string): void {
    const request = this.incomingAudio.get(transferId);
    if (!request) return;
    this.deps.sendSignal(request.sender, request.channelId, 'audio-decline', transferId);
    this.incomingAudio.delete(transferId);
    this.setAudio(null);
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
      this.incomingImages.set(transferId, {
        transferId,
        sender: envelope.author,
        channelId: payload.channelId,
        offer,
        pc: null,
        channel: null,
        chunks: [],
        received: 0,
        expected: 0,
        mime: '',
        accepted: false,
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
      if (this.outgoingImage?.transferId === transferId) {
        this.deps.onImageProgress({
          transferId,
          direction: 'outgoing',
          peer: this.outgoingImage.target,
          name: 'image',
          size: this.outgoingImage.file.size,
          phase: 'declined',
          transferred: 0,
          error: null,
        });
        this.closeOutgoingImage();
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

    if (payload.signal === 'audio-accept') {
      if (this.outgoingAudio?.transferId === transferId) await this.startAudioOffer(this.outgoingAudio);
      return;
    }

    if (payload.signal === 'audio-decline') {
      if (this.outgoingAudio?.transferId === transferId) {
        this.deps.onAudioState(null);
        this.closeAudio(false);
      }
      return;
    }

    if (payload.signal === 'audio-end') {
      if (this.outgoingAudio?.transferId === transferId) this.closeAudio(false);
      const incoming = this.incomingAudio.get(transferId);
      if (incoming) {
        closePeer(incoming.pc);
        this.incomingAudio.delete(transferId);
        this.setAudio(null);
      }
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
    channel.addEventListener('open', () => {
      window.clearTimeout(transfer.timeout);
      void this.sendImageBytes(transfer);
    });
    this.wireIce(pc, transfer.target, transfer.channelId, transfer.transferId);
    transfer.timeout = window.setTimeout(() => {
      if (transfer.channel?.readyState !== 'open') {
        this.failOutgoingImage('The direct connection timed out.');
      }
    }, 30_000);
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.failOutgoingImage('The direct connection could not be made.');
      }
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
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
    if (!channel || channel.readyState !== 'open') return;
    channel.send(
      JSON.stringify({
        type: 'meta',
        name: 'image',
        size: transfer.file.size,
        mime: transfer.file.type,
      }),
    );
    const buffer = new Uint8Array(await transfer.file.arrayBuffer());
    let offset = 0;
    const sendNext = (): void => {
      if (transfer.done) return;
      if (offset >= buffer.length) return;
      const end = Math.min(buffer.length, offset + CHUNK_SIZE);
      channel.send(buffer.slice(offset, end));
      offset = end;
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
      if (offset < buffer.length) {
        window.setTimeout(sendNext, 0);
      }
    };
    channel.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string };
        if (message.type === 'ack') {
          transfer.done = true;
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

    const pc = incoming?.pc ?? outgoing?.pc ?? incomingAudio?.pc ?? outgoingAudio?.pc ?? null;

    if (payload.signal === 'offer' && data?.sdp) {
      if (incoming && incoming.accepted) {
        if (!this.connections.tryAcquire(`image:in:${incoming.transferId}`)) {
          this.deps.sendSignal(incoming.sender, incoming.channelId, 'image-decline', incoming.transferId);
          this.incomingImages.delete(incoming.transferId);
          return;
        }
        const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        incoming.pc = peer;
        peer.addEventListener('datachannel', (event) => {
          incoming.channel = event.channel;
          event.channel.binaryType = 'arraybuffer';
          event.channel.addEventListener('message', (message) => this.receiveImageChunk(incoming, message));
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
        await peer.setRemoteDescription(data.sdp);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        this.deps.sendSignal(incoming.sender, incoming.channelId, 'answer', incoming.transferId, {
          sdp: plainSdp(peer.localDescription),
        });
        return;
      }
      if (incomingAudio?.accepted) {
        if (!this.connections.tryAcquire(`audio:in:${incomingAudio.transferId}`)) {
          this.deps.sendSignal(incomingAudio.sender, incomingAudio.channelId, 'audio-decline', incomingAudio.transferId);
          this.incomingAudio.delete(incomingAudio.transferId);
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
            closePeer(incomingAudio.pc);
            for (const track of incomingAudio.stream?.getTracks() ?? []) track.stop();
            this.connections.release(`audio:in:${incomingAudio.transferId}`);
            this.incomingAudio.delete(incomingAudio.transferId);
            this.setAudio(null);
          }
        });
        if (incomingAudio.stream) {
          for (const track of incomingAudio.stream.getTracks()) peer.addTrack(track, incomingAudio.stream);
        }
        this.wireIce(peer, incomingAudio.sender, incomingAudio.channelId, incomingAudio.transferId);
        await peer.setRemoteDescription(data.sdp);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        this.deps.sendSignal(incomingAudio.sender, incomingAudio.channelId, 'answer', incomingAudio.transferId, {
          sdp: plainSdp(peer.localDescription),
        });
      }
      return;
    }

    if (payload.signal === 'answer' && pc && data?.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (outgoingAudio) this.startOutgoingAudio(outgoingAudio);
      return;
    }

    if (payload.signal === 'ice' && pc && data?.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch {
        // ICE can arrive before the remote description; ignore late failures.
      }
    }
  }

  private failIncomingImage(transfer: IncomingImage, message: string): void {
    this.deps.onImageFailed(transfer.transferId, message);
    closePeer(transfer.pc);
    this.connections.release(`image:in:${transfer.transferId}`);
    this.incomingImages.delete(transfer.transferId);
  }

  private receiveImageChunk(transfer: IncomingImage, event: MessageEvent): void {
    if (typeof event.data === 'string') {
      try {
        const message = JSON.parse(event.data) as { type?: string; size?: number; mime?: string };
        if (message.type === 'meta') {
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
        // Ignore.
      }
      return;
    }
    const chunk = new Uint8Array(event.data as ArrayBuffer);
    transfer.chunks.push(chunk);
    transfer.received += chunk.length;
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
    if (transfer.received >= transfer.expected) {
      const blob = new Blob(transfer.chunks as unknown as BlobPart[], { type: transfer.mime || 'application/octet-stream' });
      transfer.channel?.send(JSON.stringify({ type: 'ack' }));
      this.deps.onImageComplete(transfer.transferId, blob, transfer.mime);
      closePeer(transfer.pc);
      this.connections.release(`image:in:${transfer.transferId}`);
      this.incomingImages.delete(transfer.transferId);
    }
  }

  private failOutgoingImage(message: string): void {
    const transfer = this.outgoingImage;
    if (!transfer) return;
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
    if (!this.outgoingImage) return;
    window.clearTimeout(this.outgoingImage.timeout);
    closePeer(this.outgoingImage.pc);
    this.connections.release(`image:out:${this.outgoingImage.transferId}`);
    this.outgoingImage = null;
  }

  private async startAudioOffer(outgoing: OutgoingAudio): Promise<void> {
    if (!this.connections.tryAcquire(`audio:out:${outgoing.transferId}`)) {
      this.deps.sendSignal(outgoing.target, outgoing.channelId, 'audio-decline', outgoing.transferId);
      this.closeAudio(false);
      return;
    }
    try {
      outgoing.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.deps.sendSignal(outgoing.target, outgoing.channelId, 'audio-decline', outgoing.transferId);
      this.closeAudio(false);
      return;
    }
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
    this.deps.sendSignal(outgoing.target, outgoing.channelId, 'offer', outgoing.transferId, {
      sdp: plainSdp(pc.localDescription),
    });
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
