import { compareStrings } from './canonical';
import type {
  CircleConfig,
  CircleConfigInput,
  CircleId,
  CircleRecord,
  Friends,
  MemberOverride,
  MemberView,
  PublicKeyId,
  StoredCircleRecord,
} from './types';
import { isCircleScopedRecord, resolveCircleConfig } from './types';

export interface CircleMetadata {
  circleId: CircleId;
  name: string;
  timezone: string;
  creator: PublicKeyId;
  createdAt: number;
  recordId: string;
}

/**
 * Pick the canonical creation for a circle. Circle ids are random and globally
 * unique; if a malformed/duplicate creation is present, the earliest by
 * (createdAt, creator, name, timezone) wins deterministically.
 */
export function resolveCircleMetadata(
  records: readonly StoredCircleRecord[],
  circleId?: CircleId,
): CircleMetadata | null {
  const creations = records
    .filter(
      (entry) =>
        entry.record.type === 'CircleCreated' &&
        (circleId === undefined || entry.record.circleId === circleId),
    )
    .sort((a, b) => {
      const first = a.record;
      const second = b.record;
      if (first.type !== 'CircleCreated' || second.type !== 'CircleCreated') return 0;
      if (first.createdAt !== second.createdAt) return first.createdAt - second.createdAt;
      const creator = compareStrings(first.creator, second.creator);
      if (creator !== 0) return creator;
      const name = compareStrings(first.name, second.name);
      if (name !== 0) return name;
      const timezone = compareStrings(first.timezone, second.timezone);
      if (timezone !== 0) return timezone;
      return compareStrings(a.id, b.id);
    });

  const first = creations[0];
  if (!first || first.record.type !== 'CircleCreated') return null;
  return {
    circleId: first.record.circleId,
    name: first.record.name,
    timezone: first.record.timezone,
    creator: first.record.creator,
    createdAt: first.record.createdAt,
    recordId: first.id,
  };
}

interface Interval {
  start: number;
  end: number | null;
}

interface TimedRecord {
  at: number;
  id: string;
  order: number;
  record: CircleRecord;
}

function timedRecords(records: readonly StoredCircleRecord[], circleId: CircleId): TimedRecord[] {
  const result: TimedRecord[] = [];
  for (const entry of records) {
    const record = entry.record;
    if (!isCircleScopedRecord(record) || record.circleId !== circleId) continue;
    if (record.type === 'Invite' || record.type === 'Join' || record.type === 'Leave') {
      result.push({
        at: record.at,
        id: entry.id,
        order: record.type === 'Leave' ? 0 : 1,
        record,
      });
    }
  }
  return result.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    if (a.order !== b.order) return a.order - b.order;
    return compareStrings(a.id, b.id);
  });
}

interface ChainResult {
  current: Set<PublicKeyId>;
  intervals: Map<PublicKeyId, Interval[]>;
}

function deriveChain(
  records: readonly StoredCircleRecord[],
  circle: CircleMetadata,
): ChainResult {
  const intervals = new Map<PublicKeyId, Interval[]>();
  const current = new Set<PublicKeyId>();

  const open = (member: PublicKeyId, at: number): void => {
    const list = intervals.get(member) ?? [];
    list.push({ start: at, end: null });
    intervals.set(member, list);
    current.add(member);
  };

  const close = (member: PublicKeyId, at: number): void => {
    const list = intervals.get(member);
    const last = list?.[list.length - 1];
    if (!last || last.end !== null) return;
    last.end = at;
    current.delete(member);
  };

  const wasValidAt = (member: PublicKeyId, at: number): boolean => {
    const list = intervals.get(member);
    if (!list) return false;
    return list.some(
      (interval) =>
        interval.start <= at && (interval.end === null || interval.end > at),
    );
  };

  open(circle.creator, circle.createdAt);

  const events = timedRecords(records, circle.circleId).filter(
    (event) => event.at >= circle.createdAt,
  );
  const invites = events
    .filter((event) => event.record.type === 'Invite')
    .map((event) => ({
      entryId: event.id,
      record: event.record as Extract<CircleRecord, { type: 'Invite' }>,
    }))
    .sort((a, b) => {
      if (a.record.at !== b.record.at) return a.record.at - b.record.at;
      return compareStrings(a.entryId, b.entryId);
    });

  for (const event of events) {
    if (event.record.type === 'Leave') {
      close(event.record.member, event.record.at);
      continue;
    }
    if (event.record.type !== 'Join') continue;

    const join = event.record;
    if (current.has(join.member)) continue;

    const invitation = invites.find(
      (candidate) =>
        candidate.record.invitee === join.member &&
        candidate.record.at <= join.at &&
        wasValidAt(candidate.record.inviter, candidate.record.at) &&
        wasValidAt(candidate.record.inviter, join.at),
    );
    if (invitation) open(join.member, join.at);
  }

  return { current, intervals };
}

interface LatestVote {
  vote: 'ban' | 'unban';
  at: number;
  id: string;
}

/**
 * Derive my subjective view. Inputs must already have passed merge
 * verification; this function is pure and synchronous so every browser can
 * recompute the same view from the same merged records.
 */
