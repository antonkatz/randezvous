import {
  derivePeerId,
  deriveVerificationWords,
  displayName,
  generateIdentityMaterial,
  hashToken,
  isPeerId,
  isRawPublicKey,
  normalizeName,
  randomToken,
  signalAuthTranscript,
  signText,
  base64UrlToBytes,
} from './crypto';
import { handoffPhase, isHandoffEligible } from './handoff';
import {
  buildInviteUrl,
  clearInviteFromUrl,
  createInviteToken,
  createJoinRequest,
  getInviteTokenFromUrl,
  verifyInviteToken,
  verifyJoinRequest,
} from './invite';
import type {
  JoinRequest,
  PresenceEntry,
  RendezvousNotice,
  RendezvousWire,
  RtcSignalPayload,
  ServerSignalMessage,
  SignalHelloOk,
} from './protocol';
import {
  MAX_PHOTO_BYTES,
  ReceiverTransfer,
  SenderTransfer,
  type PhotoMeta,
} from './rtc';
import { WebSocketSignalTransport } from './signal';
import { RendezvousStore, type PendingRemoval } from './store';
import type {
  ClientNotice,
  Human,
  PublicIdentity,
  RendezvousClientEvents,
  RendezvousClientOptions,
  RendezvousSnapshot,
  RendezvousStatus,
  ScheduleInput,
  SignalNetworkInfo,
  SignalStatus,
  StoredHuman,
  StoredIdentity,
  StoredRendezvous,
  TransferDiagnostics,
  TransferEvent,
} from './types';

const RETRY_DELAY_MS = 20_000;
const ANNOUNCE_RETRY_MS = 5_000;
const SIGNAL_AUTH_DOMAIN = 'rendezvous/signal-auth/v1';

type Listener<T> = (value: T) => void;

export class RendezvousClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RendezvousClientError';
    this.code = code;
  }
}

interface ActiveTransfer {
  direction: 'outgoing' | 'incoming';
  peerId: string;
  transfer: SenderTransfer | ReceiverTransfer;
}

function cloneRecord(record: StoredRendezvous): StoredRendezvous {
  return { ...record };
}

function isDelivered(record: StoredRendezvous): boolean {
  return record.status === 'delivered';
}

function sortRendezvous(records: Iterable<StoredRendezvous>): StoredRendezvous[] {
  return [...records].sort((a, b) => a.scheduledFor - b.scheduledFor);
}

function makeStoredHuman(human: Human): StoredHuman {
  return {
    id: human.id,
    name: human.name,
    publicKey: human.publicKey,
    addedAt: human.addedAt,
    verifiedAt: human.verifiedAt,
    inviteHashes: [...human.inviteHashes],
  };
}

