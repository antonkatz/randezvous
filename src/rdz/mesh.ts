import { ConnectionBudget, MAX_LIVE_PEER_CONNECTIONS } from './connection-budget';
import {
  createEnvelope,
  envelopeId,
  isNotFromFuture,
  isValidGoing,
  isValidPing,
  SIGNAL_TTL_MS,
  signText,
  verifyEnvelope,
} from './crypto';
import { envelopeTransportKey, meshHelloBody } from './mesh-control';
import { randomTransferId } from './ids';
import type { TrafficPeer, TrafficReport } from './traffic';
import type {
  Envelope,
  HumanId,
  MaskRecord,
  MeshPeerInfo,
  SignalKind,
  SignalPayload,
} from './types';

export type MeshStatus = 'connecting' | 'online' | 'offline';

interface MeshOptions {
  budget: ConnectionBudget;
  bootstrapUrl: string;
  isVerified: (humanId: HumanId) => boolean;
  isBusy: (humanId: HumanId) => boolean;
  onEnvelope: (value: unknown) => void;
  onStatus: (status: MeshStatus) => void;
  onPeers: (peers: MeshPeerInfo[]) => void;
  onTraffic: (report: TrafficReport) => void;
}

type PeerState = 'connecting' | 'open' | 'closed';

interface MeshPeer {
  key: string;
  humanId: HumanId | null;
  isSeed: boolean;
  outbound: boolean;
  attemptId: string;
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  state: PeerState;
  remoteDescriptionSet: boolean;
  signalReady: boolean;
  seedReady: boolean;
  pendingIce: RTCIceCandidateInit[];
  localCandidates: RTCIceCandidateInit[];
  connectTimer: number;
  openedAt: number;
}

interface CachedEnvelope {
  envelope: Envelope;
  expiresAt: number;
}

const MAX_OUTBOX = 100;
const CONNECT_TIMEOUT_MS = 20_000;
const RETRY_AFTER_MS = 90_000;
const BOOTSTRAP_RECONNECT_BASE_MS = 750;

/**
 * The WebRTC data-channel mesh. Application envelopes (PING, GOING, SIGNAL)
 * only ever move over these channels. The WebSocket to the seed is used
 * exclusively for the bootstrap SDP/ICE exchange that creates the first
 * channel.
 */
export class MeshManager {
  private socket: WebSocket | null = null;
  private bootstrapPeer: RTCPeerConnection | null = null;
  private bootstrapAttempt = 0;
  private bootstrapTimer: number | null = null;
  private bootstrapCandidates: RTCIceCandidateInit[] = [];
  private bootstrapRemoteReady = false;
  private readonly peers = new Map<string, MeshPeer>();
  private readonly registry = new Map<HumanId, MeshPeerInfo>();
  private readonly cache = new Map<string, CachedEnvelope>();
  private readonly seen = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly failedAt = new Map<HumanId, number>();
  private readonly outbox: Envelope[] = [];
  private readonly retryTimers = new Set<number>();
  private signalChain: Promise<void> = Promise.resolve();
  private status: MeshStatus = 'offline';
  private stopped = false;
  private pruneTimer: number | null = null;
  private rotationTimer: number | null = null;

  constructor(
    private readonly identity: MaskRecord,
    private readonly options: MeshOptions,
  ) {}

  start(): void {
    this.stopped = false;
    this.pruneTimer = window.setInterval(() => this.prune(), 30_000);
    this.scheduleRotation();
    if (!this.options.bootstrapUrl) {
      this.publishStatus();
      return;
    }
    this.connectBootstrap();
  }

  stop(): void {
    this.stopped = true;
    if (this.bootstrapTimer !== null) window.clearTimeout(this.bootstrapTimer);
    this.bootstrapTimer = null;
    for (const timer of this.retryTimers) window.clearTimeout(timer);
    this.retryTimers.clear();
    if (this.pruneTimer !== null) window.clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    if (this.rotationTimer !== null) window.clearTimeout(this.rotationTimer);
    this.rotationTimer = null;
    this.socket?.close();
    this.socket = null;
    this.closeBootstrapPeer();
    for (const peer of [...this.peers.values()]) this.closePeer(peer, true);
    this.peers.clear();
    this.inFlight.clear();
    this.setStatus('offline');
  }

