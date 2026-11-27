/**
 * Public, serialisable types for the circle-stats module.
 *
 * A circle is a grow-only set of signed records. Records themselves never
 * contain an id: the id is derived from the canonical encoding and kept beside
 * the record in a {@link StoredCircleRecord}. Keeping the id outside the
 * record avoids a circular hash while still letting every peer reject an id
 * that does not match the content it received.
 */

export type PublicKeyId = string;
export type CircleId = string;
export type RendezvousId = string;
export type MemberOverride = 'keep' | 'ban';

export interface CircleCreatedRecord {
  type: 'CircleCreated';
  circleId: CircleId;
  name: string;
  /** IANA timezone, for example "Europe/Berlin". */
  timezone: string;
  creator: PublicKeyId;
  createdAt: number;
  sig: string;
}

export interface InviteRecord {
  type: 'Invite';
  circleId: CircleId;
  invitee: PublicKeyId;
  inviter: PublicKeyId;
  at: number;
  sig: string;
}

export interface JoinRecord {
  type: 'Join';
  circleId: CircleId;
  member: PublicKeyId;
  at: number;
  sig: string;
}

/**
 * A bearer membership grant carried inside a circle rendezvous link. Unlike an
 * Invite, it is not addressed to one key: any browser that opens the link may
 * sign a Join until `expiresAt`. The inviter must be a valid member at both the
 * grant and the join. It carries no media.
 */
export interface LinkInviteRecord {
  type: 'LinkInvite';
  circleId: CircleId;
  inviter: PublicKeyId;
  /** The circle offer this link belongs to, or null for a membership-only link. */
  planId: string | null;
  at: number;
  expiresAt: number;
  sig: string;
}

export interface LeaveRecord {
  type: 'Leave';
  circleId: CircleId;
  member: PublicKeyId;
  at: number;
  sig: string;
}

export interface BanVoteRecord {
  type: 'BanVote';
  circleId: CircleId;
  voter: PublicKeyId;
  target: PublicKeyId;
  vote: 'ban' | 'unban';
  at: number;
  sig: string;
}

/**
 * Plans are scoped to one circle. Canonicality is one plan per circle and
 * local calendar day, chosen by signed `createdAt` and then record id.
 */
export interface PlanRecord {
  type: 'Plan';
  circleId: CircleId;
  rendezvousId: RendezvousId;
  scheduledAt: number;
  organizer: PublicKeyId;
  /** Strictly ascending public-key ids. */
  invitees: PublicKeyId[];
  createdAt: number;
  sig: string;
}

/** One member choosing to join a circle rendezvous offer. */
export interface PlanJoinRecord {
  type: 'PlanJoin';
  circleId: CircleId;
  planId: string;
  member: PublicKeyId;
  at: number;
  sig: string;
}

/** An optional inclusive scheduling window for a circle. */
export interface WindowRecord {
  type: 'Window';
  circleId: CircleId;
  start: number;
  end: number;
  author: PublicKeyId;
  createdAt: number;
  sig: string;
}

/** A later clear marker removes the window for plans signed after it. */
export interface WindowClearRecord {
  type: 'WindowClear';
  circleId: CircleId;
  author: PublicKeyId;
  createdAt: number;
  sig: string;
}

export interface AttendanceRecord {
  type: 'Attendance';
  rendezvousId: RendezvousId;
  scheduledAt: number;
  attendee: PublicKeyId;
  /** The attendee's local clock when the swap completed. */
  joinedAt: number;
  /** Strictly ascending public-key ids. */
  swappedWith: PublicKeyId[];
  promptId: string | null;
  sig: string;
}

export type CircleRecord =
  | CircleCreatedRecord
  | InviteRecord
  | JoinRecord
  | LeaveRecord
  | LinkInviteRecord
  | BanVoteRecord
  | PlanRecord
  | PlanJoinRecord
  | WindowRecord
  | WindowClearRecord
  | AttendanceRecord;

export type CircleRecordType = CircleRecord['type'];

type WithoutSignature<T> = T extends unknown ? Omit<T, 'sig'> : never;

/** An input to {@link import('./canonical').signRecord}. */
export type UnsignedCircleRecord = WithoutSignature<CircleRecord>;

/** A signed record together with its content-derived id. */
export interface StoredCircleRecord {
  id: string;
  record: CircleRecord;
}

export function isCircleScopedRecord(
  record: CircleRecord,
): record is
  | CircleCreatedRecord
  | InviteRecord
  | JoinRecord
  | LeaveRecord
  | LinkInviteRecord
  | BanVoteRecord
  | PlanRecord
  | PlanJoinRecord
  | WindowRecord
  | WindowClearRecord {
  return (
    record.type === 'CircleCreated' ||
    record.type === 'Invite' ||
    record.type === 'Join' ||
    record.type === 'Leave' ||
    record.type === 'LinkInvite' ||
    record.type === 'BanVote' ||
    record.type === 'Plan' ||
    record.type === 'PlanJoin' ||
    record.type === 'Window' ||
    record.type === 'WindowClear'
  );
}

