import { mergeRecords } from './merge';
import { deriveMemberView } from './membership';
import { compareStrings } from './canonical';
import type {
  CircleConfig,
  CircleConfigInput,
  CircleId,
  CircleStore,
  CircleSyncMessage,
  Friends,
  Identity,
  MemberOverride,
  MemberView,
  PeerChannel,
  PublicKeyId,
  StoredCircleRecord,
} from './types';
import { isCircleScopedRecord } from './types';

const MAX_RECORDS_PER_MESSAGE = 100;

export interface RecordsMergedEvent {
  circleId: CircleId;
  peerKey: PublicKeyId;
  added: StoredCircleRecord[];
}

export interface CircleSyncOptions {
  identity: Identity;
  friends: Friends;
  store: CircleStore;
  /**
   * Local overrides per circle. They are never sent; they only decide which
   * circles/records this browser is willing to sync.
   */
  overrides?: Readonly<
    Record<CircleId, Readonly<Record<PublicKeyId, MemberOverride>>>
  >;
  config?: CircleConfigInput | CircleConfig;
  /** Optional host-computed view, e.g. one cached by the UI. */
  viewFor?: (circleId: CircleId) => Promise<MemberView> | MemberView;
  onRecords?: (event: RecordsMergedEvent) => void | Promise<void>;
  onError?: (error: unknown, peerKey: PublicKeyId, message: unknown) => void;
}

export interface RecordPolicyInput {
  entry: StoredCircleRecord;
  circleId: CircleId;
  peerKey: PublicKeyId;
  identity: Identity;
  friends: Friends;
  view: MemberView;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((item) => typeof item === 'string' && item.length > 0)) return null;
  return [...new Set(value)].sort(compareStrings);
}

function participants(entry: StoredCircleRecord): PublicKeyId[] {
  const record = entry.record;
  if (record.type === 'Plan') return [record.organizer, ...record.invitees];
  if (record.type === 'Attendance') return [record.attendee, ...record.swappedWith];
  return [];
}

function inCircleParticipants(entry: StoredCircleRecord, view: MemberView): number {
  return new Set(participants(entry).filter((key) => view.members.includes(key))).size;
}

/**
 * Outgoing policy:
 * - BanVote: author only, direct friends only, never the target, never relayed.
 * - Plan/Attendance: direct friends only, and only where at least two current
 *   attendees are members of that circle.
 * - Membership records: normal shared-circle sync.
 */
export function canSendRecord(input: RecordPolicyInput): boolean {
  const { entry, circleId, peerKey, identity, friends, view } = input;
  const record = entry.record;
  const direct = friends.directFriends().has(peerKey);

  if (record.type === 'BanVote') {
    return (
      record.circleId === circleId &&
      record.voter === identity.selfKey &&
      direct &&
      record.target !== peerKey
    );
  }

  if (record.type === 'Plan' || record.type === 'Attendance') {
    return direct && inCircleParticipants(entry, view) >= 2;
  }

  return !isCircleScopedRecord(record) || record.circleId === circleId;
}

/**
 * Incoming mirror of the outgoing policy. A relayed BanVote is ignored even if
 * its signature is valid; Plan/Attendance gossip is accepted only from a
 * direct friend and only when two current circle members are involved.
 */
export function canAcceptRecord(
  input: Omit<RecordPolicyInput, 'identity'> & { selfKey: PublicKeyId },
): boolean {
  const { entry, circleId, peerKey, friends, view, selfKey } = input;
  const record = entry.record;
  const direct = friends.directFriends().has(peerKey);

  if (record.type === 'BanVote') {
    return (
      record.circleId === circleId &&
      record.voter === peerKey &&
      direct &&
      record.target !== selfKey &&
      record.target !== peerKey
    );
  }

  if (record.type === 'Plan' || record.type === 'Attendance') {
    return direct && inCircleParticipants(entry, view) >= 2;
  }

  return true;
}

interface PeerState {
  channel: PeerChannel;
  peerKey: PublicKeyId;
  shared: Set<CircleId>;
  helloReceived: boolean;
  pending: unknown[];
  sentHave: Set<CircleId>;
  unsubscribe: () => void;
}

/**
 * Grow-only circle synchronisation over an already authenticated direct peer
 * channel. Messages are idempotent; the store and merge layer absorb duplicate
 * and out-of-order delivery.
 */
export class CircleSync {
  private readonly options: CircleSyncOptions;
  private readonly peers = new Map<PublicKeyId, PeerState>();
  private readonly chains = new Map<PublicKeyId, Promise<void>>();
  private started = false;
  private stopped = false;