  get liveConnectionCount(): number {
    return [...this.peers.values()].filter((peer) => peer.state !== 'closed').length;
  }

  get openPeerCount(): number {
    return [...this.peers.values()].filter((peer) => peer.state === 'open').length;
  }

  /** Publish a locally-created application envelope to the WebRTC mesh. */
  async publish(envelope: Envelope): Promise<void> {
    await this.rememberAndPublish(envelope);
  }

  /** Cache a persisted envelope so it can be replayed to new peers. */
  remember(envelope: Envelope): void {
    void this.rememberAsync(envelope);
  }

  /**
   * Ask the mesh to open a direct WebRTC link to a known human. A new peer
   * uses an existing peer as introducer; if no link exists the offer waits in
   * the outbox for the first WebRTC channel.
   */
  considerPeer(humanId: HumanId, publicKey = ''): void {
    if (this.stopped || humanId === this.identity.humanId) return;
    if (publicKey) this.registry.set(humanId, { humanId, publicKey });
    else if (!this.registry.has(humanId)) this.registry.set(humanId, { humanId, publicKey });
    if (this.peers.has(humanId)) return;
    const failed = this.failedAt.get(humanId);
    if (failed && Date.now() - failed < RETRY_AFTER_MS) return;
    const timer = window.setTimeout(() => {
      this.retryTimers.delete(timer);
      if (this.stopped || this.peers.has(humanId)) return;
      void this.connectTo(humanId);
    }, 350 + Math.floor(Math.random() * 900));
    this.retryTimers.add(timer);
  }

  private async rememberAsync(envelope: Envelope): Promise<void> {
    const expiresAt = expiryFor(envelope);
    if (expiresAt <= Date.now()) return;
    const id = await envelopeId(envelope);
    this.seen.set(id, expiresAt);
    if (envelope.type === 'PING' || envelope.type === 'GOING') {
      this.cache.set(id, { envelope, expiresAt });
    }
  }

  private async rememberAndPublish(envelope: Envelope): Promise<void> {
    await this.rememberAsync(envelope);
    let destinations = 0;
    if (this.openPeers().length === 0) {
      if (envelope.type === 'SIGNAL') this.queueSignal(envelope);
    } else {
      destinations = this.broadcast(envelope, null);
    }
    this.reportTraffic({
      direction: 'going',
      envelope,
      destinations,
      bytes: envelopeBytes(envelope),
    });
  }