export function isRendezvousRecord(
  record: CircleRecord,
): record is PlanRecord | AttendanceRecord {
  return record.type === 'Plan' || record.type === 'Attendance';
}

export function recordAuthor(record: CircleRecord): PublicKeyId {
  switch (record.type) {
    case 'CircleCreated':
      return record.creator;
    case 'Invite':
    case 'LinkInvite':
      return record.inviter;
    case 'Join':
    case 'Leave':
      return record.member;
    case 'BanVote':
      return record.voter;
    case 'Plan':
      return record.organizer;
    case 'PlanJoin':
      return record.member;
    case 'Window':
    case 'WindowClear':
      return record.author;
    case 'Attendance':
      return record.attendee;
  }
}

/** Timestamp used for "as of last sync". */
export function recordTimestamp(record: CircleRecord): number {
  switch (record.type) {
    case 'CircleCreated':
      return record.createdAt;
    case 'Invite':
    case 'Join':
    case 'Leave':
    case 'LinkInvite':
    case 'BanVote':
      return record.at;
    case 'Plan':
      return record.createdAt;
    case 'PlanJoin':
      return record.at;
    case 'Window':
    case 'WindowClear':
      return record.createdAt;
    case 'Attendance':
      return record.joinedAt;
  }
}

/** Smallest useful injectable surface around the host app's long-term key. */
export interface Identity {
  /** The local long-term peer/public-key id. */
  selfKey: PublicKeyId;
  sign(bytes: Uint8Array): Promise<string>;
  /**
   * Verify a signature by a peer id. The host identity owns the peer-id to
   * public-key directory (pinned humans, invitees, and circle members).
   */
  verify(publicKeyId: PublicKeyId, bytes: Uint8Array, signature: string): Promise<boolean>;
  hash(bytes: Uint8Array): Promise<string>;
}

/** My direct, persistent connections only. */
export interface Friends {
  directFriends(): Set<PublicKeyId>;
}

/**
 * Persistence boundary. Implementations are expected to act as a set: append
 * is idempotent for records that are already present.
 */
export interface CircleStore {
  load(circleId: CircleId): Promise<StoredCircleRecord[]>;
  append(circleId: CircleId, records: readonly StoredCircleRecord[]): Promise<void>;
  /** Remove records that a later cross-record rule invalidated. */
  remove?(circleId: CircleId, ids: readonly string[]): Promise<void>;
  listCircles(): Promise<CircleId[]>;
}

export interface PeerChannel {
  /** The peer at the other end of this authenticated channel. */
  peerKey: PublicKeyId;
  send(message: unknown): void | Promise<void>;
  onMessage(handler: (message: unknown) => void | Promise<void>): () => void;
}

export interface Prompt {
  id: string;
  text: string;
}

export interface CircleTargets {
  /** Current-calendar-month kept rendezvous, after the weekly pair cap. */
  monthlyKept: number;
  /** Consecutive active days, ending today or yesterday. */
  dailyRun: number;
}

export interface CircleConfig {
  /** Optional circle id; when absent, records must describe one circle. */
  circleId?: CircleId;
  /** The normal on-time window on either side of the scheduled instant. */
  windowMs: number;
  /** Extra allowance for clock disagreement. */
  skewMs: number;
  /** A pair may carry at most this many counted rendezvous per week. */
  pairCapPerWeek: number;
  targets: CircleTargets;
  /** All-time next-goal ladder. */
  milestones: readonly number[];
  /** Eligible-friend count -> votes required. */
  banThreshold: (eligibleFriendCount: number) => number;
}