export class RendezvousClient {
  private readonly options: RendezvousClientOptions;
  private readonly store: RendezvousStore;
  private identity: StoredIdentity | null = null;
  private humans = new Map<string, Human>();
  private rendezvous = new Map<string, StoredRendezvous>();
  private activeTransfers = new Map<string, ActiveTransfer>();
  private transport: WebSocketSignalTransport | null = null;
  private signalStatus: SignalStatus = 'starting';
  private network: SignalNetworkInfo | null = null;
  private lastTransferDiagnostics: TransferDiagnostics | null = null;
  private iceServers: RTCIceServer[] = [];
  private ready = false;
  private stopped = false;
  private ticker: number | null = null;
  private messageChain: Promise<void> = Promise.resolve();
  private processingDue = false;
  private openNotified = new Set<string>();
  private dueNotified = new Set<string>();
  private lateNotified = new Set<string>();
  private revokedInvites = new Set<string>();
  private announcedThisSession = new Set<string>();
  private announceInFlight = new Set<string>();
  private announceRetryAt = new Map<string, number>();
  private joinsInFlight = new Set<string>();
  private joinRetryNotified = new Set<string>();
  private removalsInFlight = new Set<string>();
  private lastSignalStatusWasOnline = false;
  private readonly listeners = new Map<
    keyof RendezvousClientEvents,
    Set<Listener<RendezvousClientEvents[keyof RendezvousClientEvents]>>
  >();
  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      this.transport?.wake();
      this.emitState();
      void this.processDue();
    }
  };
  private readonly onBrowserOnline = (): void => {
    this.transport?.wake();
  };
  private readonly onHashChange = (): void => {
    void this.processInviteFromLocation();
  };

  constructor(options: RendezvousClientOptions = {}) {
    this.options = options;
    this.store = new RendezvousStore(options.storageName ?? 'rendezvous');
  }

  on<K extends keyof RendezvousClientEvents>(
    event: K,
    listener: Listener<RendezvousClientEvents[K]>,
  ): () => void {
    const set =
      this.listeners.get(event) ??
      new Set<Listener<RendezvousClientEvents[keyof RendezvousClientEvents]>>();
    set.add(
      listener as Listener<RendezvousClientEvents[keyof RendezvousClientEvents]>,
    );
    this.listeners.set(event, set);
    return () => {
      set.delete(
        listener as Listener<RendezvousClientEvents[keyof RendezvousClientEvents]>,
      );
    };
  }

  private emit<K extends keyof RendezvousClientEvents>(
    event: K,
    value: RendezvousClientEvents[K],
  ): void {
    const listeners = this.listeners.get(event);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        console.error('[rendezvous] listener failed', error);
      }
    }
  }

  private notice(notice: ClientNotice): void {
    this.emit('notice', notice);
  }

  getSnapshot(): RendezvousSnapshot {
    const identity = this.identity;
    return {
      ready: this.ready,
      signal: this.signalStatus,
      network: this.network,
      lastTransferDiagnostics: this.lastTransferDiagnostics,
      identity: identity
        ? { id: identity.id, name: identity.name, publicKey: identity.publicKey }
        : { id: '', name: '', publicKey: '' },
      humans: [...this.humans.values()].sort((a, b) => a.addedAt - b.addedAt),
      rendezvous: sortRendezvous(this.rendezvous.values()).map(cloneRecord),
    };
  }

  /** Send an opaque signed circle message to one direct human. */
  sendCircleMessage(peerId: string, message: unknown): boolean {
    if (!this.identity || !this.humans.has(peerId)) return false;
    return (
      this.transport?.send({
        type: 'circle:relay',
        to: peerId,
        message,
      }) ?? false
    );
  }

  /** Listen for circle messages from direct humans. */
  onCircleMessage(
    listener: (fromId: string, message: unknown) => void,
  ): () => void {
    return this.on('circle', (event) => listener(event.fromId, event.message));
  }

  private emitState(): void {
    if (!this.ready) return;
    this.emit('state', this.getSnapshot());
  }

  private requireIdentity(): StoredIdentity {
    if (!this.identity) {
      throw new RendezvousClientError('not-ready', 'Rendezvous is not ready yet.');
    }
    return this.identity;
  }

  async start(): Promise<void> {
    if (this.ready || this.stopped) return;
    await this.loadIdentity();
    await this.loadHumans();
    await this.loadRendezvous();
    this.revokedInvites = new Set(await this.store.getRevokedInvites());
    await this.processInviteFromLocation();

    this.iceServers = this.options.iceServers ?? [
      { urls: 'stun:stun.l.google.com:19302' },
    ];
    this.transport = new WebSocketSignalTransport({
      url: this.options.signalUrl,
      getPeer: () => {
        const identity = this.requireIdentity();
        return { id: identity.id, name: identity.name, publicKey: identity.publicKey };
      },
      signNonce: async (nonce) => {
        const identity = this.requireIdentity();
        return signText(
          identity.privateKey,
          SIGNAL_AUTH_DOMAIN,
          signalAuthTranscript(nonce),
        );
      },
      getSubscriptions: () => [...this.humans.keys()],
      onMessage: (message) => {
        this.messageChain = this.messageChain
          .then(() => this.handleServerMessage(message))
          .catch((error: unknown) => {
            console.error('[rendezvous] signal message failed', error);
            this.notice({
              tone: 'error',
              code: 'server-error',
              message: 'A message from the signalling server could not be processed.',
            });
          });
      },
      onStatus: (status) => this.handleSignalStatus(status),
      onHelloOk: (message) => this.handleHelloOk(message),
    });

    this.ready = true;
    this.ticker = window.setInterval(() => {
      void this.processDue();
    }, 1_000);
    window.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('online', this.onBrowserOnline);
    window.addEventListener('hashchange', this.onHashChange);
    this.transport.start();
    this.emitState();
    void this.flushPending();
    void this.processDue();
  }

  stop(): void {
    this.stopped = true;
    if (this.ticker !== null) {
      window.clearInterval(this.ticker);
      this.ticker = null;
    }
    window.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('online', this.onBrowserOnline);
    window.removeEventListener('hashchange', this.onHashChange);
    for (const active of this.activeTransfers.values()) active.transfer.close();
    this.activeTransfers.clear();
    this.transport?.stop();
    this.transport = null;
  }

  private async loadIdentity(): Promise<void> {
    let identity = await this.store.getIdentity();
    if (!identity) {
      const material = await generateIdentityMaterial();
      identity = {
        key: 'self',
        id: material.peerId,
        name: '',
        publicKey: material.publicKey,
        privateKey: material.privateKey,
        createdAt: Date.now(),
      };
      await this.store.putIdentity(identity);
    }
    if (
      !identity.id ||
      !isPeerId(identity.id) ||
      !isRawPublicKey(identity.publicKey) ||
      !identity.privateKey
    ) {
      throw new RendezvousClientError(
        'storage-error',
        'The stored Rendezvous identity is incomplete. Clear this site’s data to create a new one.',
      );
    }
    const expectedId = await derivePeerId(base64UrlToBytes(identity.publicKey));
    if (expectedId !== identity.id) {
      throw new RendezvousClientError(
        'storage-error',
        'The stored Rendezvous identity does not match its public key. Clear this site’s data to create a new one.',
      );
    }
    identity.name = normalizeName(identity.name ?? '');
    this.identity = identity;
  }

  private async loadHumans(): Promise<void> {
    const stored = await this.store.getHumans();
    this.humans = new Map(
      stored.map((human) => [
        human.id,
        {
          ...human,
          name: normalizeName(human.name),
          verifiedAt: human.verifiedAt ?? null,
          online: false,
          lastSeenAt: null,
        },
      ]),
    );
  }

  private async loadRendezvous(): Promise<void> {
    const stored = await this.store.listRendezvous();
    const now = Date.now();
    for (const record of stored) {
      if (record.status === 'connecting' || record.status === 'transferring') {
        record.status = isHandoffEligible(record.scheduledFor, now) ? 'waiting' : 'scheduled';
        record.error = null;
        await this.store.putRendezvous(record);
      }
      this.rendezvous.set(record.id, record);
    }
  }

  private async processInviteFromLocation(): Promise<void> {
    const token = getInviteTokenFromUrl();
    if (!token) return;
    clearInviteFromUrl();
    try {
      const invite = await verifyInviteToken(token);
      if (!this.identity) return;
      if (invite.id === this.identity.id) {
        this.notice({
          tone: 'info',
          code: 'own-invite',
          message: 'That is your own invitation link.',
        });
        return;
      }
      const inviteHash = await hashToken(token);
      if (this.revokedInvites.has(inviteHash)) {
        this.notice({
          tone: 'warning',
          code: 'invite-revoked',
          message: 'That invitation has been revoked. Ask for a fresh link.',
          humanId: invite.id,
        });
        return;
      }
      const human = await this.addHuman(
        {
          id: invite.id,
          name: invite.name,
          publicKey: invite.publicKey,
        },
        inviteHash,
      );
      if (!human) return;
      const join = await createJoinRequest({
        identity: this.identity,
        inviterId: invite.id,
        token,
      });
      await this.store.addPendingJoin(join);
      this.notice({
        tone: 'success',
        code: 'human-added',
        message: `The link is saved. You and ${displayName(human.name)} will find each other whenever you’re both here.`,
        humanId: human.id,
      });
      void this.flushPending();
    } catch (error) {
      this.notice({
        tone: 'error',
        code: 'invalid-invite',
        message:
          error instanceof Error && error.message
            ? 'That invitation link is not valid.'
            : 'That invitation link is not valid.',
      });
    }
  }

  private handleSignalStatus(status: SignalStatus): void {
    const wasOnline = this.lastSignalStatusWasOnline;
    this.signalStatus = status;
    this.lastSignalStatusWasOnline = status === 'online';

    if (status !== 'online') {
      this.joinsInFlight.clear();
      this.removalsInFlight.clear();
      this.announceInFlight.clear();
      let changed = false;
      for (const human of this.humans.values()) {
        if (human.online) {
          human.online = false;
          human.lastSeenAt = Date.now();
          changed = true;
        }
      }
      if (changed) this.emitHumans();
    }

    if (status === 'online' && !wasOnline) {
      void this.flushPending();
      void this.processDue();
    }
    if (status === 'replaced') {
      this.notice({
        tone: 'warning',
        code: 'signal-replaced',
        message: 'Rendezvous is open in another window for this browser identity.',
      });
    }
    this.emitState();
  }

  private handleHelloOk(message: SignalHelloOk): void {
    this.network = message.network;
    if (!this.options.iceServers && Array.isArray(message.iceServers)) {
      this.iceServers = message.iceServers;
    }
    this.emitState();
    void this.flushPending();
    void this.processDue();
  }

  private async flushPending(): Promise<void> {
    const transport = this.transport;
    if (!transport?.isOnline) return;
    const joins = await this.store.getPendingJoins();
    for (const join of joins) {
      if (this.joinsInFlight.has(join.id)) continue;
      if (transport.send({ type: 'invite:join', join })) {
        this.joinsInFlight.add(join.id);
      }
    }
    const removals = await this.store.getPendingRemovals();
    for (const removal of removals) {
      if (this.removalsInFlight.has(removal.id)) continue;
      if (
        transport.send({
          type: 'contact:remove',
          removalId: removal.id,
          to: removal.to,
          revokedInvites: removal.revokedInvites,
        })
      ) {
        this.removalsInFlight.add(removal.id);
      }
    }
    for (const record of this.rendezvous.values()) {
      if (
        record.direction === 'outgoing' &&
        !record.deliveredAt &&
        !record.announcedAt &&
        !this.announceInFlight.has(record.id) &&
        (this.announceRetryAt.get(record.id) ?? 0) <= Date.now()
      ) {
        this.announce(record);
      }
    }
  }

  private announce(record: StoredRendezvous): void {
    const transport = this.transport;
    if (!transport?.isOnline) return;
    const wire: RendezvousWire = {
      id: record.id,
      fromId: this.requireIdentity().id,
      fromName: this.requireIdentity().name,
      toId: record.peerId,
      scheduledFor: record.scheduledFor,
      createdAt: record.createdAt,
    };
    const sent = transport.send({ type: 'rendezvous:create', rendezvous: wire });
    if (sent) {
      this.announceInFlight.add(record.id);
      window.setTimeout(() => {
        this.announceInFlight.delete(record.id);
        this.announceRetryAt.set(record.id, Date.now() + ANNOUNCE_RETRY_MS);
      }, ANNOUNCE_RETRY_MS);
    }
  }

  private async handleServerMessage(message: ServerSignalMessage): Promise<void> {
    switch (message.type) {
      case 'hello:ok':
        return;
      case 'presence':
        await this.applyPresence(message.peers);
        return;
      case 'invite:queued':
        // Keep both the pending join and the in-flight marker until the
        // inviter acknowledges it. The marker clears on disconnect, so the
        // next connection re-sends; the local join clears on accepted/rejected.
        return;
      case 'invite:accepted': {
        this.joinsInFlight.delete(message.joinId);
        await this.store.removePendingJoin(message.joinId);
        const human = this.humans.get(message.humanId);
        this.notice({
          tone: 'success',
          code: 'invite-accepted',
          message: `${displayName(human?.name ?? '')} accepted your invitation.`,
          humanId: message.humanId,
        });
        return;
      }
      case 'invite:request':
        await this.handleIncomingJoin(message.join);
        return;
      case 'invite:rejected':
        await this.handleInviteRejected(message.joinId, message.inviterId);
        return;
      case 'contact:remove:queued':
        this.removalsInFlight.delete(message.removalId);
        await this.store.removePendingRemoval(message.removalId);
        return;
      case 'contact:removed':
        await this.handleRemoteRemoval(message.removalId, message.fromId, message.fromName);
        return;
      case 'rendezvous:created':
        await this.handleRendezvousCreated(message.id);
        return;
      case 'rendezvous:notice':
        await this.handleRendezvousNotice(message.rendezvous);
        return;
      case 'circle:relay':
        if (!this.humans.has(message.fromId)) return;
        this.emit('circle', { fromId: message.fromId, message: message.message });
        return;
      case 'rtc':
        await this.handleRtcSignal(message.fromId, message.transferId, message.payload);
        return;
      case 'error':
        if (message.code !== 'session-replaced') {
          this.notice({
            tone: message.fatal ? 'error' : 'warning',
            code: 'server-error',
            message: message.message,
          });
        }
        return;
      default:
        return;
    }
  }

  private async applyPresence(peers: PresenceEntry[]): Promise<void> {
    let humanChanged = false;
    let recordsChanged = false;
    for (const peer of peers) {
      const human = this.humans.get(peer.id);
      if (!human) continue;
      const nextName = normalizeName(peer.name);
      const wasOnline = human.online;
      human.online = Boolean(peer.online);
      if (!peer.online && wasOnline) human.lastSeenAt = Date.now();
      if (nextName && nextName !== human.name) {
        human.name = nextName;
        await this.store.putHuman(makeStoredHuman(human));
        humanChanged = true;
        for (const record of this.rendezvous.values()) {
          if (record.peerId === human.id && record.peerName !== nextName) {
            record.peerName = nextName;
            recordsChanged = true;
          }
        }
      }
      if (wasOnline !== human.online) humanChanged = true;
    }
    if (humanChanged) this.emitHumans();
    if (recordsChanged) {
      for (const record of this.rendezvous.values()) {
        if (this.humans.get(record.peerId)?.name) {
          await this.store.putRendezvous(record);
        }
      }
      this.emitState();
    }
    void this.processDue();
  }

  private emitHumans(): void {
    this.emit('state', this.getSnapshot());
  }

  private async handleIncomingJoin(join: JoinRequest): Promise<void> {
    const identity = this.requireIdentity();
    const inviteHash = await hashToken(join.token);
    if (this.revokedInvites.has(inviteHash)) {
      this.transport?.send({
        type: 'invite:reject',
        joinId: join.id,
        to: join.from.id,
        revokedInvites: [inviteHash],
      });
      await this.store.addRevokedInvites([inviteHash]);
      return;
    }
    let verified: Awaited<ReturnType<typeof verifyJoinRequest>>;
    try {
      verified = await verifyJoinRequest(join, {
        id: identity.id,
        name: identity.name,
        publicKey: identity.publicKey,
      });
    } catch {
      this.notice({
        tone: 'warning',
        code: 'invalid-invite',
        message: 'A connection request used an invitation that could not be verified.',
      });
      // A valid-but-unverifiable request can never succeed, so acknowledge it
      // rather than letting the server retry forever.
      this.transport?.send({ type: 'invite:ack', joinId: join.id });
      return;
    }

    const existing = this.humans.get(verified.sender.id);
    if (existing && existing.publicKey !== verified.sender.publicKey) {
      this.notice({
        tone: 'error',
        code: 'key-mismatch',
        message: `A browser claimed to be ${displayName(existing.name)} with a different key. The connection was refused.`,
        humanId: existing.id,
      });
      this.transport?.send({ type: 'invite:ack', joinId: join.id });
      return;
    }

    try {
      const human = await this.addHuman(verified.sender, inviteHash);
      this.joinRetryNotified.delete(join.id);
      if (human && !existing) {
        this.notice({
          tone: 'success',
          code: 'human-joined',
          message: `${displayName(human.name)} is now one of your humans. Compare your verification words.`,
          humanId: human.id,
        });
      }
    } catch (error) {
      // Do not acknowledge: the server keeps retrying until the human is
      // actually written. Mobile browsers can fail transiently when storage
      // is busy or the page is resuming.
      console.warn('[rendezvous] connection request could not be saved; retrying', error);
      if (!this.joinRetryNotified.has(join.id)) {
        this.joinRetryNotified.add(join.id);
        this.notice({
          tone: 'warning',
          code: 'join-retry',
          message: 'A connection request arrived but could not be saved yet. Rendezvous will retry.',
          humanId: verified.sender.id,
        });
      }
      return;
    }
    this.transport?.send({ type: 'invite:ack', joinId: join.id });
  }

  private async handleInviteRejected(joinId: string, inviterId: string): Promise<void> {
    await this.store.removePendingJoin(joinId);
    this.joinsInFlight.delete(joinId);
    this.joinRetryNotified.delete(joinId);
    if (this.humans.has(inviterId)) {
      await this.removeHumanInternal(inviterId, false);
    }
    this.notice({
      tone: 'warning',
      code: 'invite-revoked',
      message: 'That invitation has been revoked. Ask for a fresh link.',
      humanId: inviterId,
    });
  }

  private async handleRemoteRemoval(
    removalId: string,
    fromId: string,
    fromName?: string,
  ): Promise<void> {
    const human = this.humans.get(fromId);
    if (human) {
      if (human.inviteHashes.length > 0) {
        for (const hash of human.inviteHashes) this.revokedInvites.add(hash);
        await this.store.addRevokedInvites(human.inviteHashes);
      }
      await this.removeHumanInternal(fromId, false);
      this.notice({
        tone: 'info',
        code: 'human-removed-remotely',
        message: `${displayName(fromName || human.name)} removed your connection.`,
        humanId: fromId,
      });
    }
    this.transport?.send({ type: 'contact:remove:ack', removalId });
  }

  private async handleRendezvousCreated(id: string): Promise<void> {
    const record = this.rendezvous.get(id);
    if (!record || record.direction !== 'outgoing' || record.announcedAt) return;
    record.announcedAt = Date.now();
    this.announceInFlight.delete(id);
    this.announceRetryAt.delete(id);
    await this.store.putRendezvous(record);
    this.emitState();
  }

  private async handleRendezvousNotice(notice: RendezvousNotice): Promise<void> {
    const identity = this.requireIdentity();
    if (notice.fromId === identity.id) return;
    const human = this.humans.get(notice.fromId);
    if (!human) {
      this.transport?.send({ type: 'rendezvous:ack', id: notice.id });
      return;
    }

    let record = this.rendezvous.get(notice.id);
    let isNew = false;
    if (!record) {
      isNew = true;
      record = {
        id: notice.id,
        direction: 'incoming',
        peerId: notice.fromId,
        peerName: human.name || notice.fromName,
        createdAt: notice.createdAt,
        scheduledFor: notice.scheduledFor,
        status: isHandoffEligible(notice.scheduledFor) ? 'waiting' : 'scheduled',
        photo: null,
        announcedAt: null,
        lastAttemptAt: null,
        deliveredAt: null,
        error: null,
      };
      this.rendezvous.set(record.id, record);
    } else {
      record.scheduledFor = notice.scheduledFor;
      record.peerName = human.name || notice.fromName;
    }

    await this.store.putRendezvous(record);
    this.transport?.send({ type: 'rendezvous:ack', id: record.id });
    this.emitState();

    if (!record.deliveredAt) {
      if (isHandoffEligible(record.scheduledFor)) {
        this.notifyOpen(record);
        if (record.scheduledFor <= Date.now()) this.notifyDue(record);
      } else if (isNew && !this.announcedThisSession.has(record.id)) {
        this.announcedThisSession.add(record.id);
        this.emit('appointment', { rendezvous: cloneRecord(record), phase: 'announced' });
      }
    }
    void this.processDue();
  }

  private async handleRtcSignal(
    fromId: string,
    transferId: string,
    payload: RtcSignalPayload,
  ): Promise<void> {
    const human = this.humans.get(fromId);
    if (!human) return;
    const identity = this.requireIdentity();

    if (payload.kind === 'offer') {
      const existingActive = this.activeTransfers.get(transferId);
      if (existingActive) {
        existingActive.transfer.close();
        this.activeTransfers.delete(transferId);
      }
      let record = this.rendezvous.get(transferId);
      if (!record) {
        record = {
          id: transferId,
          direction: 'incoming',
          peerId: fromId,
          peerName: human.name,
          createdAt: Date.now(),
          scheduledFor: Date.now(),
          status: 'waiting',
          photo: null,
          announcedAt: null,
          lastAttemptAt: null,
          deliveredAt: null,
          error: null,
        };
        this.rendezvous.set(record.id, record);
        await this.store.putRendezvous(record);
        this.emitState();
      }
      if (record.direction !== 'incoming') return;

      record.status = 'connecting';
      record.error = null;
      await this.store.putRendezvous(record);
      this.emitState();

      const transfer = new ReceiverTransfer({
        transferId,
        localPeerId: identity.id,
        remotePeerId: fromId,
        localPrivateKey: identity.privateKey,
        remotePublicKey: human.publicKey,
        iceServers: this.iceServers,
        offerSdp: payload.sdp,
        callbacks: this.transferCallbacks(record),
        sendSignal: (next) => this.sendRtc(fromId, transferId, next),
      });
      this.activeTransfers.set(transferId, { direction: 'incoming', peerId: fromId, transfer });
      await transfer.start();
      return;
    }

    const active = this.activeTransfers.get(transferId);
    if (!active) return;
    await active.transfer.handleSignal(payload);
  }

  private sendRtc(to: string, transferId: string, payload: RtcSignalPayload): void {
    this.transport?.send({ type: 'rtc', to, transferId, payload });
  }

  private transferCallbacks(record: StoredRendezvous) {
    return {
      onPhase: (
        phase: 'connecting' | 'progress' | 'complete' | 'error',
        transferred: number,
        total: number,
      ) => {
        if (phase === 'progress' && record.status !== 'transferring') {
          record.status = 'transferring';
          void this.store.putRendezvous(record);
          this.emitState();
        }
        this.emit('transfer', {
          rendezvousId: record.id,
          peerId: record.peerId,
          direction: record.direction,
          phase,
          transferred,
          total,
        } satisfies TransferEvent);
      },
      onError: (message: string) => {
        const active = this.activeTransfers.get(record.id);
        active?.transfer.close();
        this.activeTransfers.delete(record.id);
        if (isDelivered(record)) return;
        record.status = 'failed';
        record.error = message;
        record.lastAttemptAt = Date.now();
        void this.store.putRendezvous(record);
        this.emitState();
        this.notice({
          tone: 'error',
          code: /identity|authenticate|decrypt/u.test(message)
            ? 'handshake-failed'
            : 'transfer-failed',
          message,
          humanId: record.peerId,
          rendezvousId: record.id,
        });
        this.emit('transfer', {
          rendezvousId: record.id,
          peerId: record.peerId,
          direction: record.direction,
          phase: 'error',
          transferred: 0,
          total: record.photo?.size ?? 0,
          message,
        } satisfies TransferEvent);
        void this.processDue();
      },
      onSenderComplete: () => {
        this.activeTransfers.delete(record.id);
        record.status = 'delivered';
        record.deliveredAt = Date.now();
        record.error = null;
        void this.store.putRendezvous(record);
        this.emitState();
        this.notice({
          tone: 'success',
          code: 'transfer-delivered',
          message: `${displayName(record.peerName)} received your photograph.`,
          humanId: record.peerId,
          rendezvousId: record.id,
        });
      },
      onReceiverComplete: (blob: Blob, meta: PhotoMeta) => {
        this.activeTransfers.delete(record.id);
        record.status = 'delivered';
        record.deliveredAt = Date.now();
        record.error = null;
        record.photo = {
          blob,
          name: meta.name,
          type: meta.type,
          size: meta.size,
        };
        void this.store.putRendezvous(record);
        this.emitState();
        this.emit('appointment', {
          rendezvous: cloneRecord(record),
          phase: 'received',
        });
      },
      onDiagnostics: (diagnostics: TransferDiagnostics) => {
        this.lastTransferDiagnostics = diagnostics;
        this.emitState();
      },
    };
  }

  private async processDue(): Promise<void> {
    if (!this.ready || this.processingDue || this.stopped) return;
    this.processingDue = true;
    const now = Date.now();
    let changed = false;
    try {
      for (const record of sortRendezvous(this.rendezvous.values())) {
        if (isDelivered(record)) continue;
        const phase = handoffPhase(record.scheduledFor, now);
        const eligible = phase !== 'scheduled';
        const human = this.humans.get(record.peerId);
        const bothOnline =
          this.signalStatus === 'online' &&
          Boolean(human?.online) &&
          !this.activeTransfers.has(record.id);

        if (eligible) {
          if (this.notifyOpen(record)) changed = true;
          if (phase !== 'open-early' && this.notifyDue(record)) changed = true;
        }
        if (phase === 'still-open' && !this.lateNotified.has(record.id)) {
          this.lateNotified.add(record.id);
          changed = true;
        }

        if (record.direction === 'incoming') {
          const nextStatus: RendezvousStatus = eligible ? 'waiting' : 'scheduled';
          if (record.status === 'scheduled' || record.status === 'waiting') {
            if (record.status !== nextStatus && !this.activeTransfers.has(record.id)) {
              record.status = nextStatus;
              await this.store.putRendezvous(record);
              changed = true;
            }
          }
          continue;
        }

        if (!eligible) {
          if (record.status !== 'scheduled') {
            record.status = 'scheduled';
            await this.store.putRendezvous(record);
            changed = true;
          }
          continue;
        }

        if (!record.announcedAt) {
          this.announce(record);
        }

        if (!bothOnline) {
          if (record.status !== 'waiting' && record.status !== 'connecting') {
            record.status = 'waiting';
            record.lastAttemptAt = record.lastAttemptAt ?? null;
            await this.store.putRendezvous(record);
            changed = true;
          }
          continue;
        }

        if (!record.announcedAt) continue;
        if (this.activeTransfers.has(record.id)) continue;
        if (record.lastAttemptAt && now - record.lastAttemptAt < RETRY_DELAY_MS) continue;
        if (record.status === 'connecting' || record.status === 'transferring') continue;

        await this.startSender(record);
      }
    } finally {
      this.processingDue = false;
      if (changed) this.emitState();
    }
  }

  private async startSender(record: StoredRendezvous): Promise<void> {
    const human = this.humans.get(record.peerId);
    const identity = this.identity;
    if (!human || !identity || !record.photo) return;

    record.lastAttemptAt = Date.now();
    record.status = 'connecting';
    record.error = null;
    await this.store.putRendezvous(record);
    this.emitState();

    const transfer = new SenderTransfer({
      transferId: record.id,
      localPeerId: identity.id,
      remotePeerId: record.peerId,
      localPrivateKey: identity.privateKey,
      remotePublicKey: human.publicKey,
      iceServers: this.iceServers,
      photo: record.photo.blob,
      meta: {
        name: record.photo.name,
        type: record.photo.type,
        size: record.photo.size,
      },
      callbacks: this.transferCallbacks(record),
      sendSignal: (payload) => this.sendRtc(record.peerId, record.id, payload),
    });
    this.activeTransfers.set(record.id, {
      direction: 'outgoing',
      peerId: record.peerId,
      transfer,
    });
    this.emit('transfer', {
      rendezvousId: record.id,
      peerId: record.peerId,
      direction: 'outgoing',
      phase: 'connecting',
      transferred: 0,
      total: record.photo.size,
    } satisfies TransferEvent);
    await transfer.start();
  }

  private notifyOpen(record: StoredRendezvous): boolean {
    if (isDelivered(record) || this.openNotified.has(record.id)) return false;
    this.openNotified.add(record.id);
    this.emit('appointment', { rendezvous: cloneRecord(record), phase: 'open' });
    return true;
  }

  private notifyDue(record: StoredRendezvous): boolean {
    if (isDelivered(record) || this.dueNotified.has(record.id)) return false;
    this.dueNotified.add(record.id);
    this.emit('appointment', { rendezvous: cloneRecord(record), phase: 'due' });
    return true;
  }

  private async addHuman(
    identity: PublicIdentity,
    inviteHash?: string,
  ): Promise<Human | null> {
    if (!identity || !isPeerId(identity.id) || !isRawPublicKey(identity.publicKey)) {
      throw new RendezvousClientError('invalid-invite', 'Invalid human identity.');
    }
    const expectedId = await derivePeerId(base64UrlToBytes(identity.publicKey));
    if (expectedId !== identity.id) {
      throw new RendezvousClientError('invalid-invite', 'Invalid human identity.');
    }
    const existing = this.humans.get(identity.id);
    if (existing) {
      if (existing.publicKey !== identity.publicKey) {
        this.notice({
          tone: 'error',
          code: 'key-mismatch',
          message: `${displayName(existing.name)}'s key does not match the pinned key. The connection was refused.`,
          humanId: existing.id,
        });
        return null;
      }
      const nextName = normalizeName(identity.name);
      let changed = false;
      if (nextName && nextName !== existing.name) {
        existing.name = nextName;
        changed = true;
      }
      if (inviteHash && !existing.inviteHashes.includes(inviteHash)) {
        existing.inviteHashes.push(inviteHash);
        changed = true;
      }
      if (changed) {
        await this.store.putHuman(makeStoredHuman(existing));
        this.emitHumans();
      }
      return existing;
    }
    const human: Human = {
      id: identity.id,
      name: normalizeName(identity.name),
      publicKey: identity.publicKey,
      addedAt: Date.now(),
      verifiedAt: null,
      inviteHashes: inviteHash ? [inviteHash] : [],
      online: false,
      lastSeenAt: null,
    };
    this.humans.set(human.id, human);
    await this.store.putHuman(makeStoredHuman(human));
    this.transport?.setSubscriptions([...this.humans.keys()]);
    this.emitHumans();
    return human;
  }

  async setCodeName(name: string): Promise<void> {
    const identity = this.requireIdentity();
    const next = normalizeName(name);
    if (next === identity.name) return;
    identity.name = next;
    await this.store.putIdentity(identity);
    this.transport?.send({ type: 'identity:update', name: next });
    this.emitState();
  }

  async createInviteLink(): Promise<string> {
    return buildInviteUrl(await createInviteToken(this.requireIdentity()));
  }

  async verificationWordsFor(humanId: string): Promise<string[]> {
    const human = this.humans.get(humanId);
    if (!human) throw new RendezvousClientError('no-human', 'That human is not connected.');
    return deriveVerificationWords(this.requireIdentity().publicKey, human.publicKey);
  }

  async markHumanVerified(humanId: string, verified = true): Promise<void> {
    const human = this.humans.get(humanId);
    if (!human) throw new RendezvousClientError('no-human', 'That human is not connected.');
    human.verifiedAt = verified ? Date.now() : null;
    await this.store.putHuman(makeStoredHuman(human));
    this.emitHumans();
  }

  async removeHuman(humanId: string): Promise<void> {
    await this.removeHumanInternal(humanId, true);
  }

  private async removeHumanInternal(humanId: string, announceRemoval: boolean): Promise<void> {
    const human = this.humans.get(humanId);
    if (!human) return;
    const revokedHashes = [...human.inviteHashes];
    if (revokedHashes.length > 0) {
      for (const hash of revokedHashes) this.revokedInvites.add(hash);
      await this.store.addRevokedInvites(revokedHashes);
    }
    this.humans.delete(humanId);
    await this.store.deleteHuman(humanId);

    for (const [id, active] of [...this.activeTransfers.entries()]) {
      if (active.peerId === humanId) {
        active.transfer.close();
        this.activeTransfers.delete(id);
      }
    }

    const pendingIds = await this.store.deletePendingRendezvousForHuman(humanId);
    for (const id of pendingIds) this.rendezvous.delete(id);
    for (const record of [...this.rendezvous.values()]) {
      if (record.peerId === humanId && record.status !== 'delivered') {
        this.rendezvous.delete(record.id);
      }
    }
    const joins = await this.store.getPendingJoins();
    for (const join of joins) {
      if (join.to === humanId) {
        this.joinsInFlight.delete(join.id);
        this.joinRetryNotified.delete(join.id);
        await this.store.removePendingJoin(join.id);
      }
    }
    this.transport?.setSubscriptions([...this.humans.keys()]);

    if (announceRemoval) {
      const removal: PendingRemoval = {
        id: `rm_${randomToken(12)}`,
        to: humanId,
        createdAt: Date.now(),
        revokedInvites: revokedHashes,
      };
      await this.store.addPendingRemoval(removal);
      this.transport?.send({
        type: 'contact:remove',
        removalId: removal.id,
        to: humanId,
        revokedInvites: revokedHashes,
      });
      this.notice({
        tone: 'info',
        code: 'human-removed',
        message: `${displayName(human.name)} was removed. Your old link cannot reconnect.`,
        humanId,
      });
    }
    this.emitState();
  }

  async scheduleRendezvous(input: ScheduleInput): Promise<StoredRendezvous> {
    const photo = input.photo;
    if (!photo || photo.size <= 0) {
      throw new RendezvousClientError('invalid-photo', 'Choose a photograph first.');
    }
    if (photo.size > MAX_PHOTO_BYTES) {
      throw new RendezvousClientError('photo-too-large', 'Photographs must be 25 MB or smaller.');
    }
    if (!photo.type.startsWith('image/')) {
      throw new RendezvousClientError('invalid-photo', 'That file is not an image.');
    }
    if (!Number.isFinite(input.scheduledFor) || input.scheduledFor <= Date.now() + 500) {
      throw new RendezvousClientError('invalid-time', 'Choose a moment in the near future.');
    }
    const human = this.humans.get(input.humanId);
    if (!human) throw new RendezvousClientError('no-human', 'Choose a human first.');

    const fallbackName = input.photo instanceof File ? input.photo.name : 'photograph';
    const record: StoredRendezvous = {
      id: `rv_${randomToken(12)}`,
      direction: 'outgoing',
      peerId: human.id,
      peerName: human.name,
      createdAt: Date.now(),
      scheduledFor: input.scheduledFor,
      status: 'scheduled',
      photo: {
        blob: photo,
        name: input.fileName?.trim() || fallbackName || 'photograph',
        type: photo.type,
        size: photo.size,
      },
      announcedAt: null,
      lastAttemptAt: null,
      deliveredAt: null,
      error: null,
    };
    await this.store.putRendezvous(record);
    this.rendezvous.set(record.id, record);
    this.emitState();
    this.announce(record);
    return cloneRecord(record);
  }

  async deleteRendezvous(id: string): Promise<void> {
    const active = this.activeTransfers.get(id);
    if (active) {
      active.transfer.close();
      this.activeTransfers.delete(id);
    }
    this.rendezvous.delete(id);
    await this.store.deleteRendezvous(id);
    this.emitState();
  }

  /** Exposed for advanced hosts that want to expose a diagnostics surface. */
  getVerificationInputs(humanId: string): { self: string; peer: string } | null {
    const human = this.humans.get(humanId);
    const identity = this.identity;
    if (!human || !identity) return null;
    return { self: identity.publicKey, peer: human.publicKey };
  }
}

export function createRendezvousClient(options?: RendezvousClientOptions): RendezvousClient {
  return new RendezvousClient(options);
}