  private connectBootstrap(): void {
    if (this.stopped) return;
    this.setStatus(this.openPeers().length ? 'online' : 'connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.bootstrapUrl);
    } catch {
      this.scheduleBootstrap();
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.bootstrapAttempt = 0;
      this.startBootstrapOffer(socket);
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      try {
        this.handleBootstrapMessage(JSON.parse(String(event.data)));
      } catch {
        // Malformed bootstrap traffic is ignored.
      }
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.closeBootstrapPeer();
      this.setStatus(this.openPeers().length ? 'online' : 'offline');
      this.scheduleBootstrap();
    });
    socket.addEventListener('error', () => {
      if (this.socket === socket) socket.close();
    });
  }

  private scheduleBootstrap(): void {
    if (this.stopped || this.bootstrapTimer !== null) return;
    const base = Math.min(30_000, BOOTSTRAP_RECONNECT_BASE_MS * 2 ** this.bootstrapAttempt);
    this.bootstrapAttempt += 1;
    this.bootstrapTimer = window.setTimeout(() => {
      this.bootstrapTimer = null;
      this.connectBootstrap();
    }, base + Math.floor(Math.random() * 500));
  }

  private startBootstrapOffer(socket: WebSocket): void {
    this.closeBootstrapPeer();
    this.bootstrapCandidates = [];
    this.bootstrapRemoteReady = false;
    if (!this.options.budget.tryAcquire('mesh:seed')) {
      this.setStatus(this.openPeers().length ? 'online' : 'offline');
      return;
    }
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.bootstrapPeer = pc;
    const channel = pc.createDataChannel('rdz', { ordered: true });
    this.attachSeedPeer(pc, channel);
    pc.addEventListener('icecandidate', (event) => {
      if (this.bootstrapPeer !== pc || !event.candidate || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({ type: 'bootstrap-ice', candidate: event.candidate.toJSON() }));
    });
    pc.addEventListener('connectionstatechange', () => {
      if (this.bootstrapPeer !== pc) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.closeBootstrapPeer();
        this.setStatus(
          this.openPeers().length
            ? 'online'
            : socket.readyState <= WebSocket.OPEN
              ? 'connecting'
              : 'offline',
        );
      }
    });
    void (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.bootstrapPeer !== pc || socket.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({
          type: 'bootstrap-offer',
          sdp: plainDescription(pc.localDescription),
        }),
      );
    })().catch(() => {
      if (this.bootstrapPeer === pc) this.closeBootstrapPeer();
    });
  }

  private handleBootstrapMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const record = message as { type?: unknown; sdp?: unknown; candidate?: unknown };
    if (record.type === 'bootstrap-answer' && isDescription(record.sdp)) {
      const pc = this.bootstrapPeer;
      if (!pc) return;
      void (async () => {
        await pc.setRemoteDescription(record.sdp as RTCSessionDescriptionInit);
        if (this.bootstrapPeer !== pc) return;
        this.bootstrapRemoteReady = true;
        for (const candidate of this.bootstrapCandidates) {
          await pc.addIceCandidate(candidate).catch(() => undefined);
        }
        this.bootstrapCandidates = [];
      })();
      return;
    }
    if (record.type === 'bootstrap-ice' && isCandidate(record.candidate)) {
      const pc = this.bootstrapPeer;
      if (!pc) return;
      if (!this.bootstrapRemoteReady) {
        this.bootstrapCandidates.push(record.candidate as RTCIceCandidateInit);
      } else {
        void pc.addIceCandidate(record.candidate as RTCIceCandidateInit).catch(() => undefined);
      }
    }
  }

  private attachSeedPeer(pc: RTCPeerConnection, channel: RTCDataChannel): void {
    const peer: MeshPeer = {
      key: 'seed',
      humanId: null,
      isSeed: true,
      outbound: true,
      attemptId: 'seed',
      pc,
      channel,
      state: 'connecting',
      remoteDescriptionSet: true,
      signalReady: true,
      seedReady: false,
      pendingIce: [],
      localCandidates: [],
      connectTimer: 0,
      openedAt: 0,
    };
    this.peers.set('seed', peer);
    this.wireChannel(peer, channel);
  }

  private closeBootstrapPeer(): void {
    const seed = this.peers.get('seed');
    if (seed) this.closePeer(seed, true);
    if (!this.bootstrapPeer) return;
    try {
      this.bootstrapPeer.close();
    } catch {
      // Ignore.
    }
    this.bootstrapPeer = null;
    this.bootstrapRemoteReady = false;
    this.bootstrapCandidates = [];
  }

  private async connectTo(humanId: HumanId): Promise<void> {
    if (this.peers.has(humanId)) return;
    if (!this.options.budget.tryAcquire(`mesh:${humanId}`)) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const attemptId = randomTransferId();
    const peer: MeshPeer = {
      key: humanId,
      humanId,
      isSeed: false,
      outbound: true,
      attemptId,
      pc,
      channel: null,
      state: 'connecting',
      remoteDescriptionSet: false,
      signalReady: false,
      seedReady: false,
      pendingIce: [],
      localCandidates: [],
      connectTimer: 0,
      openedAt: 0,
    };
    this.peers.set(humanId, peer);
    const channel = pc.createDataChannel('rdz', { ordered: true });
    this.wireChannel(peer, channel);
    this.wirePeerConnection(peer, humanId);
    peer.connectTimer = window.setTimeout(() => {
      if (peer.state === 'connecting') this.failPeer(peer);
    }, CONNECT_TIMEOUT_MS);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (peer.state === 'closed') return;
      this.sendMeshSignal(humanId, 'mesh-offer', attemptId, {
        sdp: plainDescription(pc.localDescription),
      });
      peer.signalReady = true;
      this.flushLocalCandidates(peer, humanId);
    } catch {
      this.failPeer(peer);
    }
  }

  private wirePeerConnection(peer: MeshPeer, target: HumanId): void {
    peer.pc.addEventListener('icecandidate', (event) => {
      if (!event.candidate || peer.state === 'closed') return;
      const candidate = event.candidate.toJSON();
      if (!peer.signalReady) {
        peer.localCandidates.push(candidate);
        return;
      }
      this.sendMeshSignal(target, 'mesh-ice', peer.attemptId, { candidate });
    });
    peer.pc.addEventListener('datachannel', (event) => {
      this.wireChannel(peer, event.channel);
    });
    peer.pc.addEventListener('connectionstatechange', () => {
      if (peer.pc.connectionState === 'failed' || peer.pc.connectionState === 'closed') {
        this.failPeer(peer);
      }
    });
  }

  private wireChannel(peer: MeshPeer, channel: RTCDataChannel): void {
    peer.channel = channel;
    channel.addEventListener('open', () => this.openPeer(peer));
    channel.addEventListener('close', () => this.failPeer(peer));
    channel.addEventListener('message', (event) => {
      void this.handlePeerMessage(peer, event.data);
    });
  }

  private openPeer(peer: MeshPeer): void {
    if (peer.state === 'closed') return;
    if (peer.isSeed && !peer.seedReady) return;
    const existing = this.peers.get(peer.key);
    if (existing && existing !== peer && existing.state === 'open') {
      this.closePeer(peer, true);
      return;
    }
    if (peer.connectTimer) window.clearTimeout(peer.connectTimer);
    peer.connectTimer = 0;
    peer.state = 'open';
    peer.openedAt = Date.now();
    this.peers.set(peer.key, peer);
    this.failedAt.delete(peer.key);
    this.setStatus('online');
    this.replayTo(peer);
    this.flushOutbox(peer);
  }

  private async handlePeerMessage(peer: MeshPeer, data: unknown): Promise<void> {
    if (typeof data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (isMeshControl(parsed)) {
      if (parsed.type === 'mesh-challenge' && peer.isSeed && typeof parsed.nonce === 'string') {
        void this.answerChallenge(peer, parsed.nonce);
      } else if (parsed.type === 'mesh-welcome' && peer.isSeed) {
        peer.seedReady = true;
        this.openPeer(peer);
      } else if (parsed.type === 'mesh-peers') {
        if (!Array.isArray(parsed.peers)) return;
        const peers = parsed.peers.filter(isPeerInfo);
        for (const peer of peers) this.registry.set(peer.humanId, peer);
        this.options.onPeers(peers);
      }
      return;
    }
    await this.handleEnvelope(parsed, peer);
  }

  private async answerChallenge(peer: MeshPeer, nonce: string): Promise<void> {
    const body = meshHelloBody(nonce);
    const signature = await signText(this.identity.privateKey, body);
    this.sendControl(peer, {
      type: 'mesh-hello',
      humanId: this.identity.humanId,
      publicKey: this.identity.publicKey,
      nonce,
      signature,
    });
  }

  private sendControl(peer: MeshPeer, value: unknown): void {
    const channel = peer.channel;
    if (!channel || channel.readyState !== 'open') return;
    try {
      channel.send(JSON.stringify(value));
    } catch {
      this.failPeer(peer);
    }
  }

  private async handleEnvelope(value: unknown, source: MeshPeer | null): Promise<void> {
    const transportKey = envelopeTransportKey(value);
    if (transportKey) {
      if (this.inFlight.has(transportKey)) return;
      this.inFlight.add(transportKey);
    }
    try {
      await this.processEnvelope(value, source);
    } finally {
      if (transportKey) this.inFlight.delete(transportKey);
    }
  }

  private async processEnvelope(value: unknown, source: MeshPeer | null): Promise<void> {
    const envelope = await verifyEnvelope(value);
    if (!envelope) return;
    if (!isNotFromFuture(envelope)) return;
    if (envelope.type === 'PING' && !isValidPing(envelope)) return;
    if (envelope.type === 'GOING' && !isValidGoing(envelope)) return;
    if (envelope.type === 'SIGNAL' && Date.now() - envelope.createdAt > SIGNAL_TTL_MS) return;

    const id = await envelopeId(envelope);
    const expiresAt = expiryFor(envelope);
    if (expiresAt <= Date.now()) return;
    const prior = this.seen.get(id);
    if (prior && prior > Date.now()) return;
    this.seen.set(id, expiresAt);

    const peer = this.peerLabel(source);
    const bytes = envelopeBytes(envelope);
    this.reportTraffic({
      direction: 'coming',
      envelope,
      peer,
      peerRole: peer ? 'from' : null,
      bytes,
    });

    if (envelope.type === 'PING' || envelope.type === 'GOING') {
      this.cache.set(id, { envelope, expiresAt });
      this.options.onEnvelope(envelope);
      this.reportRelay(envelope, peer, this.broadcast(envelope, source), bytes);
      return;
    }

    const payload = envelope.payload;
    if (payload.kind !== 'SIGNAL') return;
    if (isMeshSignal(payload.signal)) {
      if (payload.target !== this.identity.humanId) {
        this.reportRelay(envelope, peer, this.broadcast(envelope, source), bytes);
        return;
      }
      await this.handleMeshSignal(envelope, payload);
      return;
    }
    if (payload.target === this.identity.humanId) {
      this.options.onEnvelope(envelope);
      return;
    }
    this.reportRelay(envelope, peer, this.broadcast(envelope, source), bytes);
  }

  private async handleMeshSignal(envelope: Envelope, payload: SignalPayload): Promise<void> {
    const author = envelope.author;
    const data = payload.data as { sdp?: unknown; candidate?: unknown } | undefined;
    if (payload.signal === 'mesh-offer' && isDescription(data?.sdp)) {
      const existing = this.peers.get(author);
      if (existing?.state === 'open') return;
      if (existing?.state === 'connecting' && existing.outbound) {
        if (author > this.identity.humanId) return;
        this.closePeer(existing, true);
      } else if (existing?.state === 'connecting') {
        return;
      }
      if (!this.options.budget.tryAcquire(`mesh:${author}`)) return;
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const peer: MeshPeer = {
        key: author,
        humanId: author,
        isSeed: false,
        outbound: false,
        attemptId: payload.transferId,
        pc,
        channel: null,
        state: 'connecting',
        remoteDescriptionSet: false,
        signalReady: false,
        seedReady: false,
        pendingIce: [],
        localCandidates: [],
        connectTimer: 0,
        openedAt: 0,
      };
      this.peers.set(author, peer);
      this.wirePeerConnection(peer, author);
      peer.connectTimer = window.setTimeout(() => {
        if (peer.state === 'connecting') this.failPeer(peer);
      }, CONNECT_TIMEOUT_MS);
      try {
        await pc.setRemoteDescription(data.sdp as RTCSessionDescriptionInit);
        peer.remoteDescriptionSet = true;
        for (const candidate of peer.pendingIce) {
          await pc.addIceCandidate(candidate).catch(() => undefined);
        }
        peer.pendingIce = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (peer.state === 'closed') return;
        this.sendMeshSignal(author, 'mesh-answer', payload.transferId, {
          sdp: plainDescription(pc.localDescription),
        });
        peer.signalReady = true;
        this.flushLocalCandidates(peer, author);
      } catch {
        this.failPeer(peer);
      }
      return;
    }

    const peer = this.peers.get(author);
    if (!peer || peer.attemptId !== payload.transferId) return;

    if (payload.signal === 'mesh-answer' && isDescription(data?.sdp)) {
      try {
        await peer.pc.setRemoteDescription(data.sdp as RTCSessionDescriptionInit);
        peer.remoteDescriptionSet = true;
        for (const candidate of peer.pendingIce) {
          await peer.pc.addIceCandidate(candidate).catch(() => undefined);
        }
        peer.pendingIce = [];
      } catch {
        this.failPeer(peer);
      }
      return;
    }

    if (payload.signal === 'mesh-ice' && isCandidate(data?.candidate)) {
      const candidate = data.candidate as RTCIceCandidateInit;
      if (!peer.remoteDescriptionSet) {
        peer.pendingIce.push(candidate);
      } else {
        await peer.pc.addIceCandidate(candidate).catch(() => undefined);
      }
    }
  }

  private sendMeshSignal(
    target: HumanId,
    signal: SignalKind,
    transferId: string,
    data?: unknown,
  ): void {
    this.signalChain = this.signalChain
      .then(async () => {
        const envelope = await createEnvelope(this.identity, {
          kind: 'SIGNAL',
          target,
          channelId: '',
          signal,
          transferId,
          ...(data === undefined ? {} : { data }),
        });
        await this.publish(envelope);
      })
      .catch(() => undefined);
  }

  private flushLocalCandidates(peer: MeshPeer, target: HumanId): void {
    const candidates = peer.localCandidates;
    peer.localCandidates = [];
    for (const candidate of candidates) {
      this.sendMeshSignal(target, 'mesh-ice', peer.attemptId, { candidate });
    }
  }

  private replayTo(peer: MeshPeer): void {
    const now = Date.now();
    for (const { envelope, expiresAt } of this.cache.values()) {
      if (expiresAt <= now) continue;
      if (!this.sendTo(peer, envelope)) continue;
      this.reportTraffic({
        direction: 'relaying',
        envelope,
        peer: this.peerLabel(peer),
        peerRole: 'to',
        destinations: 1,
        replayed: true,
        bytes: envelopeBytes(envelope),
      });
    }
  }

  private flushOutbox(peer: MeshPeer): void {
    const now = Date.now();
    for (const envelope of this.outbox) {
      if (expiryFor(envelope) <= now) continue;
      if (envelope.type !== 'SIGNAL') continue;
      this.sendTo(peer, envelope);
    }
  }

  private broadcast(envelope: Envelope, except: MeshPeer | null): number {
    let destinations = 0;
    for (const peer of this.peers.values()) {
      if (peer === except || peer.state !== 'open') continue;
      if (this.sendTo(peer, envelope)) destinations += 1;
    }
    return destinations;
  }

  private sendTo(peer: MeshPeer, envelope: Envelope): boolean {
    const channel = peer.channel;
    if (!channel || channel.readyState !== 'open') return false;
    try {
      channel.send(JSON.stringify(envelope));
      return true;
    } catch {
      this.failPeer(peer);
      return false;
    }
  }

  private queueSignal(envelope: Envelope): void {
    this.outbox.push(envelope);
    if (this.outbox.length > MAX_OUTBOX) this.outbox.shift();
  }

  private openPeers(): MeshPeer[] {
    return [...this.peers.values()].filter((peer) => peer.state === 'open');
  }

  private failPeer(peer: MeshPeer): void {
    if (peer.state === 'closed') return;
    if (peer.humanId) this.failedAt.set(peer.humanId, Date.now());
    this.closePeer(peer, true, true);
  }

  private closePeer(peer: MeshPeer, releaseBudget: boolean, markFailure = true): void {
    if (peer.state !== 'closed') peer.state = 'closed';
    if (peer.connectTimer) window.clearTimeout(peer.connectTimer);
    peer.connectTimer = 0;
    try {
      peer.pc.close();
    } catch {
      // Ignore.
    }
    if (this.peers.get(peer.key) === peer) this.peers.delete(peer.key);
    if (releaseBudget) this.options.budget.release(`mesh:${peer.key}`);
    if (markFailure && !peer.isSeed && peer.humanId && peer.openedAt > 0) {
      this.failedAt.set(peer.humanId, Date.now());
    }
    const socketTrying =
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING;
    this.setStatus(
      this.openPeers().length ? 'online' : socketTrying ? 'connecting' : 'offline',
    );
  }

  private scheduleRotation(): void {
    if (this.stopped || this.rotationTimer !== null) return;
    const delay = 4.5 * 60_000 + Math.floor(Math.random() * 60_000);
    this.rotationTimer = window.setTimeout(() => {
      this.rotationTimer = null;
      this.rotate();
      this.scheduleRotation();
    }, delay);
  }

  private rotate(): void {
    if (this.stopped) return;
    const candidates = [...this.registry.keys()].filter(
      (humanId) =>
        humanId !== this.identity.humanId &&
        !this.peers.has(humanId) &&
        !this.recentlyFailed(humanId),
    );
    if (candidates.length === 0) return;
    if (this.options.budget.size < MAX_LIVE_PEER_CONNECTIONS) {
      for (const humanId of candidates) void this.connectTo(humanId);
      return;
    }
    const droppable = [...this.peers.values()].filter(
      (peer) =>
        !peer.isSeed &&
        peer.state === 'open' &&
        peer.humanId !== null &&
        !this.options.isVerified(peer.humanId) &&
        !this.options.isBusy(peer.humanId),
    );
    if (droppable.length === 0) return;
    shuffle(droppable);
    shuffle(candidates);
    const count = Math.max(1, Math.floor(droppable.length * 0.2));
    for (const peer of droppable.slice(0, count)) this.closePeer(peer, true, false);
    for (const humanId of candidates.slice(0, count)) void this.connectTo(humanId);
  }

  private recentlyFailed(humanId: HumanId): boolean {
    const failed = this.failedAt.get(humanId);
    return Boolean(failed && Date.now() - failed < RETRY_AFTER_MS);
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(id);
    }
    for (const [id, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(id);
    }
    for (let index = this.outbox.length - 1; index >= 0; index -= 1) {
      if (expiryFor(this.outbox[index]!) <= now) this.outbox.splice(index, 1);
    }
    for (const [humanId, at] of this.failedAt) {
      if (now - at > RETRY_AFTER_MS) this.failedAt.delete(humanId);
    }
  }

  private peerLabel(peer: MeshPeer | null): TrafficPeer {
    if (!peer) return null;
    return peer.isSeed ? 'seed' : peer.humanId;
  }

  private reportTraffic(report: TrafficReport): void {
    try {
      this.options.onTraffic(report);
    } catch {
      // Observability must never break transport.
    }
  }

  private reportRelay(
    envelope: Envelope,
    peer: TrafficPeer,
    destinations: number,
    bytes = envelopeBytes(envelope),
  ): void {
    if (destinations <= 0 || envelope.author === this.identity.humanId) return;
    this.reportTraffic({
      direction: 'relaying',
      envelope,
      peer,
      peerRole: peer ? 'from' : null,
      destinations,
      bytes,
    });
  }

  private setStatus(status: MeshStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus(status);
  }

  private publishStatus(): void {
    this.options.onStatus(this.status);
  }
}

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
const TEXT_ENCODER = new TextEncoder();

