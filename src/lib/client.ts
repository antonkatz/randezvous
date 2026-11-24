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
import { AudioSession } from './audio';
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
import { isValidVoiceNote, makePhotoAttachment } from './media';
import {
  createPossessionMessage,
  isPossessionMessage,
  newerPossession,
  possessionKey,
  possessionState,
  verifyPossessionMessage,
  type PossessionMessage,
} from './possession';
import type {
  CircleRendezvousInvite,
  InviteCircle,
  InvitePayload,
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
  type MediaPayload,
  type PhotoMeta,
} from './rtc';
import { WebSocketSignalTransport } from './signal';
import { RendezvousStore, type PendingRemoval } from './store';
import {
  IDLE_AUDIO,
  type AudioPhase,
  type AudioSnapshot,
  type ClientNotice,
  type ContributionInput,
  type Human,
  type NewPersonScheduleInput,
  type PossessionView,
  type PublicIdentity,
  type RendezvousClientEvents,
  type RendezvousClientOptions,
  type RendezvousSnapshot,
  type RendezvousStatus,
  type ScheduleInput,
  type SignalNetworkInfo,
  type SignalStatus,
  type StoredHuman,
  type StoredIdentity,
  type StoredPossession,
  type StoredPrint,
  type StoredRendezvous,
  type TransferDiagnostics,
  type TransferEvent,
  type VoiceNoteAttachment,
} from './types';

const RETRY_DELAY_MS = 20_000;
const ANNOUNCE_RETRY_MS = 5_000;
const SIGNAL_AUTH_DOMAIN = 'rendezvous/signal-auth/v1';
const AUDIO_REQUEST_TIMEOUT_MS = 30_000;

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

interface PendingAudioRequest {
  rendezvousId: string;
  sessionId: string;
  peerId: string;
  at: number;
}

function cloneRecord(record: StoredRendezvous): StoredRendezvous {
  return { ...record, confirmedBy: [...record.confirmedBy] };
}

function isDelivered(record: StoredRendezvous): boolean {
  return record.status === 'delivered';
}