export function deriveMemberView(
  records: readonly StoredCircleRecord[],
  selfKey: PublicKeyId,
  friends: Friends,
  overrides: Readonly<Record<PublicKeyId, MemberOverride>> = {},
  config: CircleConfigInput | CircleConfig = {},
): MemberView {
  const resolved = resolveCircleConfig(config);
  const circle = resolveCircleMetadata(records, resolved.circleId);
  const directFriends = friends.directFriends();

  if (!circle) {
    const circleId = resolved.circleId ?? '';
    const view: MemberView = {
      circleId,
      name: '',
      timezone: 'UTC',
      selfKey,
      creator: null,
      members: [],
      banned: [],
      unconnectedToYou: [],
      shouldAcceptConnection: (candidateCircleId, peerKey) =>
        candidateCircleId === circleId && peerKey !== selfKey && false,
    };
    return view;
  }

  const chain = deriveChain(records, circle);
  const validMembers = new Set(chain.current);

  const overrideBanned = new Set<PublicKeyId>();
  for (const [target, override] of Object.entries(overrides)) {
    if (override === 'ban' && target !== selfKey && validMembers.has(target)) {
      overrideBanned.add(target);
    }
  }

  const eligibleVoters = [...validMembers]
    .filter(
      (member) =>
        member !== selfKey &&
        directFriends.has(member) &&
        !overrideBanned.has(member),
    )
    .sort(compareStrings);
  const friendCount = eligibleVoters.length;
  const voterSet = new Set(eligibleVoters);

  const latestVotes = new Map<string, LatestVote>();
  for (const entry of records) {
    const record = entry.record;
    if (record.type !== 'BanVote' || record.circleId !== circle.circleId) continue;
    if (record.at < circle.createdAt) continue;
    if (!voterSet.has(record.voter)) continue;
    if (!validMembers.has(record.target)) continue;
    if (!chain.intervals.get(record.voter)?.some(
      (interval) =>
        interval.start <= record.at &&
        (interval.end === null || interval.end > record.at),
    )) {
      continue;
    }

    const key = `${record.voter}\u0000${record.target}`;
    const previous = latestVotes.get(key);
    if (
      !previous ||
      record.at > previous.at ||
      (record.at === previous.at && compareStrings(entry.id, previous.id) > 0)
    ) {
      latestVotes.set(key, { vote: record.vote, at: record.at, id: entry.id });
    }
  }

  const thresholdBanned = new Set<PublicKeyId>();
  if (friendCount >= 2) {
    const required = resolved.banThreshold(friendCount);
    if (!Number.isSafeInteger(required) || required < 1) {
      throw new Error('banThreshold must return a positive integer');
    }
    const counts = new Map<PublicKeyId, number>();
    for (const [key, latest] of latestVotes) {
      if (latest.vote !== 'ban') continue;
      const target = key.slice(key.indexOf('\u0000') + 1);
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
    for (const [target, count] of counts) {
      if (
        target !== selfKey &&
        validMembers.has(target) &&
        overrides[target] !== 'keep' &&
        !overrideBanned.has(target) &&
        count >= required
      ) {
        thresholdBanned.add(target);
      }
    }
  }

  const banned = [...new Set([...overrideBanned, ...thresholdBanned])].sort(compareStrings);
  const bannedSet = new Set(banned);
  const members = [...validMembers]
    .filter((member) => !bannedSet.has(member))
    .sort(compareStrings);
  const memberSet = new Set(members);
  const unconnectedToYou = members.filter(
    (member) => member !== selfKey && !directFriends.has(member),
  );

  const view: MemberView = {
    circleId: circle.circleId,
    name: circle.name,
    timezone: circle.timezone,
    selfKey,
    creator: circle.creator,
    members,
    banned,
    unconnectedToYou,
    shouldAcceptConnection: (candidateCircleId, peerKey) =>
      candidateCircleId === circle.circleId &&
      peerKey !== selfKey &&
      memberSet.has(peerKey) &&
      !bannedSet.has(peerKey),
  };
  return view;
}

export function isMemberInView(view: MemberView, peerKey: PublicKeyId): boolean {
  return view.members.includes(peerKey);
}

export function isBannedInView(view: MemberView, peerKey: PublicKeyId): boolean {
  return view.banned.includes(peerKey);
}

/** True when a member was inside a valid chain at a particular instant. */
export function memberValidAt(
  records: readonly StoredCircleRecord[],
  circleId: CircleId,
  member: PublicKeyId,
  at: number,
): boolean {
  const circle = resolveCircleMetadata(records, circleId);
  if (!circle) return false;
  const chain = deriveChain(records, circle);
  return (chain.intervals.get(member) ?? []).some(
    (interval) => interval.start <= at && (interval.end === null || interval.end > at),
  );
}

/** Standalone form of the connection policy for callers that do not hold the view method. */
export function shouldAcceptConnection(
  view: MemberView,
  circleId: CircleId,
  peerKey: PublicKeyId,
): boolean {
  return view.shouldAcceptConnection(circleId, peerKey);
}