function envelopeBytes(envelope: Envelope): number {
  try {
    return TEXT_ENCODER.encode(JSON.stringify(envelope)).length;
  } catch {
    return 0;
  }
}

export function bootstrapUrlFrom(
  protocol: string,
  host: string,
  search: string,
  configured?: string,
): string {
  const params = new URLSearchParams(search);
  const override = params.get('seed');
  if (override === 'off') return '';
  if (override) return override;
  if (configured?.trim()) return configured.trim();
  const socketProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${socketProtocol}//${host}/signal`;
}

export function resolveBootstrapUrl(): string {
  return bootstrapUrlFrom(
    window.location.protocol,
    window.location.host,
    window.location.search,
    import.meta.env.VITE_SEED_URL as string | undefined,
  );
}

function expiryFor(envelope: Envelope): number {
  if (envelope.type === 'PING') return envelope.createdAt + 5 * 60_000;
  if (envelope.type === 'GOING' && envelope.payload.kind === 'GOING') {
    return envelope.payload.scheduledAt + 3 * 60_000;
  }
  return envelope.createdAt + SIGNAL_TTL_MS;
}

function isMeshSignal(signal: SignalKind): boolean {
  return signal === 'mesh-offer' || signal === 'mesh-answer' || signal === 'mesh-ice';
}