function formatNoticeMoment(value: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(value);
  } catch {
    return new Date(value).toISOString();
  }
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
  private prints = new Map<string, StoredPrint>();
  private possessions = new Map<string, StoredPossession>();
  private confirmedPossessionChecks = new Set<string>();
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
  private audio: AudioSnapshot = { ...IDLE_AUDIO };
  private audioSession: AudioSession | null = null;
  private audioSessionId: string | null = null;
  private audioSessionPeer: string | null = null;
  private audioOfferSdp: string | null = null;
  private audioStream: MediaStream | null = null;
  private audioRemoteStream: MediaStream | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private pendingAudioRequest: PendingAudioRequest | null = null;
  private outgoingAudioRequest: PendingAudioRequest | null = null;
  private audioRequestTimer: number | null = null;
  private audioClosing = false;
  private lastAudioSecond = -1;
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
      prints: [...this.prints.values()].sort((a, b) => {
        const arrival = b.deliveredAt - a.deliveredAt;
        return arrival !== 0 ? arrival : a.id.localeCompare(b.id);
      }),
      possessions: this.possessionViews(),
      audio: { ...this.audio },
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

  /** Send signed app metadata. Queued notices wait for an offline human. */
  sendAppMessage(peerId: string, message: unknown, queue = true): boolean {
    if (!this.identity || !this.humans.has(peerId)) return false;
    const id = `ob_${randomToken(10)}`;
    const sent =
      this.transport?.send({
        type: 'app:relay',
        to: peerId,
        message,
        queue,
      }) ?? false;
    if (!sent && queue) {
      // The release/claim is signed already. Keep it until a connection can
      // carry it rather than silently losing a deletion notice.
      void this.store.addAppOutbox({
        id,
        peerId,
        message,
        createdAt: Date.now(),
      });
    }
    return sent;
  }

  /**
   * Create a self-contained circle link. The embedded signed records let the
   * opener join the circle without contacting the inviter; the inviter is only
   * needed later for ordinary circle sync.
   */
  async createCircleLink(circle: InviteCircle): Promise<string> {
    const token = await createInviteToken(this.requireIdentity(), {
      circleId: circle.id,
      circle,
    });
    return buildInviteUrl(token);
  }

  /**
   * Legacy membership-only link. New links should use `createCircleLink` so
   * membership does not depend on the inviter being online.
   */
  async createCircleInviteLink(circleId: string): Promise<string> {
    const token = await createInviteToken(this.requireIdentity(), { circleId });
    return buildInviteUrl(token);
  }

  /** Publish a signed circle rendezvous invite for the server's expiring queue. */
  publishCircleRendezvousInvite(
    invite: Omit<CircleRendezvousInvite, 'fromId' | 'fromName' | 'createdAt'>,
  ): boolean {
    const identity = this.identity;
    if (!identity) return false;
    return (
      this.transport?.send({
        type: 'circle:rendezvous:create',
        invite: {
          ...invite,
          fromId: identity.id,
          fromName: identity.name,
          createdAt: Date.now(),
        },
      }) ?? false
    );
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
    await this.loadPrints();
    await this.loadPossessions();
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
    if (this.audioRequestTimer !== null) {
      window.clearTimeout(this.audioRequestTimer);
      this.audioRequestTimer = null;
    }
    this.closeAudio('Rendezvous closed.');
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

  private async loadPrints(): Promise<void> {
    const stored = await this.store.listPrints();
    for (const print of stored) {
      if (!print.photo.photoId) {
        print.photo = await makePhotoAttachment({
          photo: print.photo.blob,
          fileName: print.photo.name,
        });
      }
      this.prints.set(print.id, print);
    }
  }

  private async loadPossessions(): Promise<void> {
    const stored = await this.store.listPossessions();
    for (const possession of stored) {
      possession.copies ??= 1;
      this.possessions.set(possession.key, possession);
    }
  }

  private async loadRendezvous(): Promise<void> {
    const stored = await this.store.listRendezvous();
    const now = Date.now();
    for (const record of stored) {
      record.contribution ??= null;
      record.reciprocal ??= null;
      record.sessionStartedAt ??= null;
      record.audioWindowUsedAt ??= null;
      record.liveAudioDisabled ??= false;
      record.inviteToken ??= null;
      record.confirmedBy ??= [this.identity?.id ?? '', record.peerId].filter(Boolean);
      record.proposedBy ??=
        record.direction === 'outgoing' ? (this.identity?.id ?? '') : record.peerId;
      record.revision ??= 0;
      record.confirmation = this.confirmationFor(record);
      if (record.photo && !record.photo.photoId) {
        record.photo = await makePhotoAttachment({
          photo: record.photo.blob,
          fileName: record.photo.name,
        });
      }
      if (record.contribution && !record.contribution.photoId) {
        record.contribution = await makePhotoAttachment({
          photo: record.contribution.blob,
          fileName: record.contribution.name,
        });
      }
      if (record.reciprocal && !record.reciprocal.photoId) {
        record.reciprocal = await makePhotoAttachment({
          photo: record.reciprocal.blob,
          fileName: record.reciprocal.name,
        });
      }
      if (record.status === 'connecting' || record.status === 'transferring') {
        record.status = isHandoffEligible(record.scheduledFor, now) ? 'waiting' : 'scheduled';
        record.error = null;
        await this.store.putRendezvous(record);
      }
      this.rendezvous.set(record.id, record);
      await this.migrateDeliveredPrint(record);
    }
  }

  /** Both direct participants must confirm the current proposed time. */
  private confirmationFor(record: StoredRendezvous): 'pending' | 'confirmed' {
    const participants = new Set(
      [this.identity?.id ?? '', record.peerId].filter(Boolean),
    );
    if (participants.size < 2) return 'pending';
    return [...participants].every((id) => record.confirmedBy.includes(id))
      ? 'confirmed'
      : 'pending';
  }

  /** Convert pre-print databases into independent wall prints once. */
  private async migrateDeliveredPrint(record: StoredRendezvous): Promise<void> {
    if (record.status !== 'delivered' || !record.photo || !record.deliveredAt) return;
    const id = `pr_${record.id}_${record.direction}_primary`;
    if (this.prints.has(id)) return;
    const print: StoredPrint = {
      id,
      appointmentId: record.id,
      photoId: record.photo.photoId,
      direction: record.direction,
      peerId: record.peerId,
      peerName: record.peerName,
      photo: record.photo,
      deliveredAt: record.deliveredAt,
      createdAt: record.deliveredAt,
    };
    this.prints.set(id, print);
    await this.store.putPrint(print);
    if (print.direction === 'incoming') {
      void this.claimPhoto(record, print.photoId);
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
      if (invite.rendezvous) {
        await this.storeInvitedRendezvous(invite, human);
      }
      const join = await createJoinRequest({
        identity: this.identity,
        inviterId: invite.id,
        token,
      });
      await this.store.addPendingJoin(join);
      this.notice({
        tone: 'success',
        code: 'human-added',
        message: invite.rendezvous
          ? `The link opened. Your rendezvous with ${displayName(human.name)} is already here.`
          : `The link is saved. You and ${displayName(human.name)} will find each other whenever you’re both here.`,
        humanId: human.id,
      });
      if (invite.circle) {
        this.emit('circleLink', {
          circle: invite.circle,
          inviterId: invite.id,
          inviterName: human.name,
          humanId: human.id,
        });
      } else if (invite.circleId) {
        this.emit('circleMemberRequest', {
          circleId: invite.circleId,
          humanId: human.id,
          humanName: human.name,
        });
      }
      this.emitState();
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

  private async storeInvitedRendezvous(
    invite: InvitePayload,
    human: Human,
  ): Promise<void> {
    const pending = invite.rendezvous;
    if (!pending) return;
    const existing = this.rendezvous.get(pending.id);
    if (existing) {
      if (existing.direction !== 'incoming') return;
      existing.peerName = human.name || existing.peerName;
      existing.scheduledFor = pending.scheduledFor;
      existing.createdAt = pending.createdAt;
      existing.liveAudioDisabled = pending.liveAudioDisabled === true;
      existing.status = isHandoffEligible(existing.scheduledFor)
        ? existing.status === 'connecting' || existing.status === 'transferring'
          ? existing.status
          : 'waiting'
        : existing.status === 'delivered'
          ? 'delivered'
          : 'scheduled';
      existing.confirmedBy ??= [];
      existing.proposedBy ??= invite.id;
      existing.revision ??= 0;
      existing.confirmation = this.confirmationFor(existing);
      await this.store.putRendezvous(existing);
      return;
    }
    const record: StoredRendezvous = {
      id: pending.id,
      direction: 'incoming',
      peerId: invite.id,
      peerName: human.name,
      createdAt: pending.createdAt,
      scheduledFor: pending.scheduledFor,
      status: isHandoffEligible(pending.scheduledFor) ? 'waiting' : 'scheduled',
      confirmation: 'pending',
      confirmedBy: [],
      proposedBy: invite.id,
      revision: 0,
      photo: null,
      contribution: null,
      reciprocal: null,
      sessionStartedAt: null,
      audioWindowUsedAt: null,
      liveAudioDisabled: pending.liveAudioDisabled === true,
      inviteToken: null,
      announcedAt: null,
      lastAttemptAt: null,
      deliveredAt: null,
      error: null,
    };
    this.rendezvous.set(record.id, record);
    await this.store.putRendezvous(record);
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
    const outbox = await this.store.getAppOutbox();
    for (const entry of outbox) {
      if (
        transport.send({
          type: 'app:relay',
          to: entry.peerId,
          message: entry.message,
          queue: true,
        })
      ) {
        await this.store.removeAppOutbox(entry.id);
      }
    }
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
        Boolean(record.peerId) &&
        record.status !== 'awaiting-join' &&
        !record.deliveredAt &&
        !record.announcedAt &&
        !this.announceInFlight.has(record.id) &&
        (record.direction === 'outgoing' || record.revision > 0) &&
        (this.announceRetryAt.get(record.id) ?? 0) <= Date.now()
      ) {
        this.announce(record);
      }
    }
  }

  private announce(record: StoredRendezvous): void {
    const transport = this.transport;
    if (!transport?.isOnline) return;
    const identity = this.requireIdentity();
    const outgoing = record.direction === 'outgoing';
    const wire: RendezvousWire = {
      id: record.id,
      fromId: outgoing ? identity.id : record.peerId,
      fromName: outgoing ? identity.name : record.peerName,
      toId: outgoing ? record.peerId : identity.id,
      scheduledFor: record.scheduledFor,
      createdAt: record.createdAt,
      liveAudioDisabled: record.liveAudioDisabled,
      proposedBy: record.proposedBy,
      confirmedBy: [...record.confirmedBy],
      revision: record.revision,
    };
    const isUpdate = record.revision > 0 || record.confirmedBy.length > 0;
    const sent = transport.send(
      isUpdate
        ? {
            type: 'rendezvous:update',
            action: record.confirmedBy.length > 0 ? 'confirm' : 'counter',
            rendezvous: wire,
          }
        : { type: 'rendezvous:create', rendezvous: wire },
    );
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
      case 'rendezvous:updated':
        await this.handleRendezvousUpdated(message.id);
        return;
      case 'rendezvous:notice':
        await this.handleRendezvousNotice(message.rendezvous);
        return;
      case 'circle:relay':
        if (!this.humans.has(message.fromId)) return;
        this.emit('circle', { fromId: message.fromId, message: message.message });
        return;
      case 'app:relay':
        if (!this.humans.has(message.fromId)) return;
        this.emit('app', { fromId: message.fromId, message: message.message });
        await this.handleAppMessage(message.fromId, message.message);
        if (message.queuedId) {
          this.transport?.send({ type: 'app:ack', queuedId: message.queuedId });
        }
        return;
      case 'circle:rendezvous:notice':
        if (message.invite.fromId === this.identity?.id) return;
        if (!message.invite.recipients.includes(this.identity?.id ?? '')) return;
        this.emit('circleRendezvous', {
          fromId: message.invite.fromId,
          invite: message.invite,
        });
        return;
      case 'circle:rendezvous:created':
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
    if (this.audio.peerId) {
      const audioHuman = this.humans.get(this.audio.peerId);
      if (audioHuman && !audioHuman.online) {
        this.closeAudio('The other person left. The audio window ended.');
      }
    }
    void this.processDue();
  }

  private emitHumans(): void {
    this.emit('state', this.getSnapshot());
  }

  private async attachInvitationRendezvous(
    invite: InvitePayload,
    sender: PublicIdentity,
  ): Promise<void> {
    const pending = invite.rendezvous;
    if (!pending) return;
    const record = this.rendezvous.get(pending.id);
    if (!record || record.direction !== 'outgoing') return;
    if (record.peerId && record.peerId !== sender.id) return;
    record.peerId = sender.id;
    record.peerName = sender.name;
    record.status = isHandoffEligible(record.scheduledFor) ? 'waiting' : 'scheduled';
    record.confirmedBy = record.confirmedBy ?? [];
    record.proposedBy = record.proposedBy ?? this.identity?.id ?? '';
    record.revision = record.revision ?? 0;
    record.confirmation = this.confirmationFor(record);
    record.inviteToken = null;
    record.announcedAt = null;
    record.error = null;
    await this.store.putRendezvous(record);
    this.emitState();
    this.announce(record);
    void this.processDue();
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
      await this.attachInvitationRendezvous(verified.invite, verified.sender);
      if (human && verified.invite.circleId) {
        this.emit('circleMemberRequest', {
          circleId: verified.invite.circleId,
          humanId: human.id,
          humanName: human.name,
        });
      }
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

  private async handleRendezvousUpdated(id: string): Promise<void> {
    const record = this.rendezvous.get(id);
    if (!record) return;
    record.announcedAt = Date.now();
    this.announceInFlight.delete(id);
    this.announceRetryAt.delete(id);
    await this.store.putRendezvous(record);
    this.emitState();
  }

  private async handleRendezvousNotice(notice: RendezvousNotice): Promise<void> {
    const identity = this.requireIdentity();
    const existingNoticeRecord = this.rendezvous.get(notice.id);
    if (notice.fromId === identity.id && !existingNoticeRecord) {
      this.transport?.send({ type: 'rendezvous:ack', id: notice.id });
      return;
    }
    const peerId = existingNoticeRecord
      ? existingNoticeRecord.peerId
      : notice.fromId;
    const human = this.humans.get(peerId);
    if (!human) {
      this.transport?.send({ type: 'rendezvous:ack', id: notice.id });
      return;
    }

    let record = this.rendezvous.get(notice.id);
    let isNew = false;
    let timeChanged = false;
    let wasConfirmed = record?.confirmation === 'confirmed';
    const noticeRevision = notice.revision ?? 0;
    if (!record) {
      isNew = true;
      record = {
        id: notice.id,
        direction: 'incoming',
        peerId,
        peerName: human.name || notice.fromName,
        createdAt: notice.createdAt,
        scheduledFor: notice.scheduledFor,
        status: isHandoffEligible(notice.scheduledFor) ? 'waiting' : 'scheduled',
        confirmation: 'pending',
        confirmedBy: [...(notice.confirmedBy ?? [])],
        proposedBy: notice.proposedBy ?? notice.fromId,
        revision: noticeRevision,
        photo: null,
        contribution: null,
        reciprocal: null,
        sessionStartedAt: null,
        audioWindowUsedAt: null,
        liveAudioDisabled: notice.liveAudioDisabled === true,
        inviteToken: null,
        announcedAt: Date.now(),
        lastAttemptAt: null,
        deliveredAt: null,
        error: null,
      };
      record.confirmation = this.confirmationFor(record);
      this.rendezvous.set(record.id, record);
    } else {
      if (noticeRevision < record.revision) {
        this.transport?.send({ type: 'rendezvous:ack', id: notice.id });
        return;
      }
      timeChanged =
        notice.scheduledFor !== record.scheduledFor ||
        Boolean(notice.proposedBy && notice.proposedBy !== record.proposedBy);
      if (timeChanged) {
        record.scheduledFor = notice.scheduledFor;
        record.proposedBy = notice.proposedBy ?? notice.fromId;
        record.confirmedBy = [...(notice.confirmedBy ?? [])];
        if (
          record.status !== 'delivered' &&
          record.status !== 'connecting' &&
          record.status !== 'transferring'
        ) {
          record.status = isHandoffEligible(record.scheduledFor) ? 'waiting' : 'scheduled';
        }
      } else {
        record.confirmedBy = [
          ...new Set([...record.confirmedBy, ...(notice.confirmedBy ?? [])]),
        ];
        if (notice.proposedBy) record.proposedBy = notice.proposedBy;
      }
      record.revision = Math.max(record.revision, noticeRevision);
      record.announcedAt = Date.now();
      record.peerName = human.name || notice.fromName;
      if (typeof notice.liveAudioDisabled === 'boolean') {
        record.liveAudioDisabled = notice.liveAudioDisabled;
      }
      record.confirmation = this.confirmationFor(record);
    }

    await this.store.putRendezvous(record);
    this.transport?.send({ type: 'rendezvous:ack', id: record.id });
    this.emitState();

    if (timeChanged) {
      this.notice({
        tone: 'info',
        code: 'rendezvous-countered',
        message: `${displayName(record.peerName)} proposed ${formatNoticeMoment(record.scheduledFor)}.`,
        humanId: record.peerId,
        rendezvousId: record.id,
      });
    } else if (!wasConfirmed && record.confirmation === 'confirmed') {
      this.notice({
        tone: 'success',
        code: 'rendezvous-confirmed',
        message: `You and ${displayName(record.peerName)} confirmed the rendezvous.`,
        humanId: record.peerId,
        rendezvousId: record.id,
      });
    }

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

    if (transferId.startsWith('au_')) {
      if (this.audioSessionId !== transferId || this.audioSessionPeer !== fromId) return;
      if (!this.audioSession) {
        if (payload.kind !== 'offer') return;
        const stream = this.audioStream;
        if (!stream) return;
        this.audioSession = new AudioSession({
          sessionId: transferId,
          localPeerId: identity.id,
          remotePeerId: fromId,
          localPrivateKey: identity.privateKey,
          remotePublicKey: human.publicKey,
          iceServers: this.iceServers,
          stream,
          offerSdp: payload.sdp,
          offerer: false,
          sendSignal: (next) => this.sendRtc(fromId, transferId, next),
          onRemoteStream: (remote) => this.attachRemoteAudio(remote),
          onBegan: (startedAt) => this.markAudioLive(startedAt),
          onRemoteMute: (muted) => {
            this.audio = { ...this.audio, remoteMuted: muted };
            this.emitAudio();
          },
          onEnded: (reason) => this.finishAudio(reason),
          onError: (message) => this.failAudio(message),
        });
        this.audio = {
          ...this.audio,
          phase: 'connecting',
          peerId: fromId,
          peerName: human.name,
          message: 'Proving both identities before audio.',
        };
        this.emitAudio();
        await this.audioSession.start();
        return;
      }
      await this.audioSession.handleSignal(payload);
      return;
    }

    if (payload.kind === 'offer') {
      const existingActive = this.activeTransfers.get(transferId);
      if (existingActive) {
        existingActive.transfer.close();
        this.activeTransfers.delete(transferId);
      }
      let record = this.rendezvous.get(transferId);
      if (!record) {
        record = this.blankIncomingRecord(transferId, fromId, human);
        this.rendezvous.set(record.id, record);
        await this.store.putRendezvous(record);
        this.emitState();
      }
      if (record.direction !== 'incoming') return;

      record.status = 'connecting';
      record.error = null;
      record.sessionStartedAt ??= Date.now();
      await this.store.putRendezvous(record);
      this.emitState();

      const contribution = record.contribution
        ? {
            photo: record.contribution.blob,
            meta: {
              name: record.contribution.name,
              type: record.contribution.type,
              size: record.contribution.size,
              photoId: record.contribution.photoId,
              note: record.contribution.note
                ? {
                    name: record.contribution.note.name,
                    type: record.contribution.note.type,
                    size: record.contribution.note.size,
                    durationMs: record.contribution.note.durationMs,
                  }
                : null,
            },
            note: record.contribution.note,
          }
        : null;
      const transfer = new ReceiverTransfer({
        transferId,
        localPeerId: identity.id,
        remotePeerId: fromId,
        localPrivateKey: identity.privateKey,
        remotePublicKey: human.publicKey,
        iceServers: this.iceServers,
        offerSdp: payload.sdp,
        contribution,
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

  private blankIncomingRecord(
    id: string,
    peerId: string,
    human: Human,
  ): StoredRendezvous {
    return {
      id,
      direction: 'incoming',
      peerId,
      peerName: human.name,
      createdAt: Date.now(),
      scheduledFor: Date.now(),
      status: 'waiting',
      confirmation: 'confirmed',
      confirmedBy: [this.identity?.id ?? '', peerId].filter(Boolean),
      proposedBy: peerId,
      revision: 0,
      photo: null,
      contribution: null,
      reciprocal: null,
      sessionStartedAt: null,
      audioWindowUsedAt: null,
      liveAudioDisabled: false,
      inviteToken: null,
      announcedAt: null,
      lastAttemptAt: null,
      deliveredAt: null,
      error: null,
    };
  }

  private sendRtc(to: string, transferId: string, payload: RtcSignalPayload): void {
    this.transport?.send({ type: 'rtc', to, transferId, payload });
  }

  private transferCallbacks(record: StoredRendezvous) {
    const attachmentFrom = async (payload: MediaPayload) =>
      makePhotoAttachment({
        photo: payload.photo,
        fileName: payload.meta.name,
        photoId: payload.photoId,
        note: payload.note,
      });

    return {
      onPhase: (
        phase: 'connecting' | 'progress' | 'complete' | 'error',
        transferred: number,
        total: number,
      ) => {
        if (phase === 'progress' && record.status !== 'transferring' && record.status !== 'delivered') {
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
      onError: (message: string, direction: 'primary' | 'reciprocal') => {
        if (direction === 'reciprocal' && record.status === 'delivered') {
          this.notice({
            tone: 'warning',
            code: 'transfer-failed',
            message: `Your reciprocal photograph was not delivered. ${message}`,
            humanId: record.peerId,
            rendezvousId: record.id,
          });
          return;
        }
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
      onSenderComplete: async () => {
        record.status = 'delivered';
        record.deliveredAt = Date.now();
        record.error = null;
        await this.store.putRendezvous(record);
        if (record.photo) {
          await this.createPrint(record, 'outgoing', record.photo, 'primary');
        }
        this.emitState();
        this.notice({
          tone: 'success',
          code: 'transfer-delivered',
          message: `${displayName(record.peerName)} received your photograph.`,
          humanId: record.peerId,
          rendezvousId: record.id,
        });
      },
      onReceiverComplete: async (payload: MediaPayload) => {
        const attachment = await attachmentFrom(payload);
        record.photo = attachment;
        record.status = 'delivered';
        record.deliveredAt = Date.now();
        record.error = null;
        await this.store.putRendezvous(record);
        await this.createPrint(record, 'incoming', attachment, 'primary');
        this.emitState();
        this.emit('appointment', {
          rendezvous: cloneRecord(record),
          phase: 'received',
        });
      },
      onReceiverAcked: (payload: MediaPayload) => {
        void this.claimPhoto(record, payload.photoId);
      },
      onReciprocalComplete: async (payload: MediaPayload) => {
        const attachment = await attachmentFrom(payload);
        record.reciprocal = attachment;
        await this.store.putRendezvous(record);
        await this.createPrint(record, 'incoming', attachment, 'contribution');
        this.emitState();
        this.emit('appointment', {
          rendezvous: cloneRecord(record),
          phase: 'received',
        });
      },
      onReciprocalAcked: (payload: MediaPayload) => {
        void this.claimPhoto(record, payload.photoId);
      },
      onContributionAcked: async () => {
        if (!record.contribution) return;
        await this.createPrint(record, 'outgoing', record.contribution, 'contribution');
        this.emitState();
      },
      onDiagnostics: (diagnostics: TransferDiagnostics) => {
        this.lastTransferDiagnostics = diagnostics;
        this.emitState();
      },
      onClosed: () => {
        const active = this.activeTransfers.get(record.id);
        if (active) this.activeTransfers.delete(record.id);
        void this.processDue();
      },
    };
  }

  private async createPrint(
    record: StoredRendezvous,
    direction: StoredPrint['direction'],
    photo: NonNullable<StoredRendezvous['photo']>,
    kind: 'primary' | 'contribution',
  ): Promise<StoredPrint> {
    const id = `pr_${record.id}_${direction}_${kind}`;
    const print: StoredPrint = {
      id,
      appointmentId: record.id,
      photoId: photo.photoId,
      direction,
      peerId: record.peerId,
      peerName: record.peerName,
      photo,
      deliveredAt: record.deliveredAt ?? Date.now(),
      createdAt: Date.now(),
    };
    this.prints.set(id, print);
    await this.store.putPrint(print);
    return print;
  }

  private async processDue(): Promise<void> {
    if (!this.ready || this.processingDue || this.stopped) return;
    this.processingDue = true;
    this.updateAudioTick();
    const now = Date.now();
    let changed = false;
    try {
      for (const record of sortRendezvous(this.rendezvous.values())) {
        if (isDelivered(record) || record.status === 'awaiting-join') continue;
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
    record.sessionStartedAt ??= Date.now();
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
      note: record.photo.note,
      meta: {
        name: record.photo.name,
        type: record.photo.type,
        size: record.photo.size,
        photoId: record.photo.photoId,
        note: record.photo.note
          ? {
              name: record.photo.note.name,
              type: record.photo.note.type,
              size: record.photo.note.size,
              durationMs: record.photo.note.durationMs,
            }
          : null,
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
    if (this.audio.peerId === humanId) {
      this.closeAudio('The human was removed. The audio window ended.');
    }

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
    if (input.note && !isValidVoiceNote(input.note)) {
      throw new RendezvousClientError('invalid-photo', 'That voice note cannot be attached.');
    }
    const human = this.humans.get(input.humanId);
    if (!human) throw new RendezvousClientError('no-human', 'Choose a human first.');

    const attachment = await makePhotoAttachment({
      photo,
      fileName: input.fileName,
      photoId: input.photoId,
      note: input.note,
    });
    const record: StoredRendezvous = {
      id: `rv_${randomToken(12)}`,
      direction: 'outgoing',
      peerId: human.id,
      peerName: human.name,
      createdAt: Date.now(),
      scheduledFor: input.scheduledFor,
      status: 'scheduled',
      confirmation: 'pending',
      confirmedBy: [],
      proposedBy: this.requireIdentity().id,
      revision: 0,
      photo: attachment,
      contribution: null,
      reciprocal: null,
      sessionStartedAt: null,
      audioWindowUsedAt: null,
      liveAudioDisabled: input.liveAudioDisabled === true,
      inviteToken: null,
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

  /**
   * Schedule a rendezvous for someone who has not joined yet. The invitation
   * link carries the already-saved appointment; no human is created until the
   * link is redeemed.
   */
  async scheduleRendezvousForNewPerson(
    input: NewPersonScheduleInput,
  ): Promise<StoredRendezvous> {
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
    if (input.note && !isValidVoiceNote(input.note)) {
      throw new RendezvousClientError('invalid-photo', 'That voice note cannot be attached.');
    }
    const identity = this.requireIdentity();
    const id = `rv_${randomToken(12)}`;
    const createdAt = Date.now();
    const attachment = await makePhotoAttachment({
      photo,
      fileName: input.fileName,
      note: input.note,
    });
    const inviteRendezvous = {
      id,
      scheduledFor: input.scheduledFor,
      createdAt,
      ...(input.liveAudioDisabled ? { liveAudioDisabled: true } : {}),
    };
    const inviteToken = await createInviteToken(identity, { rendezvous: inviteRendezvous });
    const record: StoredRendezvous = {
      id,
      direction: 'outgoing',
      peerId: '',
      peerName: '',
      createdAt,
      scheduledFor: input.scheduledFor,
      status: 'awaiting-join',
      confirmation: 'pending',
      confirmedBy: [],
      proposedBy: identity.id,
      revision: 0,
      photo: attachment,
      contribution: null,
      reciprocal: null,
      sessionStartedAt: null,
      audioWindowUsedAt: null,
      liveAudioDisabled: input.liveAudioDisabled === true,
      inviteToken,
      announcedAt: null,
      lastAttemptAt: null,
      deliveredAt: null,
      error: null,
    };
    await this.store.putRendezvous(record);
    this.rendezvous.set(record.id, record);
    this.emitState();
    return cloneRecord(record);
  }

  /**
   * Confirm the current proposed time. The rendezvous becomes confirmed only
   * when both direct participants have confirmed it. This is a label only:
   * the normal handoff window still applies.
   */
  async confirmRendezvous(rendezvousId: string): Promise<StoredRendezvous> {
    const identity = this.requireIdentity();
    const record = this.rendezvous.get(rendezvousId);
    if (!record) throw new RendezvousClientError('no-human', 'That rendezvous is not here.');
    if (record.status === 'delivered' || record.deliveredAt) {
      throw new RendezvousClientError('invalid-time', 'This rendezvous is already complete.');
    }
    if (!record.peerId || record.status === 'awaiting-join') {
      throw new RendezvousClientError('no-human', 'The other human has not joined yet.');
    }
    if (record.confirmedBy.includes(identity.id)) return cloneRecord(record);
    record.confirmedBy = [...record.confirmedBy, identity.id];
    record.confirmation = this.confirmationFor(record);
    record.revision += 1;
    record.announcedAt = null;
    this.announceInFlight.delete(record.id);
    this.announceRetryAt.delete(record.id);
    await this.store.putRendezvous(record);
    this.emitState();
    this.announce(record);
    return cloneRecord(record);
  }

  /**
   * Cancel the current proposed time on the same rendezvous and propose a new
   * one. Confirmations reset; both humans must confirm the new time.
   */
  async counterProposeRendezvous(input: {
    rendezvousId: string;
    scheduledFor: number;
  }): Promise<StoredRendezvous> {
    const identity = this.requireIdentity();
    const record = this.rendezvous.get(input.rendezvousId);
    if (!record) throw new RendezvousClientError('no-human', 'That rendezvous is not here.');
    if (record.status === 'delivered' || record.deliveredAt) {
      throw new RendezvousClientError('invalid-time', 'This rendezvous is already complete.');
    }
    if (!record.peerId || record.status === 'awaiting-join') {
      throw new RendezvousClientError('no-human', 'The other human has not joined yet.');
    }
    if (record.sessionStartedAt || this.activeTransfers.has(record.id)) {
      throw new RendezvousClientError('invalid-time', 'The handoff has begun; the time is locked.');
    }
    if (
      !Number.isFinite(input.scheduledFor) ||
      input.scheduledFor <= Date.now() + 500
    ) {
      throw new RendezvousClientError('invalid-time', 'Choose a moment in the near future.');
    }
    record.scheduledFor = input.scheduledFor;
    record.proposedBy = identity.id;
    record.confirmedBy = [];
    record.confirmation = 'pending';
    record.revision += 1;
    record.announcedAt = null;
    record.lastAttemptAt = null;
    record.error = null;
    record.audioWindowUsedAt = null;
    if (
      record.status !== 'connecting' &&
      record.status !== 'transferring'
    ) {
      record.status = isHandoffEligible(record.scheduledFor) ? 'waiting' : 'scheduled';
    }
    this.openNotified.delete(record.id);
    this.dueNotified.delete(record.id);
    this.lateNotified.delete(record.id);
    this.announceInFlight.delete(record.id);
    this.announceRetryAt.delete(record.id);
    await this.store.putRendezvous(record);
    this.emitState();
    this.announce(record);
    return cloneRecord(record);
  }

  /**
   * Attach (or replace) my reciprocal photo on an appointment I did not
   * create. It stays local until the handoff session starts.
   */
  async setContribution(input: ContributionInput): Promise<StoredRendezvous> {
    const record = this.rendezvous.get(input.rendezvousId);
    if (!record) throw new RendezvousClientError('no-human', 'That rendezvous is not here.');
    if (record.direction !== 'incoming') {
      throw new RendezvousClientError('invalid-photo', 'This is already your own rendezvous.');
    }
    if (record.status === 'delivered' || record.deliveredAt) {
      throw new RendezvousClientError('invalid-photo', 'This rendezvous is already complete.');
    }
    if (record.sessionStartedAt || this.activeTransfers.has(record.id)) {
      throw new RendezvousClientError('invalid-photo', 'The handoff has begun; contributions are locked.');
    }
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
    if (input.note && !isValidVoiceNote(input.note)) {
      throw new RendezvousClientError('invalid-photo', 'That voice note cannot be attached.');
    }
    record.contribution = await makePhotoAttachment({
      photo,
      fileName: input.fileName,
      photoId: input.photoId,
      note: input.note,
    });
    await this.store.putRendezvous(record);
    this.emitState();
    return cloneRecord(record);
  }

  async removeContribution(rendezvousId: string): Promise<void> {
    const record = this.rendezvous.get(rendezvousId);
    if (!record || record.direction !== 'incoming') return;
    if (record.sessionStartedAt || this.activeTransfers.has(record.id)) {
      throw new RendezvousClientError('invalid-photo', 'The handoff has begun; contributions are locked.');
    }
    record.contribution = null;
    await this.store.putRendezvous(record);
    this.emitState();
  }

  getPrint(printId: string): StoredPrint | null {
    return this.prints.get(printId) ?? null;
  }

  async deletePrint(printId: string): Promise<void> {
    const print = this.prints.get(printId);
    if (!print) return;
    this.prints.delete(printId);
    await this.store.deletePrint(printId);
    const remaining = await this.store.listPrintsForPhoto(print.photoId);
    if (remaining.length === 0) {
      const ownership = [...this.possessions.values()].filter(
        (entry) => entry.photoId === print.photoId,
      );
      for (const entry of ownership) {
        this.possessions.delete(entry.key);
      }
      await this.store.deletePossessionsForPhoto(print.photoId);
    }
    if (print.direction === 'incoming' && remaining.length === 0) {
      void this.releasePhoto(print);
    }
    this.emitState();
  }

  async deleteRendezvous(id: string): Promise<void> {
    const active = this.activeTransfers.get(id);
    if (active) {
      active.transfer.close();
      this.activeTransfers.delete(id);
    }
    if (this.audio.rendezvousId === id) {
      this.closeAudio('The rendezvous was deleted. The audio window ended.');
    }
    this.rendezvous.delete(id);
    await this.store.deleteRendezvous(id);
    this.emitState();
  }

  private emitAudio(): void {
    this.emit('audio', { audio: { ...this.audio } });
    this.emitState();
  }

  private audioRecord(): StoredRendezvous | null {
    return this.audio.rendezvousId
      ? this.rendezvous.get(this.audio.rendezvousId) ?? null
      : null;
  }

  /** Ask the other participant for the single one-minute voice window. */
  async requestAudioMinute(rendezvousId: string): Promise<void> {
    const record = this.rendezvous.get(rendezvousId);
    const human = record ? this.humans.get(record.peerId) : null;
    if (!record || !human) {
      throw new RendezvousClientError('no-human', 'That rendezvous is not here.');
    }
    if (!human.online) {
      throw new RendezvousClientError('no-human', 'The other human is not here yet.');
    }
    if (!isHandoffEligible(record.scheduledFor)) {
      throw new RendezvousClientError('invalid-time', 'The handoff window is not open yet.');
    }
    if (record.liveAudioDisabled) {
      throw new RendezvousClientError(
        'invalid-time',
        'Live audio is off for this rendezvous.',
      );
    }
    if (record.audioWindowUsedAt) {
      throw new RendezvousClientError('invalid-time', 'The minute for this rendezvous is already used.');
    }
    if (
      this.audio.phase === 'requesting' ||
      this.audio.phase === 'incoming' ||
      this.audio.phase === 'connecting' ||
      this.audio.phase === 'live'
    ) {
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new RendezvousClientError('handshake-failed', 'This browser cannot use a microphone here.');
    }
    this.audioClosing = false;
    const sessionId = `au_${randomToken(12)}`;
    const request: PendingAudioRequest = {
      rendezvousId,
      sessionId,
      peerId: record.peerId,
      at: Date.now(),
    };
    this.outgoingAudioRequest = request;
    this.audio = {
      ...IDLE_AUDIO,
      rendezvousId,
      peerId: record.peerId,
      peerName: record.peerName,
      phase: 'requesting',
      message: `Waiting for ${displayName(record.peerName)} to allow a minute.`,
    };
    this.sendAppMessage(
      record.peerId,
      { kind: 'audio/request', rendezvousId, sessionId, at: request.at },
      false,
    );
    this.emitAudio();
    this.audioRequestTimer = window.setTimeout(() => {
      if (this.audio.phase !== 'requesting') return;
      if (this.outgoingAudioRequest?.sessionId !== sessionId) return;
      this.outgoingAudioRequest = null;
      this.audio = {
        ...this.audio,
        phase: 'declined',
        message: 'No answer. The minute was not used.',
      };
      this.emitAudio();
    }, AUDIO_REQUEST_TIMEOUT_MS);
  }

  /** Accept or decline a pending incoming request. */
  async respondAudioMinute(accept: boolean): Promise<void> {
    const request = this.pendingAudioRequest;
    if (!request || this.audio.phase !== 'incoming') return;
    this.pendingAudioRequest = null;
    if (!accept) {
      this.sendAppMessage(
        request.peerId,
        { kind: 'audio/decline', rendezvousId: request.rendezvousId, sessionId: request.sessionId },
        false,
      );
      this.audio = {
        ...this.audio,
        phase: 'declined',
        message: 'You declined. Nothing was recorded and the minute is not used.',
      };
      this.emitAudio();
      return;
    }

    this.audioClosing = false;
    this.sendAppMessage(
      request.peerId,
      { kind: 'audio/accept', rendezvousId: request.rendezvousId, sessionId: request.sessionId },
      false,
    );
    this.audioSessionId = request.sessionId;
    this.audioSessionPeer = request.peerId;
    this.audio = {
      ...this.audio,
      phase: 'connecting',
      message: 'Opening the microphone. Both browsers must prove their keys.',
    };
    this.emitAudio();
    try {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('This browser cannot use a microphone here.');
      }
      this.audioStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch {
      this.sendAppMessage(
        request.peerId,
        { kind: 'audio/failed', rendezvousId: request.rendezvousId, sessionId: request.sessionId },
        false,
      );
      this.failAudio('Microphone permission was denied. The photo handoff is unaffected.');
    }
  }

  toggleAudioMute(): void {
    if (this.audio.phase !== 'live') return;
    this.audio = { ...this.audio, muted: !this.audio.muted };
    this.audioSession?.setMuted(this.audio.muted);
    this.emitAudio();
  }

  endAudioMinute(): void {
    if (this.audio.phase !== 'live' && this.audio.phase !== 'connecting') return;
    if (this.audioSession) {
      this.audioSession.end();
    } else {
      this.failAudio('The minute ended.');
    }
  }

  private async handleAudioRelay(
    fromId: string,
    message: Record<string, unknown>,
  ): Promise<void> {
    const kind = message.kind;
    const record =
      typeof message.rendezvousId === 'string'
        ? this.rendezvous.get(message.rendezvousId)
        : null;
    const human = record ? this.humans.get(record.peerId) : null;

    if (kind === 'audio/request') {
      if (
        !record ||
        !human ||
        human.id !== fromId ||
        typeof message.sessionId !== 'string' ||
        record.liveAudioDisabled ||
        record.audioWindowUsedAt ||
        !isHandoffEligible(record.scheduledFor)
      ) {
        this.sendAppMessage(
          fromId,
          {
            kind: 'audio/decline',
            rendezvousId: message.rendezvousId,
            sessionId: message.sessionId,
          },
          false,
        );
        return;
      }
      if (
        this.audio.phase === 'requesting' ||
        this.audio.phase === 'incoming' ||
        this.audio.phase === 'connecting' ||
        this.audio.phase === 'live'
      ) {
        this.sendAppMessage(
          fromId,
          {
            kind: 'audio/decline',
            rendezvousId: message.rendezvousId,
            sessionId: message.sessionId,
          },
          false,
        );
        return;
      }
      this.pendingAudioRequest = {
        rendezvousId: record.id,
        sessionId: message.sessionId,
        peerId: fromId,
        at: Date.now(),
      };
      this.audio = {
        ...IDLE_AUDIO,
        rendezvousId: record.id,
        peerId: fromId,
        peerName: record.peerName,
        phase: 'incoming',
        message: `${displayName(record.peerName)} asks for one live minute.`,
      };
      this.emitAudio();
      this.notice({
        tone: 'info',
        code: 'audio-declined',
        message: `${displayName(record.peerName)} asks for one minute of live voice. Nothing is recorded.`,
        humanId: fromId,
        rendezvousId: record.id,
      });
      return;
    }

    if (kind === 'audio/accept') {
      const request = this.outgoingAudioRequest;
      if (
        !request ||
        request.sessionId !== message.sessionId ||
        request.peerId !== fromId ||
        !record ||
        record.liveAudioDisabled
      ) {
        return;
      }
      this.outgoingAudioRequest = null;
      if (this.audioRequestTimer !== null) {
        window.clearTimeout(this.audioRequestTimer);
        this.audioRequestTimer = null;
      }
      await this.startAudioOffer(request);
      return;
    }

    if (kind === 'audio/decline') {
      if (this.outgoingAudioRequest?.sessionId === message.sessionId) {
        this.outgoingAudioRequest = null;
        if (this.audioRequestTimer !== null) {
          window.clearTimeout(this.audioRequestTimer);
          this.audioRequestTimer = null;
        }
        this.audio = {
          ...this.audio,
          phase: 'declined',
          message: 'The minute was declined. The photo handoff continues.',
        };
        this.emitAudio();
      }
      return;
    }

    if (kind === 'audio/failed') {
      if (
        this.outgoingAudioRequest?.sessionId === message.sessionId ||
        this.audioSessionId === message.sessionId
      ) {
        this.failAudio('The microphone could not be opened on the other browser.');
      }
    }
  }

  private async startAudioOffer(request: PendingAudioRequest): Promise<void> {
    this.audioClosing = false;
    const record = this.rendezvous.get(request.rendezvousId);
    const human = this.humans.get(request.peerId);
    const identity = this.identity;
    if (!record || !human || !identity || record.liveAudioDisabled) return;
    this.audioSessionId = request.sessionId;
    this.audioSessionPeer = request.peerId;
    this.audio = {
      ...this.audio,
      phase: 'connecting',
      message: 'Opening the microphone. Both browsers must prove their keys.',
    };
    this.emitAudio();
    try {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('This browser cannot use a microphone here.');
      }
      this.audioStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch {
      this.sendAppMessage(
        request.peerId,
        { kind: 'audio/failed', rendezvousId: request.rendezvousId, sessionId: request.sessionId },
        false,
      );
      this.failAudio('Microphone permission was denied. The photo handoff is unaffected.');
      return;
    }
    this.audioSession = new AudioSession({
      sessionId: request.sessionId,
      localPeerId: identity.id,
      remotePeerId: request.peerId,
      localPrivateKey: identity.privateKey,
      remotePublicKey: human.publicKey,
      iceServers: this.iceServers,
      stream: this.audioStream,
      offerer: true,
      sendSignal: (next) => this.sendRtc(request.peerId, request.sessionId, next),
      onRemoteStream: (remote) => this.attachRemoteAudio(remote),
      onBegan: (startedAt) => this.markAudioLive(startedAt),
      onRemoteMute: (muted) => {
        this.audio = { ...this.audio, remoteMuted: muted };
        this.emitAudio();
      },
      onEnded: (reason) => this.finishAudio(reason),
      onError: (message) => this.failAudio(message),
    });
    await this.audioSession.start();
  }

  private attachRemoteAudio(stream: MediaStream): void {
    this.audioRemoteStream = stream;
    if (typeof document === 'undefined') return;
    if (!this.remoteAudio) {
      const element = document.createElement('audio');
      element.autoplay = true;
      element.setAttribute('playsinline', '');
      element.hidden = true;
      this.remoteAudio = element;
      document.body.append(element);
    }
    this.remoteAudio.srcObject = stream;
    void this.remoteAudio.play().catch(() => {
      // A user gesture opened this window; if autoplay is still blocked the
      // controls stay visible so the person can retry.
    });
  }

  private markAudioLive(startedAt: number): void {
    const record = this.audioRecord();
    if (record) {
      record.audioWindowUsedAt = startedAt;
      void this.store.putRendezvous(record);
    }
    this.audio = {
      ...this.audio,
      phase: 'live',
      remainingMs: 60_000,
      message: null,
      muted: false,
      remoteMuted: false,
    };
    this.lastAudioSecond = 60;
    this.emitAudio();
  }

  private finishAudio(reason: string): void {
    if (this.audioClosing) return;
    const wasLive = this.audio.phase === 'live';
    this.audio = {
      ...this.audio,
      phase: 'ended',
      remainingMs: 0,
      message: reason,
    };
    this.audioSession = null;
    this.audioSessionId = null;
    this.audioSessionPeer = null;
    this.pendingAudioRequest = null;
    this.outgoingAudioRequest = null;
    if (this.audioStream) {
      for (const track of this.audioStream.getTracks()) track.stop();
      this.audioStream = null;
    }
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null;
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }
    this.audioRemoteStream = null;
    this.emitAudio();
    if (wasLive) {
      this.notice({
        tone: 'info',
        code: 'audio-ended',
        message: reason,
        humanId: this.audio.peerId ?? undefined,
        rendezvousId: this.audio.rendezvousId ?? undefined,
      });
    }
  }

  private failAudio(message: string): void {
    if (this.audioClosing) return;
    this.audio = { ...this.audio, phase: 'error', message };
    this.audioSession = null;
    this.audioSessionId = null;
    this.audioSessionPeer = null;
    this.pendingAudioRequest = null;
    this.outgoingAudioRequest = null;
    if (this.audioStream) {
      for (const track of this.audioStream.getTracks()) track.stop();
      this.audioStream = null;
    }
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null;
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }
    this.audioRemoteStream = null;
    this.emitAudio();
    this.notice({
      tone: 'warning',
      code: 'audio-error',
      message,
    });
  }

  private closeAudio(reason: string): void {
    this.audioClosing = true;
    const session = this.audioSession;
    this.audioSession = null;
    this.audioSessionId = null;
    this.audioSessionPeer = null;
    this.pendingAudioRequest = null;
    this.outgoingAudioRequest = null;
    if (this.audioRequestTimer !== null) {
      window.clearTimeout(this.audioRequestTimer);
      this.audioRequestTimer = null;
    }
    session?.close();
    if (this.audioStream) {
      for (const track of this.audioStream.getTracks()) track.stop();
      this.audioStream = null;
    }
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null;
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }
    this.audioRemoteStream = null;
    if (this.audio.phase !== 'idle') {
      this.audio = { ...this.audio, phase: 'ended', remainingMs: 0, message: reason };
      this.emitAudio();
    }
  }

  private updateAudioTick(): void {
    if (this.audio.phase !== 'live' || !this.audioSession) return;
    const remaining = this.audioSession.remainingMs;
    const seconds = Math.ceil(remaining / 1_000);
    this.audio = { ...this.audio, remainingMs: remaining };
    if (seconds !== this.lastAudioSecond) {
      this.lastAudioSecond = seconds;
      this.emitAudio();
    }
  }

  private possessionViews(): PossessionView[] {
    return [...this.possessions.values()]
      .map((entry) => {
        const human = this.humans.get(entry.holder);
        return {
          ...entry,
          online: Boolean(human?.online),
          connected: Boolean(human),
          confirmedNow: this.confirmedPossessionChecks.has(entry.key),
        };
      })
      .sort((a, b) => {
        const photo = a.photoId.localeCompare(b.photoId);
        return photo !== 0 ? photo : a.holder.localeCompare(b.holder);
      });
  }

  /** Owner-only inventory for one photo, or every tracked photo. */
  getPossessionInventory(photoId?: string): PossessionView[] {
    const all = this.possessionViews();
    return photoId ? all.filter((entry) => entry.photoId === photoId) : all;
  }

  private async claimPhoto(record: StoredRendezvous, photoId: string): Promise<void> {
    const identity = this.identity;
    if (!identity) return;
    const message = await createPossessionMessage({
      privateKey: identity.privateKey,
      kind: 'possess/claim',
      photoId,
      from: identity.id,
      to: record.peerId,
      appointmentId: record.id,
    });
    this.sendAppMessage(record.peerId, message, true);
  }

  private async releasePhoto(print: StoredPrint): Promise<void> {
    const identity = this.identity;
    if (!identity) return;
    const message = await createPossessionMessage({
      privateKey: identity.privateKey,
      kind: 'possess/release',
      photoId: print.photoId,
      from: identity.id,
      to: print.peerId,
      appointmentId: print.appointmentId,
    });
    this.sendAppMessage(print.peerId, message, true);
  }

  /** Ask every connected holder for a fresh signed claim or release. */
  async requestPossessionCheck(photoId: string, holder?: string): Promise<number> {
    const identity = this.identity;
    if (!identity) return 0;
    const targets = [...this.possessions.values()].filter(
      (entry) =>
        entry.photoId === photoId &&
        entry.state === 'held' &&
        (!holder || entry.holder === holder) &&
        this.humans.get(entry.holder)?.online,
    );
    for (const entry of targets) {
      const message = await createPossessionMessage({
        privateKey: identity.privateKey,
        kind: 'possess/check',
        photoId,
        from: identity.id,
        to: entry.holder,
        appointmentId: entry.appointmentId,
      });
      this.confirmedPossessionChecks.delete(entry.key);
      entry.checkedAt = Date.now();
      await this.store.putPossession(entry);
      this.sendAppMessage(entry.holder, message, false);
    }
    if (targets.length > 0) this.emitState();
    return targets.length;
  }

  private async handleAppMessage(fromId: string, message: unknown): Promise<void> {
    if (isPossessionMessage(message)) {
      await this.handlePossessionMessage(fromId, message);
      return;
    }
    if (!message || typeof message !== 'object') return;
    const kind = (message as { kind?: unknown }).kind;
    if (typeof kind === 'string' && kind.startsWith('audio/')) {
      await this.handleAudioRelay(fromId, message as Record<string, unknown>);
    }
  }

  private async handlePossessionMessage(
    fromId: string,
    message: PossessionMessage,
  ): Promise<void> {
    const identity = this.identity;
    if (!identity || message.from !== fromId || message.to !== identity.id) return;
    const human = this.humans.get(fromId);
    if (!human) return;
    if (!(await verifyPossessionMessage(human.publicKey, message))) return;

    if (message.kind === 'possess/check') {
      const copies = [...this.prints.values()].filter(
        (print) => print.photoId === message.photoId,
      );
      const held = copies[0] ?? null;
      const reply = await createPossessionMessage({
        privateKey: identity.privateKey,
        kind: held ? 'possess/claim' : 'possess/release',
        photoId: message.photoId,
        from: identity.id,
        to: fromId,
        appointmentId: held?.appointmentId ?? message.appointmentId,
        at: Math.max(Date.now(), message.at + 1),
      });
      this.sendAppMessage(fromId, reply, true);
      return;
    }

    const state = possessionState(message);
    if (!state) return;
    const owned =
      [...this.prints.values()].some(
        (print) => print.photoId === message.photoId && print.direction === 'outgoing',
      ) ||
      [...this.rendezvous.values()].some(
        (record) =>
          record.direction === 'outgoing' &&
          record.photo?.photoId === message.photoId,
      );
    if (!owned) return;
    const key = possessionKey(message.photoId, fromId);
    const previous = this.possessions.get(key);
    const sameCopy =
      previous?.state === 'held' &&
      previous.appointmentId === message.appointmentId;
    const copies =
      state === 'released'
        ? previous?.copies ?? 1
        : sameCopy
          ? previous.copies
          : previous?.state === 'held'
            ? previous.copies + 1
            : 1;
    const next: StoredPossession = {
      key,
      photoId: message.photoId,
      holder: fromId,
      state,
      at: message.at,
      appointmentId: message.appointmentId,
      updatedAt: Date.now(),
      checkedAt: previous?.checkedAt ?? null,
      copies,
    };
    if (!newerPossession(previous, next)) return;
    this.possessions.set(key, next);
    await this.store.putPossession(next);
    if (next.checkedAt !== null && message.at >= next.checkedAt) {
      this.confirmedPossessionChecks.add(key);
    }
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