  constructor(options: CircleSyncOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const peerKey of this.peers.keys()) {
      try {
        await this.sendHello(peerKey);
      } catch (error) {
        this.report(error, peerKey, { type: 'circle-sync/hello' });
      }
    }
  }

  addPeer(channel: PeerChannel): () => void {
    if (this.stopped) return () => {};
    const peerKey = channel.peerKey;
    const existing = this.peers.get(peerKey);
    existing?.unsubscribe();

    const state: PeerState = {
      channel,
      peerKey,
      shared: new Set(),
      helloReceived: false,
      pending: [],
      sentHave: new Set(),
      unsubscribe: () => {},
    };
    state.unsubscribe = channel.onMessage((message) =>
      this.enqueue(peerKey, message),
    );
    this.peers.set(peerKey, state);
    if (this.started) {
      void this.sendHello(peerKey).catch((error) =>
        this.report(error, peerKey, { type: 'circle-sync/hello' }),
      );
    }

    return () => {
      state.unsubscribe();
      if (this.peers.get(peerKey) === state) this.peers.delete(peerKey);
    };
  }

  removePeer(peerKey: PublicKeyId): void {
    const state = this.peers.get(peerKey);
    if (!state) return;
    state.unsubscribe();
    this.peers.delete(peerKey);
  }

  stop(): void {
    this.stopped = true;
    for (const state of this.peers.values()) state.unsubscribe();
    this.peers.clear();
    this.chains.clear();
  }

  /** Wait for all currently queued peer messages to finish. */
  async whenIdle(): Promise<void> {
    while (this.chains.size > 0) {
      await Promise.allSettled([...this.chains.values()]);
    }
  }

  /** Ask every connected peer for a fresh id exchange (e.g. after new data). */
  async refresh(): Promise<void> {
    for (const peerKey of this.peers.keys()) {
      await this.sendHello(peerKey);
    }
  }

  private enqueue(peerKey: PublicKeyId, message: unknown): Promise<void> {
    const previous = this.chains.get(peerKey) ?? Promise.resolve();
    const next = previous
      .then(() => this.handleMessage(peerKey, message))
      .catch((error: unknown) => {
        this.report(error, peerKey, message);
      });
    this.chains.set(peerKey, next);
    void next.finally(() => {
      if (this.chains.get(peerKey) === next) this.chains.delete(peerKey);
    });
    return next;
  }

  private report(error: unknown, peerKey: PublicKeyId, message: unknown): void {
    try {
      this.options.onError?.(error, peerKey, message);
    } catch {
      // State reporting must never break message processing.
    }
  }

  private async send(state: PeerState, message: CircleSyncMessage): Promise<void> {
    try {
      await Promise.resolve(state.channel.send(message));
    } catch (error) {
      this.report(error, state.peerKey, message);
    }
  }

  private async sendHello(peerKey: PublicKeyId): Promise<void> {
    const state = this.peers.get(peerKey);
    if (!state || this.stopped) return;
    let circles: CircleId[];
    try {
      circles = await this.localCircles(peerKey);
    } catch (error) {
      this.report(error, peerKey, { type: 'circle-sync/hello' });
      return;
    }
    await this.send(state, { type: 'circle-sync/hello', circles });
  }

  private overridesFor(circleId: CircleId): Readonly<Record<PublicKeyId, MemberOverride>> {
    return this.options.overrides?.[circleId] ?? {};
  }

  private async viewFor(circleId: CircleId): Promise<MemberView> {
    if (this.options.viewFor) return this.options.viewFor(circleId);
    const records = await this.options.store.load(circleId);
    return deriveMemberView(
      records,
      this.options.identity.selfKey,
      this.options.friends,
      this.overridesFor(circleId),
      { ...this.options.config, circleId },
    );
  }

  /**
   * Circles where I am a member and the peer is a current, non-banned member
   * in my view. The peer's hello carries the same meaning from its side, so an
   * intersection means both views agree.
   */
  private async localCircles(peerKey: PublicKeyId): Promise<CircleId[]> {
    const circles = await this.options.store.listCircles();
    const result: CircleId[] = [];
    for (const circleId of circles) {
      try {
        const view = await this.viewFor(circleId);
        if (
          peerKey !== this.options.identity.selfKey &&
          view.members.includes(this.options.identity.selfKey) &&
          view.members.includes(peerKey) &&
          !view.banned.includes(peerKey)
        ) {
          result.push(circleId);
        }
      } catch (error) {
        this.report(error, peerKey, { circleId });
      }
    }
    return [...new Set(result)].sort(compareStrings);
  }

  private async sendRecords(
    state: PeerState,
    circleId: CircleId,
    records: readonly StoredCircleRecord[],
  ): Promise<void> {
    for (let index = 0; index < records.length; index += MAX_RECORDS_PER_MESSAGE) {
      await this.send(state, {
        type: 'circle-sync/records',
        circleId,
        records: records.slice(index, index + MAX_RECORDS_PER_MESSAGE),
      });
    }
  }

  private async sendHave(state: PeerState, circleId: CircleId, force = false): Promise<void> {
    if (!force && state.sentHave.has(circleId)) return;
    state.sentHave.add(circleId);
    const view = await this.viewFor(circleId);
    const records = await this.options.store.load(circleId);
    const ids = records
      .filter((entry) =>
        canSendRecord({
          entry,
          circleId,
          peerKey: state.peerKey,
          identity: this.options.identity,
          friends: this.options.friends,
          view,
        }),
      )
      .map((entry) => entry.id)
      .sort(compareStrings);
    await this.send(state, { type: 'circle-sync/have', circleId, ids });
  }

  private async handleMessage(peerKey: PublicKeyId, message: unknown): Promise<void> {
    const state = this.peers.get(peerKey);
    if (!state || this.stopped || !isObject(message)) return;
    const type = message.type;

    if (type === 'circle-sync/hello') {
      const circles = stringArray(message.circles);
      if (!circles) return;
      state.helloReceived = true;
      const mine = new Set(await this.localCircles(peerKey));
      const shared = circles.filter((circleId) => mine.has(circleId));
      state.shared = new Set(shared);
      for (const circleId of shared) {
        await this.sendHave(state, circleId, true);
      }
      const pending = state.pending;
      state.pending = [];
      for (const queued of pending) {
        await this.handleMessage(peerKey, queued);
      }
      return;
    }

    if (!state.helloReceived) {
      state.pending.push(message);
      return;
    }

    const circleId = message.circleId;
    if (typeof circleId !== 'string' || !state.shared.has(circleId)) return;

    if (type === 'circle-sync/have') {
      const ids = stringArray(message.ids);
      if (!ids) return;
      if (!state.sentHave.has(circleId)) {
        await this.sendHave(state, circleId);
      }
      const remote = new Set(ids);
      const view = await this.viewFor(circleId);
      const records = await this.options.store.load(circleId);
      const missing = records
        .filter(
          (entry) =>
            !remote.has(entry.id) &&
            canSendRecord({
              entry,
              circleId,
              peerKey,
              identity: this.options.identity,
              friends: this.options.friends,
              view,
            }),
        )
        .sort((a, b) => compareStrings(a.id, b.id));
      await this.sendRecords(state, circleId, missing);
      return;
    }

    if (type === 'circle-sync/request') {
      const ids = stringArray(message.ids);
      if (!ids) return;
      const wanted = new Set(ids);
      const view = await this.viewFor(circleId);
      const records = await this.options.store.load(circleId);
      const selected = records.filter(
        (entry) =>
          wanted.has(entry.id) &&
          canSendRecord({
            entry,
            circleId,
            peerKey,
            identity: this.options.identity,
            friends: this.options.friends,
            view,
          }),
      );
      await this.sendRecords(state, circleId, selected);
      return;
    }

    if (type === 'circle-sync/records') {
      if (!Array.isArray(message.records)) return;
      const view = await this.viewFor(circleId);
      const accepted = (message.records as unknown[])
        .filter(
          (entry): entry is StoredCircleRecord =>
            isObject(entry) &&
            typeof entry.id === 'string' &&
            isObject(entry.record),
        )
        .filter((entry) =>
          canAcceptRecord({
            entry,
            circleId,
            peerKey,
            friends: this.options.friends,
            view,
            selfKey: this.options.identity.selfKey,
          }),
        );
      if (accepted.length === 0) return;
      const existing = await this.options.store.load(circleId);
      const merged = await mergeRecords(this.options.identity, existing, accepted, {
        circleId,
      });
      if (merged.added.length > 0) {
        await this.options.store.append(circleId, merged.added);
        await this.options.onRecords?.({
          circleId,
          peerKey,
          added: merged.added,
        });
      }
      return;
    }

    // circle-sync/done is informational; no acknowledgement is required.
  }
}