function isMeshControl(
  value: unknown,
): value is { type: string; peers?: unknown; nonce?: unknown } {
  if (!value || typeof value !== 'object') return false;
  const record = value as { type?: unknown };
  return typeof record.type === 'string' && record.type.startsWith('mesh-');
}

function isPeerInfo(value: unknown): value is MeshPeerInfo {
  if (!value || typeof value !== 'object') return false;
  const record = value as { humanId?: unknown; publicKey?: unknown };
  return typeof record.humanId === 'string' && typeof record.publicKey === 'string';
}

function isDescription(value: unknown): value is RTCSessionDescriptionInit {
  if (!value || typeof value !== 'object') return false;
  const record = value as { type?: unknown; sdp?: unknown };
  return typeof record.sdp === 'string' && (record.type === 'offer' || record.type === 'answer');
}

function isCandidate(value: unknown): value is RTCIceCandidateInit {
  return Boolean(value) && typeof value === 'object';
}

function shuffle<T>(values: T[]): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    const current = values[index]!;
    values[index] = values[swap]!;
    values[swap] = current;
  }
}

function plainDescription(
  description: RTCSessionDescription | null,
): { type: RTCSdpType; sdp: string } | null {
  if (!description) return null;
  return { type: description.type, sdp: description.sdp };
}