export interface CircleConfigInput {
  circleId?: CircleId;
  windowMs?: number;
  skewMs?: number;
  pairCapPerWeek?: number;
  targets?: Partial<CircleTargets>;
  milestones?: readonly number[];
  banThreshold?: (eligibleFriendCount: number) => number;
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DEFAULT_WINDOW_MS = 5 * MINUTE_MS;
export const DEFAULT_SKEW_MS = 30_000;
export const DEFAULT_PAIR_CAP_PER_WEEK = 3;
export const DEFAULT_MONTHLY_KEPT_TARGET = 20;
export const DEFAULT_DAILY_RUN_TARGET = 14;
export const DEFAULT_MILESTONES = [100, 250, 500, 1000] as const;

export function defaultBanThreshold(eligibleFriendCount: number): number {
  return Math.max(2, Math.floor(eligibleFriendCount / 2) + 1);
}

export const DEFAULT_CIRCLE_CONFIG: CircleConfig = Object.freeze({
  windowMs: DEFAULT_WINDOW_MS,
  skewMs: DEFAULT_SKEW_MS,
  pairCapPerWeek: DEFAULT_PAIR_CAP_PER_WEEK,
  targets: Object.freeze({
    monthlyKept: DEFAULT_MONTHLY_KEPT_TARGET,
    dailyRun: DEFAULT_DAILY_RUN_TARGET,
  }),
  milestones: DEFAULT_MILESTONES,
  banThreshold: defaultBanThreshold,
});

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

export function resolveCircleConfig(input: CircleConfigInput = {}): CircleConfig {
  const windowMs = input.windowMs ?? DEFAULT_CIRCLE_CONFIG.windowMs;
  const skewMs = input.skewMs ?? DEFAULT_CIRCLE_CONFIG.skewMs;
  const pairCapPerWeek = input.pairCapPerWeek ?? DEFAULT_CIRCLE_CONFIG.pairCapPerWeek;
  assertNonNegativeInteger('windowMs', windowMs);
  assertNonNegativeInteger('skewMs', skewMs);
  assertNonNegativeInteger('pairCapPerWeek', pairCapPerWeek);
  if (pairCapPerWeek < 1) throw new Error('pairCapPerWeek must be at least 1');

  const targets = {
    monthlyKept: input.targets?.monthlyKept ?? DEFAULT_CIRCLE_CONFIG.targets.monthlyKept,
    dailyRun: input.targets?.dailyRun ?? DEFAULT_CIRCLE_CONFIG.targets.dailyRun,
  };
  assertNonNegativeInteger('targets.monthlyKept', targets.monthlyKept);
  assertNonNegativeInteger('targets.dailyRun', targets.dailyRun);
  if (targets.monthlyKept < 1 || targets.dailyRun < 1) {
    throw new Error('targets must be at least 1');
  }

  const milestones = [...(input.milestones ?? DEFAULT_CIRCLE_CONFIG.milestones)];
  if (milestones.length === 0) throw new Error('milestones must not be empty');
  let previous = 0;
  for (const milestone of milestones) {
    assertNonNegativeInteger('milestone', milestone);
    if (milestone <= previous) {
      throw new Error('milestones must be strictly ascending positive integers');
    }
    previous = milestone;
  }

  const banThreshold = input.banThreshold ?? DEFAULT_CIRCLE_CONFIG.banThreshold;
  const baseline = banThreshold(2);
  if (!Number.isSafeInteger(baseline) || baseline < 1) {
    throw new Error('banThreshold must return a positive integer');
  }

  return {
    ...(input.circleId !== undefined ? { circleId: input.circleId } : {}),
    windowMs,
    skewMs,
    pairCapPerWeek,
    targets,
    milestones,
    banThreshold,
  };
}

export interface Stat {
  value: number;
  target: number;
  /** Clamped to [0, 1]. */
  ratio: number;
}

export interface MonthlyKeptStat extends Stat {
  /** Number of kept rendezvous in the current month that passed the cap. */
  counted: number;
  pairCapPerWeek: number;
}

export interface WeeklyParticipationStat extends Stat {
  activeMembers: number;
  memberCount: number;
}

export interface SeasonPairsStat extends Stat {
  activePairs: number;
  totalPairs: number;
}

export interface DailyRunStat extends Stat {
  longestRun: number;
  /** "YYYY-MM-DD" in the circle timezone. */
  today: string;
}

export interface PromptStats extends Stat {
  dayPrompt: Prompt;
  weekPrompt: Prompt;
  dayCount: number;
  weekCount: number;
  weekMembers: number;
}

export interface AllTimeStat extends Stat {
  /** The next goal; equals the last goal once the ladder is complete. */
  nextMilestone: number;
  /** True when value has reached the final milestone. */
  complete: boolean;
}

export interface CircleStats {
  circleId: CircleId;
  name: string;
  timezone: string;
  /** Latest record timestamp considered in this view, or null for no records. */
  asOf: number | null;
  memberCount: number;
  bannedCount: number;
  monthlyKept: MonthlyKeptStat;
  weeklyParticipation: WeeklyParticipationStat;
  seasonPairs: SeasonPairsStat;
  dailyRun: DailyRunStat;
  promptStats: PromptStats;
  allTime: AllTimeStat;
}

export interface MemberView {
  circleId: CircleId;
  name: string;
  timezone: string;
  selfKey: PublicKeyId;
  creator: PublicKeyId | null;
  members: PublicKeyId[];
  banned: PublicKeyId[];
  /** Current, non-banned members who are not direct friends. */
  unconnectedToYou: PublicKeyId[];
  shouldAcceptConnection(circleId: CircleId, peerKey: PublicKeyId): boolean;
}

export interface KeptPair {
  rendezvousId: RendezvousId;
  scheduledAt: number;
  a: PublicKeyId;
  b: PublicKeyId;
}

export interface NtpSample {
  /** Client send time. */
  t1: number;
  /** Server receive time. */
  t2: number;
  /** Server send time. */
  t3: number;
  /** Client receive time. */
  t4: number;
}

export interface ClockEstimate {
  offsetMs: number;
  delayMs: number;
  samples: number;
}

export type CircleSyncMessage =
  | {
      type: 'circle-sync/hello';
      /** Circle ids where the sender is a current member, sorted. */
      circles: CircleId[];
    }
  | {
      type: 'circle-sync/have';
      circleId: CircleId;
      /** Ids the sender is willing to share with this peer, sorted. */
      ids: string[];
    }
  | {
      type: 'circle-sync/request';
      circleId: CircleId;
      ids: string[];
    }
  | {
      type: 'circle-sync/records';
      circleId: CircleId;
      records: StoredCircleRecord[];
    }
  | {
      type: 'circle-sync/done';
      circleId: CircleId;
    };
